// BookFinder x402 — 图书搜索 API

function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function searchBooks(query) {
  const [gutendex, openlib] = await Promise.allSettled([
    searchGutendex(query),
    searchOpenLibrary(query),
  ]);
  const books = [];
  if (gutendex.status === "fulfilled") books.push(...gutendex.value);
  if (openlib.status === "fulfilled") books.push(...openlib.value);
  return { query, total: books.length, books: books.slice(0, 10) };
}

async function searchGutendex(query) {
  try {
    const url = `https://gutendex.com/books/?search=${encodeURIComponent(query)}`;
    const res = await fetch(url, { redirect: "follow", signal: timeoutSignal(6000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).slice(0, 5).map((book) => {
      const f = book.formats || {};
      return {
        source: "gutenberg",
        title: book.title,
        authors: (book.authors || []).map((a) => a.name),
        languages: book.languages,
        downloads: {
          pdf: f["application/pdf"] || null,
          epub: f["application/epub+zip"] || null,
          html: f["text/html"] || f["text/html; charset=utf-8"] || null,
          text: f["text/plain"] || f["text/plain; charset=utf-8"] || f["text/plain; charset=us-ascii"] || null,
        },
        cover: f["image/jpeg"] || null,
      };
    });
  } catch (e) { return []; }
}

async function searchOpenLibrary(query) {
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5&fields=key,title,author_name,first_publish_year,isbn,cover_i,ia`;
    const res = await fetch(url, { redirect: "follow", signal: timeoutSignal(6000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.docs || []).slice(0, 5).map((doc) => {
      const ia = doc.ia ? doc.ia[0] : undefined;
      return {
        source: "openlibrary",
        title: doc.title,
        authors: doc.author_name || [],
        year: doc.first_publish_year || null,
        isbn: (doc.isbn && doc.isbn[0]) || null,
        openlibrary_url: "https://openlibrary.org" + doc.key,
        downloads: {
          pdf: ia ? "https://archive.org/download/" + ia + "/" + ia + ".pdf" : null,
          epub: ia ? "https://archive.org/download/" + ia + "/" + ia + ".epub" : null,
          read_online: ia ? "https://archive.org/details/" + ia : null,
        },
        cover: doc.cover_i ? "https://covers.openlibrary.org/b/id/" + doc.cover_i + "-M.jpg" : null,
      };
    });
  } catch (e) { return []; }
}

export default async function handler(req, res) {
  try { return await _handler(req, res); }
  catch (e) { return res.status(500).json({ error: e.message, stack: e.stack }); }
}

async function _handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-REQUIREMENTS, X-PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
    return res.status(204).end();
  }

  var PAYMENT_ADDRESS = (process.env.PAYMENT_ADDRESS || "").trim();
  var NETWORK = (process.env.NETWORK || "eip155:84532").trim();
  var hasPaymentHeader = !!(req.headers["x-payment"]);

  // 没有支付头 + 配置了收款地址 → 返回 402
  if (PAYMENT_ADDRESS && !hasPaymentHeader) {
    res.setHeader("X-PAYMENT-REQUIREMENTS", JSON.stringify({
      accepts: [{
        scheme: "exact",
        price: "$0.01",
        network: NETWORK,
        payTo: PAYMENT_ADDRESS,
      }],
      description: "Search book and get PDF download link — 0.01 USDC",
      mimeType: "application/json",
    }));
    return res.status(402).json({
      error: "Payment Required",
      price: "$0.01 USDC",
      network: NETWORK,
      payTo: PAYMENT_ADDRESS,
      how: "npx awal@latest x402 pay <this-url> -X GET",
    });
  }

  // 有支付头 → 验证支付 (懒加载 x402)
  if (PAYMENT_ADDRESS && hasPaymentHeader) {
    try {
      var x402Express = await import("@x402/express");
      var x402Evm = await import("@x402/evm/exact/server");
      var x402Coinbase = await import("@coinbase/x402");

      var server = new x402Express.x402ResourceServer(x402Coinbase.facilitator)
        .register(NETWORK, new x402Evm.ExactEvmScheme());

      var mw = x402Express.paymentMiddleware({
        "GET /api/book": {
          accepts: [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: PAYMENT_ADDRESS }],
          description: "Book search",
          mimeType: "application/json",
        },
      }, server);

      var passed = await new Promise(function(resolve) {
        mw(req, res, function() { resolve(true); });
        res.on("finish", function() { resolve(false); });
      });

      if (!passed) return;
    } catch (e) {
      return res.status(500).json({ error: "Payment verification failed", message: e.message });
    }
  }

  // 搜索
  var query = "";
  if (req.query && req.query.q) query = req.query.q.trim();
  else if (req.query && req.query.title) query = req.query.title.trim();

  if (!query) {
    return res.status(400).json({ error: "Missing query. Usage: GET /api/book?q=book+name" });
  }

  try {
    var results = await searchBooks(query);
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: "Search failed", message: err.message });
  }
}
