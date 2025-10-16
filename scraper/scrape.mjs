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
const CDN_HOST_ALLOW = ["cdn.cosmos.so", "files.cosmos.so", "images.prismic", "cloudfront", "googleusercontent"];

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
    return u.origin + u.pathname; // strip query params to dedupe CDN variants
  } catch {
    return null;
  }
}

function allowByHostAndExt(urlStr) {
  try {
    const u = new URL(urlStr);
    const hostOk = CDN_HOST_ALLOW.some(h => u.host.includes(h));
    const extOk  = MEDIA_EXT_RE.test(u.pathname);
    // Prefer both true, but if ext matches we keep it even on other CDNs
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

  const found = new Map();

  async function collectFromDOM() {
    const batch = await page.evaluate(() => {
      const out = [];
      // Images
      document.querySelectorAll("img").forEach(img => {
        const src = img.currentSrc || img.src || img.getAttribute("src");
        if (src) out.push({ type: "image", src, poster: null });
      });
      // Videos
      document.querySelectorAll("video").forEach(v => {
        const s = v.currentSrc || v.src || (v.querySelector("source")?.src);
        if (s) out.push({ type: "video", src: s, poster: v.poster || null });
      });
      return out;
    });

    for (const it of batch) {
      if (isExcluded(it.src)) continue;
      const norm = normaliseURL(it.src);
      if (!norm) continue;
      if (!allowByHostAndExt(norm)) continue;

      const isVideo = VIDEO_EXT_RE.test(norm);
      found.set(norm, { type: isVideo ? "video" : "image", src: norm, poster: it.poster || null });
    }

    // Merge any network-discovered URLs too
    for (const u of netFound) {
      if (isExcluded(u)) continue;
      if (!allowByHostAndExt(u)) continue;
      const isVideo = VIDEO_EXT_RE.test(u);
      if (!found.has(u)) found.set(u, { type: isVideo ? "video" : "image", src: u, poster: null });
    }
  }

  console.log("Scrolling + collecting…");
  let lastH = 0;
  let stable = 0;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    await collectFromDOM();

    // Simulate user scroll
    await page.mouse.wheel(0, Math.floor((await page.evaluate(() => window.innerHeight)) * 0.85));
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

    if ((i + 1) % 10 === 0) console.log(`…scroll ${i + 1}, items so far: ${found.size}`);
  }

  // Final sweep
  await collectFromDOM();

  await browser.close();

  const items = uniqBySrc([...found.values()]);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ ok: true, source: COSMOS_URL, count: items.length, items }, null, 2)
  );
  console.log(`✅ Saved ${items.length} items → ${OUT_FILE}`);
})();
