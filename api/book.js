// ── 图书搜索 API (x402 付费) ──────────────────────────────

let x402Ready = false;
let x402Middleware = null;
let x402Error = null;

// 后台预加载 x402 (不阻塞请求)
async function loadX402() {
  const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS;
  const NETWORK = (process.env.NETWORK || "eip155:84532").trim();
  if (!PAYMENT_ADDRESS || x402Ready) return;

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

    const server = new x402ResourceServer(facilitator).register(
      NETWORK,
      new ExactEvmScheme()
    );

    x402Middleware = paymentMiddleware(
      {
        "GET /api/book": {
          accepts: [
            {
              scheme: "exact",
              price: "$0.01",
              network: NETWORK,
              payTo: PAYMENT_ADDRESS,
            },
          ],
          description: "Search book and get PDF download link — 0.01 USDC",
          mimeType: "application/json",
        },
      },
      server
    );
    x402Ready = true;
  } catch (e) {
    x402Error = e.message;
  }
}

// 立即开始后台加载
const loadPromise = loadX402();

// ── 图书搜索逻辑 ──────────────────────────────────────────

async function searchBooks(query) {
  const [gutendex, openlib, annasArchive] = await Promise.allSettled([
    searchGutendex(query),
    searchOpenLibrary(query),
    searchAnnasArchive(query),
  ]);

  const books = [];
  if (gutendex.status === "fulfilled") books.push(...gutendex.value);
  if (openlib.status === "fulfilled") books.push(...openlib.value);
  if (annasArchive.status === "fulfilled") books.push(...annasArchive.value);

  return { query, total: books.length, books: books.slice(0, 15) };
}

async function searchGutendex(query) {
  const url = `https://gutendex.com/books/?search=${encodeURIComponent(query)}`;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000) });
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
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000) });
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

async function searchAnnasArchive(query) {
  try {
    const url = `https://annas-archive.org/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const results = [];
    const md5Regex = /href="(\/md5\/[a-f0-9]+)"/gi;
    let m;
    while ((m = md5Regex.exec(html)) !== null && results.length < 5) {
      results.push({
        source: "annas-archive",
        title: query,
        url: `https://annas-archive.org${m[1]}`,
        downloads: { page: `https://annas-archive.org${m[1]}` },
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ── Vercel handler ────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-REQUIREMENTS, X-PAYMENT-RESPONSE");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-PAYMENT");
    return res.status(204).end();
  }

  // 如果 x402 已加载, 走 x402 中间件验证支付
  if (x402Ready && x402Middleware) {
    return new Promise((resolve) => {
      // 创建一个包含 route handler 的 mini express chain
      const next = async () => {
        // x402 验证通过, 执行搜索
        await doSearch(req, res);
        resolve();
      };
      x402Middleware(req, res, next);
    });
  }

  // x402 还没加载完 或 没配置, 直接执行搜索 (用于预热/免费模式)
  await doSearch(req, res);
}

async function doSearch(req, res) {
  const query = (req.query?.q || req.query?.title || "").trim();
  if (!query) {
    return res.status(400).json({
      error: "Missing query. Usage: GET /api/book?q=book+name",
      x402_status: x402Ready ? "ready" : x402Error ? `error: ${x402Error}` : "loading...",
    });
  }

  try {
    const results = await searchBooks(query);
    results.x402_status = x402Ready ? "ready" : x402Error ? `error: ${x402Error}` : "loading...";
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: "Search failed", message: err.message });
  }
}
