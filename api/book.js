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
let initPromise = null;

async function ensureInit() {
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
  }

  // ── 搜索端点 ──────────────────────────────────────────
  app.get("/api/book", async (req, res) => {
    const query = req.query.q || req.query.title || "";
    if (!query) {
      return res
        .status(400)
        .json({ error: "Missing query. Usage: GET /api/book?q=book+name" });
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
}

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

// ── Gutendex (Project Gutenberg, 公版书) ──────────────────

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

// ── Open Library (Internet Archive) ──────────────────────

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

// ── Anna's Archive (影子图书馆索引) ──────────────────────

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
  await ensureInit();
  return new Promise((resolve) => {
    res.on("finish", resolve);
    app(req, res);
  });
}
