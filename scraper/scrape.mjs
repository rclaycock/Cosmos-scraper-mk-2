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

// Tunables via env (safe defaults)
const MAX_SCROLLS   = Number(process.env.MAX_SCROLLS   || 160);   // max “screens”
const WAIT_BETWEEN  = Number(process.env.WAIT_BETWEEN  || 1000);  // ms between scrolls
const FIRST_IDLE    = Number(process.env.FIRST_IDLE    || 9000);  // initial wait
const STABLE_CHECKS = Number(process.env.STABLE_CHECKS || 6);     // stop after N stable heights

const MEDIA_RE = /\.(jpe?g|png|webp|gif|avif|mp4|webm|m4v|mov)(\?|$)/i;
const CDN_HOST_HINTS = ["cdn.cosmos.so", "cosmos.so", "images.prismic", "cloudfront", "googleusercontent"];

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

  // Make every observer think elements are visible (helps lazy loaders)
  await page.addInitScript(() => {
    const orig = window.IntersectionObserver;
    window.IntersectionObserver = class FakeIO {
      constructor(cb, opts) {
        this._cb = cb; this._opts = opts;
      }
      observe(el) { this._cb([{ isIntersecting: true, target: el, intersectionRatio: 1 }]); }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
    window.IntersectionObserverEntry = function(){};
    // Fallback for some libs checking for existence
    window.__IOPatched = true;
  });

  // Collect URLs we see on the network as well
  const netSet = new Set();
  page.on("response", async (res) => {
    try {
      const url = new URL(res.url());
      // media files directly
      if (MEDIA_RE.test(url.pathname)) netSet.add(url.origin + url.pathname);

      // parse JSON bodies for embedded media links
      const ct = res.headers()["content-type"] || "";
      if (ct.includes("application/json")) {
        const text = await res.text().catch(() => "");
        // quick-and-dirty crawl for URLs
        const urls = text.match(/https?:\/\/[^\s"']+/g) || [];
        for (const u of urls) {
          try {
            const uu = new URL(u);
            if (MEDIA_RE.test(uu.pathname)) netSet.add(uu.origin + uu.pathname);
            if (CDN_HOST_HINTS.some(h => uu.host.includes(h))) netSet.add(uu.origin + uu.pathname);
          } catch {}
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
        if (src) out.push({ type: "image", src });
      });
      // Videos
      document.querySelectorAll("video").forEach(v => {
        const s = v.currentSrc || v.src || (v.querySelector("source")?.src);
        if (s) out.push({ type: "video", src: s, poster: v.poster || null });
      });
      return out;
    });

    for (const it of batch) {
      try {
        const u = new URL(it.src, COSMOS_URL);
        const src = u.origin + u.pathname;
        if (MEDIA_RE.test(u.pathname) || CDN_HOST_HINTS.some(h => u.host.includes(h))) {
          found.set(src, { type: it.type, src, poster: it.poster || null });
        }
      } catch {
        // ignore malformed
      }
    }
    // Merge network-discovered too
    for (const u of netSet) found.set(u, { type: MEDIA_RE.test(u) && /\.(mp4|webm|m4v|mov)$/i.test(u) ? "video" : "image", src: u });
  }

  console.log("Scrolling + collecting…");
  let lastH = 0;
  let stable = 0;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    await collectFromDOM();
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.85));
    await page.waitForTimeout(WAIT_BETWEEN);

    // growth check
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastH) {
      stable++;
      if (stable >= STABLE_CHECKS) break;  // page stopped growing
    } else {
      stable = 0;
      lastH = h;
    }
    if ((i + 1) % 10 === 0) console.log(`…scroll ${i + 1}, items so far: ${found.size}`);
  }

  // final sweep
  await collectFromDOM();

  await browser.close();

  const items = uniqBySrc([...found.values()]);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ ok: true, source: COSMOS_URL, count: items.length, items }, null, 2));
  console.log(`✅ Saved ${items.length} items → ${OUT_FILE}`);
})();