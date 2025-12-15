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
const MAX_SCROLLS   = Number(process.env.MAX_SCROLLS   || 260);
const WAIT_BETWEEN  = Number(process.env.WAIT_BETWEEN  || 900);
const FIRST_IDLE    = Number(process.env.FIRST_IDLE    || 8000);
const STABLE_CHECKS = Number(process.env.STABLE_CHECKS || 8);

// Media patterns
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|heic)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|webm|m4v|mov)(\?|$)/i;
const MEDIA_EXT_RE = /\.(jpe?g|png|webp|gif|avif|mp4|webm|m4v|mov|heic)(\?|$)/i;

// Hosts
const CDN_HOST_ALLOW = [
  "cdn.cosmos.so",
  "files.cosmos.so",
  "image.mux.com",
  "stream.mux.com",
  "images.prismic",
  "cloudfront",
  "googleusercontent"
];

// Exclusions
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

// Ignore mux thumbnails (these cause "duplicate looking" stills)
function isMuxThumbnail(urlStr) {
  try {
    const u = new URL(urlStr);
    return (
      u.host.toLowerCase() === "image.mux.com" &&
      /\/thumbnail\.png$/i.test(u.pathname)
    );
  } catch {
    return false;
  }
}

// Normalise URL (strip query/hash, keep extension)
function normaliseURL(src, base = COSMOS_URL) {
  try {
    const u = new URL(src, base);
    u.search = "";
    u.hash = "";
    // keep protocol/host/path
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

function allowByHostAndExt(urlStr) {
  try {
    const u = new URL(urlStr);
    const hostOk = CDN_HOST_ALLOW.some(h => u.host.toLowerCase().includes(h));
    const extOk  = MEDIA_EXT_RE.test(u.pathname);
    return extOk || hostOk;
  } catch {
    return false;
  }
}

// Mux helpers
const MUX_STREAM_HOST = "stream.mux.com";
function muxPlaybackIdFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.host.toLowerCase() !== MUX_STREAM_HOST) return null;
    const seg = u.pathname.split("/").filter(Boolean);
    return seg[0] || null; // /<playbackId>/low.mp4
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
    // enforce high.mp4
    seg[1] = "high.mp4";
    u.pathname = "/" + seg.join("/");
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return urlStr;
  }
}

