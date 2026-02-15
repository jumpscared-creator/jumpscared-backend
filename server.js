const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
app.use(cors());
app.get("/", (req, res) => {
  res.status(200).send("JumpScared backend is running ✅");
});


const PORT = process.env.PORT || 3000;

// health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// simple search using duckduckgo html results
app.get("/api/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.json([]);

    const searchUrl = `https://duckduckgo.com/html/?q=site:wheresthejump.com ${encodeURIComponent(query)} jump scares`;

    const { data } = await axios.get(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const $ = cheerio.load(data);

    let results = [];

    $("a.result__a").each((i, el) => {
      const title = $(el).text();
      const url = $(el).attr("href");

      if (url && url.includes("wheresthejump.com/jump-scares")) {
        results.push({
          title,
          url,
        });
      }
    });

    // limit to 5
    results = results.slice(0, 5);

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "search failed" });
  }
});

// extract timestamps
app.get("/api/search", async (req, res) => {
  try {
    const query = (req.query.q || "").trim();
    if (!query) return res.json([]);

    // 1) Prefer Where’sTheJump built-in search
    const wtjSearchUrl = `https://wheresthejump.com/?s=${encodeURIComponent(query)}`;

    const wtjResp = await axios.get(wtjSearchUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" },
      timeout: 15000,
    });

    let $ = cheerio.load(wtjResp.data);

    // WP search results: grab links that look like jump-scare pages
    let results = [];
    $("a").each((_, el) => {
      const title = ($(el).text() || "").trim();
      const url = $(el).attr("href") || "";
      if (
        url.includes("wheresthejump.com/jump-scares") &&
        !results.some(r => r.url === url)
      ) {
        results.push({ title: title || url, url });
      }
    });

    // Limit to 8
    results = results.slice(0, 8);
    if (results.length > 0) return res.json(results);

    // 2) Fallback: DuckDuckGo HTML (sometimes works, sometimes not)
    const ddgUrl = `https://html.duckduckgo.com/html/?q=site:wheresthejump.com%20${encodeURIComponent(
      query
    )}%20jump%20scares`;

    const ddgResp = await axios.get(ddgUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9" },
      timeout: 15000,
    });

    $ = cheerio.load(ddgResp.data);

    const ddgResults = [];
    $("a.result__a, a[data-testid='result-title-a']").each((i, el) => {
      if (i >= 8) return false;
      const title = $(el).text().trim();
      const url = $(el).attr("href");
      if (url && url.includes("wheresthejump.com/jump-scares")) {
        ddgResults.push({ title, url });
      }
    });

    return res.json(ddgResults);
  } catch (err) {
    console.error("SEARCH ERROR:", err?.message || err);
    return res.status(500).json({ error: "search failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
