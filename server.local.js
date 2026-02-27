import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: "*",
    exposedHeaders: [
      "x-payment-response",
      "X-PAYMENT-RESPONSE",
      "x-payment-requirements",
      "X-PAYMENT-REQUIREMENTS",
    ],
  })
);

// ── x402 懒加载 ──────────────────────────────────────────
let initDone = false;
let initPromise = null;

async function ensureInit() {
  if (initDone) return;
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit() {
  const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS;
  const NETWORK = process.env.NETWORK || "eip155:84532";

  if (PAYMENT_ADDRESS) {
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

    app.use(
      paymentMiddleware(
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
      )
    );

    console.log(`x402 payment enabled: $0.01 USDC → ${PAYMENT_ADDRESS}`);
  } else {
    console.log("⚠ No PAYMENT_ADDRESS set — running in FREE mode (no x402)");
  }

  // ── 搜索端点 ──────────────────────────────────────────
  app.get("/api/book", async (req, res) => {
    const query = req.query.q || req.query.title || "";
    if (!query) {
      return res
        .status(400)
        .json({ error: 'Missing query. Usage: GET /api/book?q=book+name' });
    }

    try {
      const results = await searchBooks(query);
      return res.json(results);
    } catch (err) {
      return res
        .status(500)
        .json({ error: "Search failed", message: err.message });
    }
  });

  // ── 首页 / 健康检查 ────────────────────────────────────
  app.get("/", (_req, res) => {
    res.json({
      service: "BookFinder x402",
      description: "Pay 0.01 USDC, get book PDF download links",
      endpoint: "GET /api/book?q=book+name",
      price: "0.01 USDC",
      network: NETWORK,
      payment: PAYMENT_ADDRESS ? "enabled" : "free (no wallet set)",
      examples: [
        "/api/book?q=python",
        "/api/book?q=erta+kivikas+nimed+marmortahvlil",
        "/api/book?q=pride+and+prejudice",
      ],
    });
  });

  initDone = true;
}

// ── 图书搜索逻辑 ──────────────────────────────────────────

async function searchBooks(query) {
  // 并行搜索多个数据源
  const [gutendex, openlib, annasArchive] = await Promise.allSettled([
    searchGutendex(query),
    searchOpenLibrary(query),
    searchAnnasArchive(query),
  ]);

  const books = [];

  if (gutendex.status === "fulfilled") books.push(...gutendex.value);
  if (openlib.status === "fulfilled") books.push(...openlib.value);
  if (annasArchive.status === "fulfilled") books.push(...annasArchive.value);

  return {
    query,
    total: books.length,
    books: books.slice(0, 15),
  };
}

// ── 数据源 1: Gutendex (Project Gutenberg 公版书, 直接下载) ──

async function searchGutendex(query) {
  const url = `https://gutendex.com/books/?search=${encodeURIComponent(query)}`;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  const data = await res.json();

  return (data.results || []).slice(0, 5).map((book) => {
    const f = book.formats || {};
    return {
      source: "gutenberg",
      title: book.title,
      authors: (book.authors || []).map((a) => a.name),
      languages: book.languages,
      downloads: pickDownloads(f),
      cover: f["image/jpeg"] || null,
    };
  });
}

function pickDownloads(formats) {
  return {
    pdf: formats["application/pdf"] || null,
    epub: formats["application/epub+zip"] || null,
    html:
      formats["text/html"] ||
      formats["text/html; charset=utf-8"] ||
      null,
    text:
      formats["text/plain"] ||
      formats["text/plain; charset=utf-8"] ||
      formats["text/plain; charset=us-ascii"] ||
      null,
  };
}

// ── 数据源 2: Open Library (更大目录, 部分可下载) ──────────

async function searchOpenLibrary(query) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(
    query
  )}&limit=5&fields=key,title,author_name,first_publish_year,isbn,cover_i,ia`;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10000) });
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
      cover: doc.cover_i
        ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
        : null,
    };
  });
}

// ── 数据源 3: Anna's Archive (影子图书馆搜索, 返回链接) ──────

async function searchAnnasArchive(query) {
  try {
    const url = `https://annas-archive.org/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();

    // 简单提取搜索结果
    const results = [];
    const regex =
      /<a[^>]+href="(\/md5\/[a-f0-9]+)"[^>]*>[\s\S]*?<h3[^>]*>(.*?)<\/h3>[\s\S]*?<div[^>]*class="[^"]*text-gray[^"]*"[^>]*>(.*?)<\/div>/gi;
    let match;
    while ((match = regex.exec(html)) !== null && results.length < 5) {
      const path = match[1];
      const title = match[2].replace(/<[^>]+>/g, "").trim();
      const meta = match[3].replace(/<[^>]+>/g, "").trim();
      if (title) {
        results.push({
          source: "annas-archive",
          title,
          meta,
          url: `https://annas-archive.org${path}`,
          downloads: {
            page: `https://annas-archive.org${path}`,
          },
        });
      }
    }

    // 备用: 如果正则没匹配到, 用更简单的方式提取 md5 链接
    if (results.length === 0) {
      const md5Regex = /href="(\/md5\/[a-f0-9]+)"/gi;
      let m;
      while ((m = md5Regex.exec(html)) !== null && results.length < 5) {
        results.push({
          source: "annas-archive",
          title: query,
          url: `https://annas-archive.org${m[1]}`,
          downloads: {
            page: `https://annas-archive.org${m[1]}`,
          },
        });
      }
    }

    return results;
  } catch {
    // Anna's Archive 可能不可用, 静默失败
    return [];
  }
}

// ── 启动 ──────────────────────────────────────────────────

const PORT = process.env.PORT || 4021;

ensureInit().then(() => {
  app.listen(PORT, () => {
    console.log(`\n📚 BookFinder x402 running at http://localhost:${PORT}`);
    console.log(`🔍 Try: http://localhost:${PORT}/api/book?q=python\n`);
  });
});
