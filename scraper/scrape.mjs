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
const MAX_SCROLLS = Number(process.env.MAX_SCROLLS || 260);
const WAIT_BETWEEN = Number(process.env.WAIT_BETWEEN || 900);
const FIRST_IDLE = Number(process.env.FIRST_IDLE || 7000);
const STABLE_CHECKS = Number(process.env.STABLE_CHECKS || 10);

// Prefer a fixed viewport so Cosmos layout is deterministic
const VIEWPORT_W = Number(process.env.VIEWPORT_W || 1600);
const VIEWPORT_H = Number(process.env.VIEWPORT_H || 900);

// Media patterns
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|heic)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|webm|m4v|mov)(\?|$)/i;

// Rules
const SKIP_AVATAR_RE = /cdn\.cosmos\.so\/default-avatars\//i;
const SKIP_NEXT_RE = /\/_next\//i;

// Mux helpers
const MUX_STREAM_HOST = "stream.mux.com";
const MUX_IMAGE_HOST = "image.mux.com";

function isExcludedUrl(u) {
  return (
    !u ||
    u.startsWith("data:") ||
    SKIP_AVATAR_RE.test(u) ||
    SKIP_NEXT_RE.test(u) ||
    u.includes("favicon")
  );
}

function normaliseURL(src, base = COSMOS_URL) {
  try {
    const u = new URL(src, base);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function muxPlaybackIdFromStream(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.host.toLowerCase() !== MUX_STREAM_HOST) return null;
    const seg = u.pathname.split("/").filter(Boolean);
    return seg[0] || null;
  } catch {
    return null;
  }
}

function muxPlaybackIdFromThumb(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.host.toLowerCase() !== MUX_IMAGE_HOST) return null;
    // /<playbackId>/thumbnail.png
    const seg = u.pathname.split("/").filter(Boolean);
    if (!seg[0]) return null;
    if (!/thumbnail\.png$/i.test(u.pathname)) return null;
    return seg[0];
  } catch {
    return null;
  }
}

