export default function handler(req, res) {
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = `${proto}://${host}`;

  res.json({
    service: "BookFinder x402",
    description: "Pay 0.01 USDC, get book PDF download links",
    endpoint: `GET ${base}/api/book?q=book+name`,
    price: "0.01 USDC",
    network: process.env.NETWORK || "eip155:84532",
    skill: `${base}/skill.md`,
    examples: [
      `${base}/api/book?q=python+programming`,
      `${base}/api/book?q=pride+and+prejudice`,
      `${base}/api/book?q=machine+learning`,
    ],
    ai_agent_command: `npx awal@latest x402 pay ${base}/api/book?q=YOUR_QUERY -X GET`,
  });
}
