// scraper/scrape.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COSMOS_URL = process.env.COSMOS_URL || "https://www.cosmos.so/rlphoto/swim";
const OUT_DIR = path.resolve(__dirname, "../public");
const OUT_FILE = process.env.OUT_FILE
  ? path.resolve(process.env.OUT_FILE)
  : path.join(OUT_DIR, "gallery.json");

// Tunables via env
const MAX_SCROLLS   = Number(process.env.MAX_SCROLLS   || 200);
const WAIT_BETWEEN  = Number(process.env.WAIT_BETWEEN  || 1000);
const FIRST_IDLE    = Number(process.env.FIRST_IDLE    || 9000);
const STABLE_CHECKS = Number(process.env.STABLE_CHECKS || 6);

// Media patterns and hosts
const MEDIA_EXT_RE = /\.(jpe?g|png|webp|gif|avif|mp4|webm|m4v|mov|heic)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|webm|m4v|mov)(\?|$)/i;
const CDN_HOST_ALLOW = [
  "cdn.cosmos.so",
  "files.cosmos.so",
  "images.prismic",
  "cloudfront",
  "googleusercontent"
];

// Exclude obvious non-gallery assets (avatars, favicons, Next.js bundles, base64, etc)
function isExcluded(src) {
  return (
    !src ||
    src.startsWith("data:") ||
    src.includes("default-avatars") ||
    src.includes("/_next/") ||
    src.includes("favicon") ||
    src.includes("cosmos.so/api/avatar")
  );
}

