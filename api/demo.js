// Demo search API (free, for web UI)

function timeoutSignal(ms) {
  var c = new AbortController();
  setTimeout(function() { c.abort(); }, ms);
  return c.signal;
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  var query = "";
  if (req.query && req.query.q) query = req.query.q.trim();
  if (!query) return res.status(400).json({ error: "Missing ?q=book+name" });

  var [gutendex, openlib] = await Promise.allSettled([
    searchGutendex(query),
    searchOpenLibrary(query),
  ]);

  var books = [];
  if (gutendex.status === "fulfilled") books.push.apply(books, gutendex.value);
  if (openlib.status === "fulfilled") books.push.apply(books, openlib.value);

  return res.json({ query: query, total: books.length, books: books.slice(0, 10) });
}
