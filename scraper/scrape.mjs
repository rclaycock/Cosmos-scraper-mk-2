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
const M3U8_EXT_RE  = /\.m3u8(\?|$)/i;

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

// Image host enforcement (only keep images hosted on cosmos.so)
function isCosmosImageHost(hostname) {
  const h = (hostname || "").toLowerCase();
  return h === "cosmos.so" || h.endsWith(".cosmos.so");
}

// Exclusions
function isExcluded(src) {
  return (
    !src ||
    src.startsWith("data:") ||
    src.includes("default-avatars") ||
    src.includes("/_next/") ||
    src.includes("favicon") ||
    src.includes("cosmos.so/api/avatar") ||
    M3U8_EXT_RE.test(src)
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
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

function hasFileExtension(pathname) {
  // True if last path segment contains ".ext"
  try {
    const last = (pathname || "").split("/").filter(Boolean).pop() || "";
    return /\.[a-z0-9]{2,5}$/i.test(last);
  } catch {
    return false;
  }
}

/**
 * Allow rule:
 * - Always reject .m3u8
 * - For images: allow cosmos.so hosted images, including extensionless Cosmos URLs
 * - For videos: keep existing allow behaviour (extension OR allowlisted host)
 * - For unknown: keep existing allow behaviour (extension OR allowlisted host)
 */
function allowByHostAndExt(urlStr, typeHint = "unknown") {
  try {
    const u = new URL(urlStr);
    const pathname = u.pathname || "";
    if (M3U8_EXT_RE.test(pathname)) return false;

    const hostOk = CDN_HOST_ALLOW.some(h => u.host.toLowerCase().includes(h));
    const extOk  = MEDIA_EXT_RE.test(pathname);

    if (typeHint === "image") {
      // Cosmos often serves AVIF with no extension (eg /<uuid>)
      // Accept only cosmos hosted, reject obvious video/m3u8, and allow extensionless.
      if (!isCosmosImageHost(u.host)) return false;
      if (VIDEO_EXT_RE.test(pathname)) return false;
      if (M3U8_EXT_RE.test(pathname)) return false;

      if (IMAGE_EXT_RE.test(pathname)) return true;
      // If no extension on the last segment, treat it as a Cosmos image.
      if (!hasFileExtension(pathname)) return true;

      return false;
    }

    if (typeHint === "video") {
      return extOk || hostOk;
    }

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
  return urlStr; // keep low.mp4 as-is (no replacement)
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

function clampDim(n, fallback = 0) {
  const x = Number(n) || 0;
  if (!isFinite(x) || x <= 0) return fallback;
  // avoid silly huge numbers from bad DOM states
  return Math.min(Math.max(Math.floor(x), 1), 20000);
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

      // Explicit drop for .m3u8
      if (M3U8_EXT_RE.test(norm)) return;

      if (MEDIA_EXT_RE.test(norm)) {
        const isImg = IMAGE_EXT_RE.test(new URL(norm).pathname);
        const isVid = VIDEO_EXT_RE.test(new URL(norm).pathname);
        const hint = isImg ? "image" : (isVid ? "video" : "unknown");
        if (allowByHostAndExt(norm, hint)) netFound.add(norm);
        return;
      }

      const ct = (res.headers()["content-type"] || "").toLowerCase();
      if (ct.includes("application/json")) {
        const text = await res.text().catch(() => "");
        const urls = text.match(/https?:\/\/[^\s"'\\)]+/g) || [];
        for (const u of urls) {
          const n = normaliseURL(u);
          if (!n || isExcluded(n) || isMuxThumbnail(n)) continue;

          // Explicit drop for .m3u8
          if (M3U8_EXT_RE.test(n)) continue;

          let hint = "unknown";
          try {
            const p = new URL(n).pathname || "";
            if (IMAGE_EXT_RE.test(p)) hint = "image";
            else if (VIDEO_EXT_RE.test(p)) hint = "video";
            else if (M3U8_EXT_RE.test(p)) hint = "video";
          } catch {}

          if (allowByHostAndExt(n, hint)) netFound.add(n);
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
      if (M3U8_EXT_RE.test(u)) continue;

      let hint = "unknown";
      try {
        const p = new URL(u).pathname || "";
        if (IMAGE_EXT_RE.test(p)) hint = "image";
        else if (VIDEO_EXT_RE.test(p)) hint = "video";
        else if (M3U8_EXT_RE.test(p)) hint = "video";
      } catch {}

      if (!allowByHostAndExt(u, hint)) continue;

      let isVideo = false;
      try { isVideo = VIDEO_EXT_RE.test(new URL(u).pathname); } catch {}
      if (!foundMap.has(u)) foundMap.set(u, { type: isVideo ? "video" : "image", src: u, width: 0, height: 0 });
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
          left: rect.left + window.scrollX,
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0
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
          left: rect.left + window.scrollX,
          width: v.videoWidth || 0,
          height: v.videoHeight || 0
        });
      });

      // 3) background-image tiles (Cosmos often uses these for stills)
      // We only take “large enough” elements to avoid icons/sprites
      // Note: backgrounds rarely expose intrinsic pixel size, so we only store rendered size as a fallback.
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
          left: rect.left + window.scrollX,
          width: Math.round(rect.width) || 0,
          height: Math.round(rect.height) || 0
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
      if (M3U8_EXT_RE.test(norm0)) continue;

      let hint = "unknown";
      try {
        const p = new URL(norm0).pathname || "";
        if (IMAGE_EXT_RE.test(p)) hint = "image";
        else if (VIDEO_EXT_RE.test(p)) hint = "video";
        else if (M3U8_EXT_RE.test(p)) hint = "video";
        else if (it.type === "image") hint = "image";
        else if (it.type === "video") hint = "video";
      } catch {
        if (it.type === "image") hint = "image";
        if (it.type === "video") hint = "video";
      }

      if (!allowByHostAndExt(norm0, hint)) continue;

      const isVideo = VIDEO_EXT_RE.test(new URL(norm0).pathname);
      positional.push({
        type: isVideo ? "video" : "image",
        src: norm0,
        poster: it.poster ? normaliseURL(it.poster, COSMOS_URL) : null,
        top: Number(it.top) || 0,
        left: Number(it.left) || 0,
        width: clampDim(it.width, 0),
        height: clampDim(it.height, 0)
      });

      if (!foundMap.has(norm0)) {
        foundMap.set(norm0, {
          type: isVideo ? "video" : "image",
          src: norm0,
          poster: null,
          width: clampDim(it.width, 0),
          height: clampDim(it.height, 0)
        });
      } else {
        // If we captured dims later, keep the best (largest non-zero)
        const existing = foundMap.get(norm0);
        const nw = clampDim(it.width, 0);
        const nh = clampDim(it.height, 0);
        if (existing) {
          if ((!existing.width || existing.width < nw) && nw) existing.width = nw;
          if ((!existing.height || existing.height < nh) && nh) existing.height = nh;
        }
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

    // Drop .m3u8 always
    if (M3U8_EXT_RE.test(src)) continue;

    // Enforce cosmos-only images
    try {
      const u = new URL(src);
      if (it.type === "image" && !isCosmosImageHost(u.host)) continue;
    } catch {}

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
      width: clampDim(it.width, 0),
      height: clampDim(it.height, 0)
    };

    // Keep poster if present and not junk
    if (it.poster) {
      const p = normaliseURL(it.poster, COSMOS_URL);
      if (p && !isExcluded(p) && !isMuxThumbnail(p) && !M3U8_EXT_RE.test(p)) out.poster = p;
    }

    ordered.push(out);
  }

  // Optional: append network-only items that never appeared on screen
  // Keep after visible items so ordering stays correct.
  for (const v of foundMap.values()) {
    const src = v?.src;
    if (!src) continue;
    if (isExcluded(src) || isMuxThumbnail(src)) continue;
    if (M3U8_EXT_RE.test(src)) continue;

    let hint = "unknown";
    try {
      const p = new URL(src).pathname || "";
      if (IMAGE_EXT_RE.test(p)) hint = "image";
      else if (VIDEO_EXT_RE.test(p)) hint = "video";
      else if (M3U8_EXT_RE.test(p)) hint = "video";
      else if (v.type === "image") hint = "image";
      else if (v.type === "video") hint = "video";
    } catch {
      if (v.type === "image") hint = "image";
      if (v.type === "video") hint = "video";
    }

    if (!allowByHostAndExt(src, hint)) continue;

    const type = v.type || (VIDEO_EXT_RE.test(new URL(src).pathname) ? "video" : "image");

    // Enforce cosmos-only images
    if (type === "image") {
      try {
        const u = new URL(src);
        if (!isCosmosImageHost(u.host)) continue;
      } catch {}
    }

    let finalSrc = src;
    if (type === "video") finalSrc = upgradeMuxLowToHigh(finalSrc);
    if (type === "video" && hasAnyMux && isCosmosHostedMp4(finalSrc)) continue;

    // Drop .m3u8 always
    if (M3U8_EXT_RE.test(finalSrc)) continue;

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

    ordered.push({
      type,
      src: norm,
      width: clampDim(v.width, 0),
      height: clampDim(v.height, 0)
    });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ ok: true, source: COSMOS_URL, count: ordered.length, items: ordered }, null, 2)
  );

  console.log(`✅ Saved ${ordered.length} items → ${OUT_FILE}`);
})();
