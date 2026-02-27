import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const WTJ_BASE = "https://wheresthejump.com";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const FETCH_TIMEOUT_MS = 12000;

function normalizeSpaces(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(id) };
}

function isValidWtjUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "wheresthejump.com";
  } catch {
    return false;
  }
}

async function fetchText(url, accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8") {
  const { controller, clear } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        Accept: accept,
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });

    const body = await resp.text().catch(() => "");
    return { ok: resp.ok, status: resp.status, text: body };
  } finally {
    clear();
  }
}

function normalizeToHHMMSS(raw) {
  const parts = String(raw).trim().split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;

  let hh = 0,
    mm = 0,
    ss = 0;

  if (parts.length === 2) {
    mm = Number(parts[0]);
    ss = Number(parts[1]);
  } else {
    hh = Number(parts[0]);
    mm = Number(parts[1]);
    ss = Number(parts[2]);
  }

  if ([hh, mm, ss].some(Number.isNaN) || mm > 59 || ss > 59 || hh > 99) return null;

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function extractTimesFromText(text) {
  const cleaned = normalizeSpaces(text);
  const matches = cleaned.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g) || [];

  const out = [];
  const seen = new Set();

  for (const m of matches) {
    const t = normalizeToHHMMSS(m);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function looksLikeCloudflareInterstitial(htmlOrText) {
  const t = String(htmlOrText || "").toLowerCase();
  return (
    t.includes("one moment, please") ||
    t.includes("checking your browser") ||
    t.includes("cloudflare") ||
    t.includes("attention required")
  );
}

// ---- Health ----
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", source: "wheresthejump" });
});

// ---- Search ---- (kept working)
app.get("/api/search", async (req, res) => {
  try {
    const q = normalizeSpaces(req.query.q);
    if (!q || q.length < 2) {
      return res.status(400).json({ error: "Missing or too-short query `q`." });
    }

    const searchUrl = `${WTJ_BASE}/?s=${encodeURIComponent(q)}`;
    const fetched = await fetchText(searchUrl);
    if (!fetched.ok) {
      return res.status(502).json({ error: `WTJ search failed: ${fetched.status}` });
    }

    const $ = cheerio.load(fetched.text);

    const results = [];
    const seen = new Set();

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      const full = href.startsWith("http") ? href : WTJ_BASE + href;

      if (!full.includes("/jump-scares-in-")) return;
      if (!isValidWtjUrl(full)) return;

      if (full.includes("/tag/") || full.includes("/category/") || full.includes("/?s=")) return;

      // Optional: filter out TV series bucket
      if (full.includes("jump-scares-in-tv-series")) return;

      if (seen.has(full)) return;
      seen.add(full);

      // Prefer anchor text; fallback to slug title
      let title = normalizeSpaces($(el).text());
      if (!title) {
        const slug = full.split("/").filter(Boolean).pop() || "";
        title = slug
          .replace(/^jump-scares-in-/, "")
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
      }

      results.push({ title, url: full });
    });

    res.json(results.slice(0, 10));
  } catch (e) {
    res.status(500).json({
      error: e?.name === "AbortError" ? "WTJ search timed out." : "Server error during search.",
    });
  }
});

// ---- Timestamps ----
// NEW: Use WP JSON API by slug to avoid Cloudflare interstitial HTML.
app.get("/api/timestamps", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!isValidWtjUrl(url)) {
      return res.status(400).json({ error: "Invalid WTJ url." });
    }

    const u = new URL(url);
    const slug = u.pathname.split("/").filter(Boolean).pop() || "";
    if (!slug) {
      return res.status(400).json({ error: "Could not determine slug from url." });
    }

    // 1) Try WP JSON API
    const wpUrl = `${WTJ_BASE}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=title,content`;
    const wpFetched = await fetchText(wpUrl, "application/json");

    if (wpFetched.ok) {
      try {
        const arr = JSON.parse(wpFetched.text);
        if (Array.isArray(arr) && arr.length > 0) {
          const post = arr[0];
          const title = normalizeSpaces(post?.title?.rendered) || slug;
          const contentHtml = String(post?.content?.rendered || "");
          const timestamps = extractTimesFromText(contentHtml);

          if (timestamps.length > 0) {
            return res.json({ url, title, timestamps });
          }
        }
      } catch {
        // fall through
      }
    }

    // 2) Fallback: scrape HTML (may be blocked)
    const fetched = await fetchText(url);
    if (!fetched.ok) {
      return res.status(502).json({ error: `WTJ page failed: ${fetched.status}` });
    }

    // If it's Cloudflare interstitial, surface a clearer error
    if (looksLikeCloudflareInterstitial(fetched.text)) {
      return res.status(502).json({ error: "WTJ blocked (Cloudflare interstitial). WP JSON API returned no timestamps." });
    }

    const $ = cheerio.load(fetched.text);
    const title =
      normalizeSpaces($("h1.entry-title").first().text()) ||
      normalizeSpaces($("title").text()) ||
      slug;

    const text = normalizeSpaces($(".entry-content").text() || $("body").text());
    const timestamps = extractTimesFromText(text);

    res.json({ url, title, timestamps });
  } catch (e) {
    res.status(500).json({
      error: e?.name === "AbortError" ? "WTJ timestamps timed out." : "Server error during timestamps.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`WTJ backend running on port ${PORT}`);
});
