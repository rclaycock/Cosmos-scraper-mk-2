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
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS || 200);
const WAIT_BETWEEN = Number(process.env.WAIT_BETWEEN || 1000);
const FIRST_IDLE = Number(process.env.FIRST_IDLE || 9000);
const STABLE_CHECKS = Number(process.env.STABLE_CHECKS || 6);

// Media patterns
const IMG_EXT_RE = /\.(jpe?g|png|webp|gif|avif|heic)(\?|$)/i;
const VID_EXT_RE = /\.(mp4|webm|m4v|mov)(\?|$)/i;

// Exclude obvious non-gallery assets
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
    // strip query/fragment to dedupe CDN variants
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

function muxPlaybackIdFromThumb(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.host.toLowerCase() !== "image.mux.com") return null;
    const parts = u.pathname.split("/").filter(Boolean); // [playbackId, "thumbnail.png"]
    if (parts.length >= 2 && parts[1].toLowerCase() === "thumbnail.png") return parts[0];
    return null;
  } catch {
    return null;
  }
}

function muxPlaybackIdFromStream(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.host.toLowerCase() !== "stream.mux.com") return null;
    const parts = u.pathname.split("/").filter(Boolean); // [playbackId, "low.mp4"]
    return parts[0] || null;
  } catch {
    return null;
  }
}

function upgradeMuxToHigh(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.host.toLowerCase() !== "stream.mux.com") return urlStr;
    const parts = u.pathname.split("/").filter(Boolean);
    if (!parts.length) return urlStr;
    // force /high.mp4
    parts[1] = "high.mp4";
    u.pathname = "/" + parts.join("/");
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return urlStr;
  }
}