function isCosmosHostedMp4(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.host.toLowerCase();
    if (!VIDEO_EXT_RE.test(u.pathname)) return false;
    return host === "cdn.cosmos.so" || host === "files.cosmos.so";
  } catch {
    return false;
  }
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
    window.IntersectionObserver = class FakeIO {
      constructor(cb){ this._cb = cb; }
      observe(el){
        try { this._cb([{ isIntersecting: true, target: el, intersectionRatio: 1 }]); } catch {}
      }
      unobserve() {}
      disconnect() {}
      takeRecords(){ return []; }
    };
    window.IntersectionObserverEntry = function(){};
  });

  // Network capture (helps when URLs are present in JSON responses)
  const netFound = new Set();
  page.on("response", async (res) => {
    try {
      const url = res.url();
      let norm = normaliseURL(url);
      if (!norm || isExcluded(norm) || isMuxThumbnail(norm)) return;

      if (MEDIA_EXT_RE.test(norm)) {
        netFound.add(norm);
        return;
      }

      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (ct.includes("application/json")) {
        const text = await res.text().catch(() => "");
        const urls = text.match(/https?:\/\/[^\s"'\\)]+/g) || [];
        for (const u of urls) {
          const n = normaliseURL(u);
          if (!n || isExcluded(n) || isMuxThumbnail(n)) continue;
          if (allowByHostAndExt(n)) netFound.add(n);
        }
      }
    } catch {}
  });

  console.log(`Navigating to ${COSMOS_URL}`);
  await page.goto(COSMOS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(FIRST_IDLE);

  // We keep positional captures from DOM (the only way to reproduce Cosmos ordering)
  let positional = [];
  const foundMap = new Map(); // src -> item (for late merges)

  function mergeNetworkToMap() {
    for (const u of netFound) {
      if (!u || isExcluded(u) || isMuxThumbnail(u)) continue;
      if (!allowByHostAndExt(u)) continue;
      const isVideo = VIDEO_EXT_RE.test(new URL(u).pathname);
      if (!foundMap.has(u)) foundMap.set(u, { type: isVideo ? "video" : "image", src: u });
    }
  }

  async function collectFromDOM() {
    const batch = await page.evaluate(() => {
      const out = [];

      // Prefer a stable “main” area but don’t assume Cosmos internals
      const root =
        document.querySelector("main") ||
        document.querySelector("#__next") ||
        document.body;

      const pickBestFromSrcset = (img) => {
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
      };

      const bgUrl = (el) => {
        try {
          const bg = getComputedStyle(el).backgroundImage || "";
          const m = bg.match(/url\((['"]?)(.*?)\1\)/i);
          return m?.[2] || "";
        } catch { return ""; }
      };

      // 1) <img>
      root.querySelectorAll("img").forEach(img => {
        const rect = img.getBoundingClientRect();
        const src = pickBestFromSrcset(img);
        if (!src) return;
        out.push({
          type: "image",
          src,
          poster: null,
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX
        });
      });

      // 2) <video>
      root.querySelectorAll("video").forEach(v => {
        const rect = v.getBoundingClientRect();
        const s = v.currentSrc || v.src || (v.querySelector("source")?.src) || "";
        if (!s) return;
        out.push({
          type: "video",
          src: s,
          poster: v.poster || null,
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX
        });
      });

      // 3) background-image tiles (Cosmos often uses these for stills)
      // We only take “large enough” elements to avoid icons/sprites
      root.querySelectorAll("*").forEach(el => {
        const s = bgUrl(el);
        if (!s) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 120) return;
        out.push({
          type: "image",
          src: s,
          poster: null,
          top: rect.top + window.scrollY,
          left: rect.left + window.scrollX
        });
      });

      return out;
    });

    for (const it of batch) {
      if (!it?.src) continue;
      if (isExcluded(it.src)) continue;

      const norm0 = normaliseURL(it.src, COSMOS_URL);
      if (!norm0) continue;
      if (isExcluded(norm0) || isMuxThumbnail(norm0)) continue;
      if (!allowByHostAndExt(norm0)) continue;

      const isVideo = VIDEO_EXT_RE.test(new URL(norm0).pathname);
      positional.push({
        type: isVideo ? "video" : "image",
        src: norm0,
        poster: it.poster ? normaliseURL(it.poster, COSMOS_URL) : null,
        top: Number(it.top) || 0,
        left: Number(it.left) || 0
      });

      if (!foundMap.has(norm0)) {
        foundMap.set(norm0, { type: isVideo ? "video" : "image", src: norm0, poster: null });
      }
    }

    mergeNetworkToMap();
  }

  console.log("Scrolling + collecting…");
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
      console.log(`…scroll ${i + 1}, DOM items: ${positional.length}, net: ${netFound.size}`);
    }
  }

  await collectFromDOM();
  await browser.close();

  // Sort visually to match Cosmos grid order
  positional.sort((a, b) => (a.top - b.top) || (a.left - b.left));

  // Build ordered list, with better dedupe + mux upgrade + cosmos-mp4 drop
  const hasAnyMux = positional.some(p => {
    try { return new URL(p.src).host.toLowerCase() === MUX_STREAM_HOST; } catch { return false; }
  });

  const seen = new Set();
  const ordered = [];

  for (const it of positional) {
    let src = it.src;

    // Drop mux thumbnails (image.mux.com/.../thumbnail.png)
    if (isMuxThumbnail(src)) continue;

    // Upgrade mux mp4 quality
    if (it.type === "video") {
      src = upgradeMuxLowToHigh(src);
    }

    // If we have mux videos in this gallery, drop cosmos-hosted mp4 duplicates
    if (it.type === "video" && hasAnyMux && isCosmosHostedMp4(src)) {
      continue;
    }

    const norm = normaliseURL(src, COSMOS_URL);
    if (!norm) continue;

    // Keying
    let key;
    if (it.type === "video") {
      const pid = muxPlaybackIdFromUrl(norm);
      key = pid ? `video:mux:${pid}` : `video:url:${norm}`;
    } else {
      key = `image:url:${norm}`;
    }

    if (seen.has(key)) continue;
    seen.add(key);

    const out = {
      type: it.type,
      src: norm,
      width: 0,
      height: 0
    };

    // Keep poster if present and not junk
    if (it.poster) {
      const p = normaliseURL(it.poster, COSMOS_URL);
      if (p && !isExcluded(p) && !isMuxThumbnail(p)) out.poster = p;
    }

    ordered.push(out);
  }

  // Optional: append network-only items that never appeared on screen
  // Keep after visible items so ordering stays correct.
  for (const v of foundMap.values()) {
    const src = v?.src;
    if (!src) continue;
    if (isExcluded(src) || isMuxThumbnail(src)) continue;
    if (!allowByHostAndExt(src)) continue;

    const type = v.type || (VIDEO_EXT_RE.test(new URL(src).pathname) ? "video" : "image");

    let finalSrc = src;
    if (type === "video") finalSrc = upgradeMuxLowToHigh(finalSrc);
    if (type === "video" && hasAnyMux && isCosmosHostedMp4(finalSrc)) continue;

    const norm = normaliseURL(finalSrc, COSMOS_URL);
    if (!norm) continue;

    let key;
    if (type === "video") {
      const pid = muxPlaybackIdFromUrl(norm);
      key = pid ? `video:mux:${pid}` : `video:url:${norm}`;
    } else {
      key = `image:url:${norm}`;
    }

    if (seen.has(key)) continue;
    seen.add(key);

    ordered.push({ type, src: norm, width: 0, height: 0 });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ ok: true, source: COSMOS_URL, count: ordered.length, items: ordered }, null, 2)
  );

  console.log(`✅ Saved ${ordered.length} items → ${OUT_FILE}`);
})();
