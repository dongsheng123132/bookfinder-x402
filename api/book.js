// BookFinder x402 — 图书搜索 API

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
  const url = `https://gutendex.com/books/?search=${encodeURIComponent(query)}`;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(6000) });
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
}

async function searchOpenLibrary(query) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5&fields=key,title,author_name,first_publish_year,isbn,cover_i,ia`;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(6000) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.docs || []).slice(0, 5).map((doc) => {
    const ia = doc.ia?.[0];
    return {
      source: "openlibrary",
      title: doc.title,
      authors: doc.author_name || [],
      year: doc.first_publish_year || null,
      isbn: doc.isbn?.[0] || null,
      openlibrary_url: `https://openlibrary.org${doc.key}`,
      downloads: {
        pdf: ia ? `https://archive.org/download/${ia}/${ia}.pdf` : null,
        epub: ia ? `https://archive.org/download/${ia}/${ia}.epub` : null,
        read_online: ia ? `https://archive.org/details/${ia}` : null,
      },
      cover: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
    };
  });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-REQUIREMENTS, X-PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
    return res.status(204).end();
  }

  const PAYMENT_ADDRESS = (process.env.PAYMENT_ADDRESS || "").trim();
  const NETWORK = (process.env.NETWORK || "eip155:84532").trim();
  const hasPaymentHeader = !!req.headers["x-payment"];

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
      const [
        { paymentMiddleware, x402ResourceServer },
        { ExactEvmScheme },
        { facilitator },
      ] = await Promise.all([
        import("@x402/express"),
        import("@x402/evm/exact/server"),
        import("@coinbase/x402"),
      ]);

      const server = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
      const mw = paymentMiddleware({
        "GET /api/book": {
          accepts: [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: PAYMENT_ADDRESS }],
          description: "Book search",
          mimeType: "application/json",
        },
      }, server);

      const passed = await new Promise((resolve) => {
        const origEnd = res.end;
        res.end = function (...args) {
          resolve(false);
          return origEnd.apply(res, args);
        };
        mw(req, res, () => resolve(true));
      });

      if (!passed) return;
    } catch (e) {
      return res.status(500).json({ error: "Payment verification failed", message: e.message });
    }
  }

  // 搜索
  const query = (req.query?.q || req.query?.title || "").trim();
  if (!query) {
    return res.status(400).json({ error: "Missing query. Usage: GET /api/book?q=book+name" });
  }

  const results = await searchBooks(query);
  return res.json(results);
}