function inferTypeFromUrl(urlStr) {
  if (VID_EXT_RE.test(urlStr)) return "video";
  if (IMG_EXT_RE.test(urlStr)) return "image";
  // default fallback
  return "image";
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  });
  const page = await context.newPage();

  // Make lazy loaders more eager
  await page.addInitScript(() => {
    const OrigIO = window.IntersectionObserver;
    window.IntersectionObserver = class FakeIO {
      constructor(cb) { this._cb = cb; }
      observe(el) {
        try {
          this._cb([{ isIntersecting: true, target: el, intersectionRatio: 1 }]);
        } catch {}
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
    window.IntersectionObserverEntry = function () {};
    window.__IOPatched = true;
  });

  console.log(`Navigating to ${COSMOS_URL}`);
  await page.goto(COSMOS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(FIRST_IDLE);

  // Ordered list of card keys (first-seen order)
  const order = [];
  // Map of cardKey -> final item
  const byCard = new Map();
  // Dedupe across truly identical media (safety)
  const seenMediaKeys = new Set();

  function mediaKey(item) {
    // Prefer stable video key for mux
    if (item.type === "video") {
      const pid = muxPlaybackIdFromStream(item.src);
      if (pid) return `video:mux:${pid}`;
    }
    return `${item.type}:${item.src}`;
  }

  async function collectFromDOM() {
    const batch = await page.evaluate(() => {
      function pickBestFromSrcset(img) {
        try {
          if (img.currentSrc) return img.currentSrc;
          const ss = img.getAttribute("srcset");
          if (!ss) return img.getAttribute("src") || "";
          const parts = ss.split(",").map(s => s.trim());
          const candidates = parts
            .map(p => {
              const [url, size] = p.split(/\s+/);
              const w = size?.endsWith("w") ? parseInt(size, 10) : 0;
              return { url, w: Number.isFinite(w) ? w : 0 };
            })
            .sort((a, b) => b.w - a.w);
          return candidates[0]?.url || img.getAttribute("src") || "";
        } catch {
          return img.getAttribute("src") || "";
        }
      }

      const root =
        document.querySelector('[data-testid="masonry"]') ||
        document.querySelector('[class*="masonry"]') ||
        document.querySelector("main") ||
        document.body;

      // Build a list of “cards” in DOM order.
      // Cosmos generally uses links for cards, so we take anchors that contain media.
      const anchors = Array.from(root.querySelectorAll("a"))
        .filter(a => a.querySelector("img, video"));

      const out = [];

      for (const a of anchors) {
        const href = a.href || "";
        const img = a.querySelector("img");
        const vid = a.querySelector("video");

        if (vid) {
          const src =
            vid.currentSrc ||
            vid.src ||
            (vid.querySelector("source")?.src) ||
            "";
          out.push({
            cardKey: href || src || Math.random().toString(36).slice(2),
            src,
            poster: vid.poster || null,
            kind: "video",
          });
          continue;
        }

        if (img) {
          const src = pickBestFromSrcset(img) || img.src || "";
          out.push({
            cardKey: href || src || Math.random().toString(36).slice(2),
            src,
            poster: null,
            kind: "image",
          });
        }
      }

      return out;
    });

    for (const raw of batch) {
      if (!raw?.src) continue;

      const nsrc0 = normaliseURL(raw.src, COSMOS_URL);
      if (!nsrc0 || isExcluded(nsrc0)) continue;

      // If it is a Mux thumbnail, treat it as a video poster, not a standalone image.
      const muxThumbPid = muxPlaybackIdFromThumb(nsrc0);
      if (muxThumbPid) {
        const videoSrc = `https://stream.mux.com/${muxThumbPid}/high.mp4`;
        const item = {
          type: "video",
          src: normaliseURL(videoSrc) || videoSrc,
          poster: nsrc0,
          width: 0,
          height: 0,
        };

        const key = raw.cardKey || `mux:${muxThumbPid}`;
        if (!byCard.has(key)) order.push(key);

        // Only keep one media per card, mux video wins
        byCard.set(key, item);
        continue;
      }

      // Normal media flow
      let finalSrc = nsrc0;
      let type = (raw.kind || inferTypeFromUrl(finalSrc)).toLowerCase();

      // If Mux stream video, upgrade low -> high
      if (type === "video") {
        const pid = muxPlaybackIdFromStream(finalSrc);
        if (pid) {
          finalSrc = upgradeMuxToHigh(`https://stream.mux.com/${pid}/low.mp4`);
          finalSrc = normaliseURL(finalSrc) || finalSrc;
        }
      }

      const item = {
        type: type === "video" ? "video" : "image",
        src: finalSrc,
        width: 0,
        height: 0,
        ...(raw.poster ? { poster: normaliseURL(raw.poster) || raw.poster } : {}),
      };

      // Primary dedupe by card key
      const cardKey = raw.cardKey || `${item.type}:${item.src}`;
      if (!byCard.has(cardKey)) order.push(cardKey);

      // Secondary dedupe by media key, but only if this card has no item yet
      const mk = mediaKey(item);
      if (seenMediaKeys.has(mk) && !byCard.has(cardKey)) continue;
      seenMediaKeys.add(mk);

      byCard.set(cardKey, item);
    }
  }

  console.log("Scrolling + collecting (DOM order)…");
  let lastH = 0;
  let stable = 0;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    await collectFromDOM();

    const innerH = await page.evaluate(() => window.innerHeight);
    await page.mouse.wheel(0, Math.floor(innerH * 0.9));
    await page.waitForTimeout(WAIT_BETWEEN);

    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastH) {
      stable++;
      if (stable >= STABLE_CHECKS) break;
    } else {
      stable = 0;
      lastH = h;
    }

    if ((i + 1) % 10 === 0) {
      console.log(`…scroll ${i + 1}, cards: ${order.length}`);
    }
  }

  await collectFromDOM();
  await browser.close();

  // Produce final ordered list
  const items = [];
  const finalSeen = new Set();
  for (const k of order) {
    const it = byCard.get(k);
    if (!it?.src) continue;

    const mk = mediaKey(it);
    if (finalSeen.has(mk)) continue;
    finalSeen.add(mk);

    items.push(it);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ ok: true, source: COSMOS_URL, count: items.length, items }, null, 2)
  );
  console.log(`✅ Saved ${items.length} items → ${OUT_FILE}`);
})();
