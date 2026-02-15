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
app.get("/api/timestamps", async (req, res) => {
  try {
    const pageUrl = req.query.url;
    if (!pageUrl) return res.json([]);

    const { data } = await axios.get(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const $ = cheerio.load(data);

    const bodyText = $("body").text();

    // match HH:MM:SS
    const matches = bodyText.match(/\b\d{2}:\d{2}:\d{2}\b/g) || [];

    // dedupe + sort
    const unique = [...new Set(matches)].sort();

    res.json({
      count: unique.length,
      timestamps: unique,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to extract timestamps" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
