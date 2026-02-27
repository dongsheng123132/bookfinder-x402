# BookFinder x402

> Search any book by name, get PDF/EPUB download links. Pay 0.01 USDC per search.

## Quick Start (AI Agents)

```bash
npx awal@latest x402 pay https://YOUR_DOMAIN/api/book?q=python+programming -X GET
```

## API

| Method | Endpoint | Auth | Price | Description |
|--------|----------|------|-------|-------------|
| GET | `/api/book?q=<query>` | x402 | $0.01 USDC | Search books, return PDF download links |
| GET | `/` | none | free | Service info |

## Request

```
GET /api/book?q=pride+and+prejudice
```

## Response

```json
{
  "query": "pride and prejudice",
  "total": 8,
  "books": [
    {
      "source": "gutenberg",
      "title": "Pride and Prejudice",
      "authors": ["Austen, Jane"],
      "downloads": {
        "pdf": "https://www.gutenberg.org/files/1342/1342-0.pdf",
        "epub": "https://www.gutenberg.org/ebooks/1342.epub3.images",
        "html": "https://www.gutenberg.org/files/1342/1342-h/1342-h.htm"
      }
    },
    {
      "source": "openlibrary",
      "title": "Pride and Prejudice",
      "authors": ["Jane Austen"],
      "year": 1813,
      "isbn": "9780141439518",
      "downloads": {
        "pdf": "https://archive.org/download/prideandprejudice/prideandprejudice.pdf",
        "read_online": "https://archive.org/details/prideandprejudice"
      }
    },
    {
      "source": "annas-archive",
      "title": "Pride and Prejudice",
      "url": "https://annas-archive.org/md5/...",
      "downloads": {
        "page": "https://annas-archive.org/md5/..."
      }
    }
  ]
}
```

## Data Sources

- **Project Gutenberg** (70,000+ public domain books) — direct PDF/EPUB download
- **Open Library** (millions of books) — Internet Archive downloads
- **Anna's Archive** (shadow library index) — search results with links

## Payment

- **Price**: 0.01 USDC per search
- **Network**: Base Sepolia (testnet) or Base Mainnet
- **Protocol**: x402 (HTTP 402 Payment Required)

## For AI Agents

```bash
npx awal@latest x402 pay https://YOUR_DOMAIN/api/book?q=machine+learning -X GET
```