function upgradeMuxLowToHigh(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.host.toLowerCase() !== MUX_STREAM_HOST) return urlStr;
    const seg = u.pathname.split("/").filter(Boolean);
    if (!seg.length) return urlStr;
    // seg[0] playbackId, seg[1] low.mp4/high.mp4
    if (seg[1] && /low\.mp4$/i.test(seg[1])) seg[1] = "high.mp4";
    u.pathname = "/" + seg.join("/");
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return urlStr;
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  });
  const page = await context.newPage();

  // Make lazy loaders think everything is visible
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
    window.IntersectionObserverEntry = function(){};
    window.__IOPatched = true;
  });

  console.log(`Navigating to ${COSMOS_URL}`);
  await page.goto(COSMOS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(FIRST_IDLE);

  // Keyed storage so we can keep everything even if Cosmos virtualises DOM nodes
  const itemsByKey = new Map(); // key -> item
  const seenMuxThumbPlaybackIds = new Set();

  async function collectVisibleTiles() {
    const batch = await page.evaluate(() => {
      const root =
        document.querySelector("main") ||
        document.querySelector("#__next") ||
        document.body;

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
              return { url, w: isNaN(w) ? 0 : w };
            })
            .sort((a, b) => b.w - a.w);
          return candidates[0]?.url || img.getAttribute("src") || "";
        } catch {
          return img.getAttribute("src") || "";
        }
      }

      // Find a stable “tile container” around a media element
      function findTile(el) {
        let node = el;
        for (let i = 0; i < 8 && node && node.parentElement; i++) {
          const r = node.getBoundingClientRect();
          if (r.width >= 80 && r.height >= 80) {
            const cs = getComputedStyle(node);
            const looksLikeTile =
              cs.position === "absolute" ||
              cs.position === "relative" ||
              (cs.transform && cs.transform !== "none") ||
              node.tagName === "A";
            if (looksLikeTile) return node;
          }
          node = node.parentElement;
        }
        return el.parentElement || el;
      }

      const out = [];

      // Prefer one record per tile container (not per media element)
      const media = Array.from(root.querySelectorAll("img, video"));
      const tileSet = new Set();

      for (const m of media) {
        const tile = findTile(m);
        tileSet.add(tile);
      }

      for (const tile of tileSet) {
        const rect = tile.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 80) continue;

        // Choose best media inside the tile:
        // 1) Mux/Cosmos mp4 from <video>/<source>
        // 2) if none, image from <img>
        let type = null;
        let src = "";
        let poster = "";

        const vids = Array.from(tile.querySelectorAll("video"));
        for (const v of vids) {
          const s =
            v.currentSrc ||
            v.src ||
            v.querySelector("source")?.src ||
            "";
          if (!s) continue;
          type = "video";
          src = s;
          poster = v.poster || "";
          // if we already have a mux stream, stop
          if (/stream\.mux\.com/i.test(src)) break;
        }

        if (!src) {
          const img = tile.querySelector("img");
          if (img) {
            type = "image";
            src = pickBestFromSrcset(img) || img.src || "";
          }
        }

        if (!src || !type) continue;

        out.push({
          type,
          src,
          poster: poster || null,
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX,
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        });
      }

      return out;
    });

    for (const raw of batch) {
      let src = normaliseURL(raw.src);
      if (!src || isExcludedUrl(src)) continue;

      // Ignore mux thumbnails as standalone items (these cause false duplicates)
      const muxThumbId = muxPlaybackIdFromThumb(src);
      if (muxThumbId) {
        seenMuxThumbPlaybackIds.add(muxThumbId);
        continue;
      }

      // Upgrade mux low->high
      src = upgradeMuxLowToHigh(src);

      const type =
        raw.type ||
        (VIDEO_EXT_RE.test(src) ? "video" : IMAGE_EXT_RE.test(src) ? "image" : "image");

      // Keying:
      // - mux videos dedupe by playbackId
      // - everything else dedupe by type+src
      let key = `${type}:${src}`;
      if (type === "video") {
        const pid = muxPlaybackIdFromStream(src);
        if (pid) key = `video:mux:${pid}`;
      }

      // Keep the earliest (highest) in visual order by comparing top/left
      const prev = itemsByKey.get(key);
      const candidate = {
        type,
        src,
        width: 0,
        height: 0,
        top: raw.top,
        left: raw.left,
        ...(raw.poster ? { poster: normaliseURL(raw.poster) } : {})
      };

      if (!prev) {
        itemsByKey.set(key, candidate);
      } else {
        const prevRank = prev.top * 100000 + prev.left;
        const candRank = candidate.top * 100000 + candidate.left;
        if (candRank < prevRank) itemsByKey.set(key, candidate);
      }
    }
  }

  console.log("Scrolling + collecting…");
  let lastH = 0;
  let stable = 0;
  let lastCount = 0;
  let noNewCount = 0;

  for (let i = 0; i < MAX_SCROLLS; i++) {
    await collectVisibleTiles();

    const countNow = itemsByKey.size;
    if (countNow === lastCount) noNewCount++;
    else noNewCount = 0;
    lastCount = countNow;

    // Scroll
    const innerH = await page.evaluate(() => window.innerHeight);
    await page.mouse.wheel(0, Math.floor(innerH * 0.92));
    await page.waitForTimeout(WAIT_BETWEEN);

    // Page growth stability (some Cosmos pages stop growing, some virtualise)
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastH) stable++;
    else { stable = 0; lastH = h; }

    if ((i + 1) % 10 === 0) {
      console.log(`…scroll ${i + 1}, unique items: ${itemsByKey.size}, stable: ${stable}, noNew: ${noNewCount}`);
    }

    // Stop when both:
    // - page height stable for a while
    // - AND we’re not finding new items
    if (stable >= STABLE_CHECKS && noNewCount >= STABLE_CHECKS) break;
  }

  // Final pass at bottom
  await collectVisibleTiles();

  await browser.close();

  // Visual order = top then left
  const items = [...itemsByKey.values()]
    .sort((a, b) => (a.top - b.top) || (a.left - b.left))
    .map(({ top, left, ...rest }) => rest);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ ok: true, source: COSMOS_URL, count: items.length, items }, null, 2)
  );

  console.log(`✅ Saved ${items.length} items → ${OUT_FILE}`);
})();