function normaliseURL(src, base = COSMOS_URL) {
  try {
    const u = new URL(src, base);
    // Strip query to dedupe CDN variants (keeps file extension)
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

function allowByHostAndExt(urlStr) {
  try {
    const u = new URL(urlStr);
    const hostOk = CDN_HOST_ALLOW.some(h => u.host.includes(h));
    const extOk  = MEDIA_EXT_RE.test(u.pathname);
    // Prefer ext match; host allowlist is a fallback
    return extOk || hostOk;
  } catch {
    return false;
  }
}

function uniqBySrc(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = `${it.type}:${it.src}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 3840, height: 2160 },
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  });
  const page = await context.newPage();

  // Force lazy loaders to treat elements as visible
  await page.addInitScript(() => {
    const OrigIO = window.IntersectionObserver;
    window.IntersectionObserver = class FakeIO {
      constructor(cb, opts){ this._cb = cb; this._opts = opts; }
      observe(el){ try { this._cb([{ isIntersecting: true, target: el, intersectionRatio: 1 }]); } catch {} }
      unobserve() {}
      disconnect() {}
      takeRecords(){ return []; }
    };
    window.IntersectionObserverEntry = function(){};
    window.__IOPatched = true;
  });

  // Capture media-like URLs seen on the network
  const netFound = new Set();
  page.on("response", async (res) => {
    try {
      const url = res.url();
      const norm = normaliseURL(url);
      if (!norm || isExcluded(norm)) return;

      // Direct media files
      if (MEDIA_EXT_RE.test(norm)) {
        netFound.add(norm);
        return;
      }

      // Parse JSON responses for embedded URLs
      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (ct.includes("application/json")) {
        const text = await res.text().catch(() => "");
        const urls = text.match(/https?:\/\/[^\s"'\\)]+/g) || [];
        for (const u of urls) {
          const n = normaliseURL(u);
          if (!n || isExcluded(n)) continue;
          if (allowByHostAndExt(n)) netFound.add(n);
        }
      }
    } catch {}
  });

  console.log(`Navigating to ${COSMOS_URL}`);
  await page.goto(COSMOS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(FIRST_IDLE);

  // EXTRA: force one full scroll after initial idle to kick lazy image mounts
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);

  // Stores *positional* records from DOM; we’ll sort by top/left at the end.
  let positional = [];

  // Also keep a map of any extras discovered via network that weren’t visible
  const foundMap = new Map();

  function mergeNetworkToMap() {
    for (const u of netFound) {
      if (isExcluded(u)) continue;
      if (!allowByHostAndExt(u)) continue;
      const isVideo = VIDEO_EXT_RE.test(u);
      if (!foundMap.has(u)) {
        foundMap.set(u, { type: isVideo ? "video" : "image", src: u });
      }
    }
  }

  async function collectFromDOM() {
    const batch = await page.evaluate(() => {
      const SKIP = /cdn\.cosmos\.so\/default-avatars\//i;

      // Prefer the gallery root if we can spot it; otherwise scan the document.
      const root =
        document.querySelector('[data-testid="masonry"]') ||
        document.querySelector('[class*="masonry"]') ||
        document.querySelector("main") ||
        document.body;

      function pickBestFromSrcset(img) {
        try {
          if (img.currentSrc) return img.currentSrc;
          const ss = img.getAttribute("srcset");
          if (!ss) return img.getAttribute("src") || "";
          const parts = ss.split(",").map(s => s.trim());
          const candidates = parts.map(p => {
            const [url, size] = p.split(/\s+/);
            const w = size?.endsWith("w") ? parseInt(size, 10) : 0;
            return { url, w: isNaN(w) ? 0 : w };
          }).sort((a, b) => b.w - a.w);
          return (candidates[0]?.url) || img.getAttribute("src") || "";
        } catch { return img.getAttribute("src") || ""; }
      }

      const out = [];

      // IMAGES
      root.querySelectorAll("img").forEach(img => {
        const rect = img.getBoundingClientRect();
        const src = pickBestFromSrcset(img);
        if (!src || SKIP.test(src)) return;

        out.push({
          type: "image",
          src,
          poster: null,
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX
        });
      });

      // VIDEOS (native)
      root.querySelectorAll("video").forEach(v => {
        const rect = v.getBoundingClientRect();
        const s = v.currentSrc || v.src || (v.querySelector("source")?.src) || "";
        if (!s || SKIP.test(s)) return;

        out.push({
          type: "video",
          src: s,
          poster: v.poster || null,
          width: v.videoWidth || 0,
          height: v.videoHeight || 0,
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX
        });
      });

      // VIDEOS (player iframes, fallback)
      root.querySelectorAll("iframe").forEach(f => {
        const rect = f.getBoundingClientRect();
        const s = f.src || "";
        if (!s || SKIP.test(s)) return;
        if (!/vimeo\.com|player|video|mp4|webm/i.test(s)) return;

        out.push({
          type: "video",
          src: s,
          poster: null,
          width: 0,
          height: 0,
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX
        });
      });

      return out;
    });

    // Client-side filtering + normalisation
    for (const it of batch) {
      const norm = normaliseURL(it.src, COSMOS_URL);
      if (!norm) continue;
      if (isExcluded(norm)) continue;
      if (!allowByHostAndExt(norm)) continue;

      positional.push({
        type: VIDEO_EXT_RE.test(norm) ? "video" : it.type,
        src: norm,
        poster: it.poster || undefined,
        width: it.width || 0,
        height: it.height || 0,
        top: it.top,
        left: it.left
      });

      // Track in the map so network-only assets can be merged later if needed
      if (!foundMap.has(norm)) {
        foundMap.set(norm, { type: VIDEO_EXT_RE.test(norm) ? "video" : it.type, src: norm });
      }
    }

    // Add anything seen on the network
    mergeNetworkToMap();
  }

  console.log("Scrolling + collecting…");
  let lastH = 0;
  let stable = 0;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    await collectFromDOM();

    // Simulate user scroll
    const innerH = await page.evaluate(() => window.innerHeight);
    await page.mouse.wheel(0, Math.floor(innerH * 0.9));
    await page.waitForTimeout(WAIT_BETWEEN);

    // Stop when page stops growing for a bit
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastH) {
      stable++;
      if (stable >= STABLE_CHECKS) break;
    } else {
      stable = 0;
      lastH = h;
    }

    if ((i + 1) % 10 === 0) {
      console.log(`…scroll ${i + 1}, DOM items so far: ${positional.length}, net: ${netFound.size}`);
    }
  }

  // Final sweep after idle
  await collectFromDOM();

  await browser.close();

  // Sort *visually* by what the user actually sees
  positional.sort((a, b) => (a.top - b.top) || (a.left - b.left));

  // Dedup while keeping first occurrence (visual order)
  const ordered = [];
  const seen = new Set();
  for (const it of positional) {
    const key = `${it.type}:${it.src}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push({
      type: it.type,
      src: it.src,
      width: it.width || 0,
      height: it.height || 0,
      ...(it.poster ? { poster: it.poster } : {})
    });
  }

  // Optional: append any network-only assets that never appeared on screen (rare)
  // Keep them *after* visible items so we don’t disturb the visual order.
  for (const { src, type } of foundMap.values()) {
    const key = `${type}:${src}`;
    if (seen.has(key)) continue;
    ordered.push({ type, src, width: 0, height: 0 });
    seen.add(key);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ ok: true, source: COSMOS_URL, count: ordered.length, items: ordered }, null, 2)
  );
  console.log(`✅ Saved ${ordered.length} items (visual order) → ${OUT_FILE}`);
})();
