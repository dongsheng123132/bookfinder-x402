// BookFinder x402 — AI Agent 图书搜索 API (x402 付费)
import express from "express";
import cors from "cors";

var app = express();
app.use(express.json());
app.use(cors({
  origin: "*",
  exposedHeaders: [
    "payment-required", "PAYMENT-REQUIRED",
    "payment-response", "PAYMENT-RESPONSE",
    "x-payment-requirements", "X-PAYMENT-REQUIREMENTS",
    "x-payment-response", "X-PAYMENT-RESPONSE",
  ],
}));

// ── x402 懒加载 ────────────────────────────────────────────
var initPromise = null;

async function ensureInit() {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit() {
  var PAYMENT_ADDRESS = (process.env.PAYMENT_ADDRESS || "").trim();
  var NETWORK = (process.env.NETWORK || "eip155:84532").trim();

  if (PAYMENT_ADDRESS) {
    var [
      x402Express,
      x402Evm,
      x402Core,
    ] = await Promise.all([
      import("@x402/express"),
      import("@x402/evm/exact/server"),
      import("@x402/core/server"),
    ]);

    var facilitatorUrl = NETWORK === "eip155:8453"
      ? "https://api.cdp.coinbase.com/platform/v2/x402"
      : "https://x402.org/facilitator";
    var facilitator = new x402Core.HTTPFacilitatorClient({ url: facilitatorUrl });

    var server = new x402Express.x402ResourceServer(facilitator)
      .register(NETWORK, new x402Evm.ExactEvmScheme());

    app.use(x402Express.paymentMiddleware({
      "GET /api/book": {
        accepts: [{
          scheme: "exact",
          price: "$0.01",
          network: NETWORK,
          payTo: PAYMENT_ADDRESS,
        }],
        description: "Search book and get PDF download link - 0.01 USDC",
        mimeType: "application/json",
      },
    }, server));
  }

  // ── 搜索端点 ─────────────────────────────────────────────
  app.get("/api/book", async function(req, res) {
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
  });
}

// ── 图书搜索逻辑 ──────────────────────────────────────────

function timeoutSignal(ms) {
  var c = new AbortController();
  setTimeout(function() { c.abort(); }, ms);
  return c.signal;
}

async function searchBooks(query) {
  var [gutendex, openlib] = await Promise.allSettled([
    searchGutendex(query),
    searchOpenLibrary(query),
  ]);
  var books = [];
  if (gutendex.status === "fulfilled") books.push.apply(books, gutendex.value);
  if (openlib.status === "fulfilled") books.push.apply(books, openlib.value);
  return { query: query, total: books.length, books: books.slice(0, 10) };
}

async function searchGutendex(query) {
  try {
    var url = "https://gutendex.com/books/?search=" + encodeURIComponent(query);
    var res = await fetch(url, { redirect: "follow", signal: timeoutSignal(6000) });
    if (!res.ok) return [];
    var data = await res.json();
    return (data.results || []).slice(0, 5).map(function(book) {
      var f = book.formats || {};
      return {
        source: "gutenberg",
        title: book.title,
        authors: (book.authors || []).map(function(a) { return a.name; }),
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
    var url = "https://openlibrary.org/search.json?q=" + encodeURIComponent(query) + "&limit=5&fields=key,title,author_name,first_publish_year,isbn,cover_i,ia";
    var res = await fetch(url, { redirect: "follow", signal: timeoutSignal(6000) });
    if (!res.ok) return [];
    var data = await res.json();
    return (data.docs || []).slice(0, 5).map(function(doc) {
      var ia = doc.ia ? doc.ia[0] : undefined;
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

// ── Vercel handler ────────────────────────────────────────

export default async function handler(req, res) {
  try {
    await ensureInit();
    return new Promise(function(resolve) {
      res.on("finish", resolve);
      app(req, res);
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
