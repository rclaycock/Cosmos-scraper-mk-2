// scrape.mjs
// Scrapes a Cosmos gallery page into a JSON feed for 22Slides.
// Key features:
// - Follows Cosmos visual ordering by sorting tiles using computed top/left
// - Handles Cosmos virtualised lists by accumulating items while scrolling
// - Replaces stream.mux.com .../low.mp4 with .../high.mp4
// - Avoids Mux thumbnail duplicates (image.mux.com/<playbackId>/thumbnail.png) when a matching Mux video exists

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const COSMOS_URL = process.env.COSMOS_URL;
const OUT_FILE = process.env.OUT_FILE || "public/gallery.json";

const MAX_SCROLLS = Number(process.env.MAX_SCROLLS || 1200);
const WAIT_BETWEEN = Number(process.env.WAIT_BETWEEN || 900);
const FIRST_IDLE = Number(process.env.FIRST_IDLE || 12000);
const STABLE_CHECKS = Number(process.env.STABLE_CHECKS || 25);

const VIEWPORT_W = Number(process.env.VIEWPORT_W || 1440);
const VIEWPORT_H = Number(process.env.VIEWPORT_H || 900);

const SKIP_AVATAR_RE = /cdn\.cosmos\.so\/default-avatars\//i;

if (!COSMOS_URL) {
  console.error("Missing COSMOS_URL env var");
  process.exit(1);
}

const normUrl = (url) => {
  try {
    const u = new URL(url);
    u.hash = "";
    // keep path as-is, strip query because Cosmos uses cache-busting params
    u.search = "";
    u.host = u.host.toLowerCase();
    return u.toString();
  } catch {
    return null;
  }
};

const upgradeMux = (url) => {
  try {
    const u = new URL(url);
    if (u.host.toLowerCase() !== "stream.mux.com") return url;
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length >= 2) {
      seg[1] = "high.mp4";
      u.pathname = "/" + seg.join("/");
      u.search = "";
      u.hash = "";
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
};

const muxPlaybackIdFromStream = (url) => {
  try {
    const u = new URL(url);
    if (u.host.toLowerCase() !== "stream.mux.com") return null;
    const seg = u.pathname.split("/").filter(Boolean);
    return seg[0] || null;
  } catch {
    return null;
  }
};

const muxPlaybackIdFromThumb = (url) => {
  try {
    const u = new URL(url);
    if (u.host.toLowerCase() !== "image.mux.com") return null;
    // /<playbackId>/thumbnail.png
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length >= 2 && seg[1].toLowerCase() === "thumbnail.png") return seg[0] || null;
    return null;
  } catch {
    return null;
  }
};

const safeWrite = async (filePath, obj) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
};

const run = async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
  });

  const page = await context.newPage();

  const okPayload = {
    ok: true,
    source: COSMOS_URL,
    count: 0,
    items: [],
  };

  try {
    await page.goto(COSMOS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(FIRST_IDLE);

    // Wait for something resembling a tile to exist
    await page.waitForSelector('div[role="listitem"]', { timeout: 60000 }).catch(() => {});

    const collected = new Map(); // key -> item
    let noNewRuns = 0;
    let stuckRuns = 0;

    const extractBatch = async () => {
      return page.evaluate(() => {
        const items = [];

        const parsePx = (v) => {
          if (!v) return 0;
          const n = Number(String(v).replace("px", "").trim());
          return Number.isFinite(n) ? n : 0;
        };

        const getSrcFromVideo = (root) => {
          const v = root.querySelector("video");
          if (!v) return null;
          // currentSrc is best, fallback to src, then <source>
          return v.currentSrc || v.src || (v.querySelector("source") ? v.querySelector("source").src : null);
        };

        const getPosterFromVideo = (root) => {
          const v = root.querySelector("video");
          if (!v) return null;
          return v.poster || null;
        };

        const getSrcFromImg = (root) => {
          const img = root.querySelector("img");
          if (!img) return null;
          return img.currentSrc || img.src || null;
        };

        const getStableId = (el) => {
          // Try a bunch of likely attributes first
          const candidates = [
            el.getAttribute("data-id"),
            el.getAttribute("data-item-id"),
            el.getAttribute("data-testid"),
            el.getAttribute("data-index"),
            el.getAttribute("id"),
            el.getAttribute("aria-posinset"),
          ].filter(Boolean);

          for (const c of candidates) {
            // Prefer UUID-ish ids if present
            const m = String(c).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (m) return m[0];
          }

          // Otherwise return the first non-empty candidate
          return candidates[0] || null;
        };

        const tiles = Array.from(document.querySelectorAll('div[role="listitem"]'));

        for (const el of tiles) {
          const cs = window.getComputedStyle(el);
          const top = parsePx(cs.top || el.style.top);
          const left = parsePx(cs.left || el.style.left);

          const stableId = getStableId(el);

          const vsrc = getSrcFromVideo(el);
          const vposter = getPosterFromVideo(el);

          if (vsrc) {
            items.push({
              stableId,
              type: "video",
              src: vsrc,
              poster: vposter || null,
              width: 0,
              height: 0,
              top,
              left,
            });
            continue;
          }

          const isrc = getSrcFromImg(el);
          if (isrc) {
            items.push({
              stableId,
              type: "image",
              src: isrc,
              width: 0,
              height: 0,
              top,
              left,
            });
          }
        }

        // Sort in the browser so the batch is in visual order for this viewport
        items.sort((a, b) => (a.top - b.top) || (a.left - b.left));
        return items;
      });
    };

    const addBatch = (batch) => {
      let added = 0;

      for (const raw of batch) {
        const src0 = raw?.src;
        if (!src0) continue;

        // Skip default avatars early
        if (SKIP_AVATAR_RE.test(src0)) continue;

        const n0 = normUrl(src0);
        if (!n0) continue;

        // Upgrade Mux low.mp4 to high.mp4
        let finalSrc = n0;
        if (raw.type === "video") finalSrc = upgradeMux(finalSrc);

        const playbackId = raw.type === "video" ? muxPlaybackIdFromStream(finalSrc) : null;

        // Build a stable key that survives Cosmos URL weirdness
        let key = null;
        if (raw.stableId) key = `${raw.type}:id:${raw.stableId}`;
        else if (raw.type === "video" && playbackId) key = `video:mux:${playbackId}`;
        else key = `${raw.type}:url:${finalSrc}`;

        if (!collected.has(key)) {
          collected.set(key, {
            type: raw.type,
            src: finalSrc,
            width: 0,
            height: 0,
            ...(raw.poster ? { poster: normUrl(raw.poster) || raw.poster } : {}),
            // keep ordering info for final sort
            _top: Number(raw.top) || 0,
            _left: Number(raw.left) || 0,
          });
          added++;
        } else {
          // Update ordering position if we find a better one
          const existing = collected.get(key);
          if (existing) {
            const t = Number(raw.top) || 0;
            const l = Number(raw.left) || 0;
            if (t && (!existing._top || t < existing._top)) existing._top = t;
            if (l && (!existing._left || l < existing._left)) existing._left = l;
          }
        }
      }

      return added;
    };

    for (let i = 0; i < MAX_SCROLLS; i++) {
      const beforeY = await page.evaluate(() => window.scrollY);
      const batch = await extractBatch();
      const added = addBatch(batch);

      if (added === 0) noNewRuns++;
      else noNewRuns = 0;

      await page.evaluate(() => window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.9))));
      await page.waitForTimeout(WAIT_BETWEEN);

      const afterY = await page.evaluate(() => window.scrollY);

      if (afterY === beforeY) stuckRuns++;
      else stuckRuns = 0;

      // Stop condition: no new items for a while and we are no longer moving down
      if (noNewRuns >= STABLE_CHECKS && stuckRuns >= 3) break;
    }

    // Finalise, remove Mux thumbnail duplicates if we have the actual Mux video
    const all = Array.from(collected.values());

    const muxVideos = new Set(
      all
        .filter((it) => it.type === "video")
        .map((it) => muxPlaybackIdFromStream(it.src))
        .filter(Boolean)
    );

    const filtered = all.filter((it) => {
      if (it.type !== "image") return true;
      const pid = muxPlaybackIdFromThumb(it.src);
      if (!pid) return true;
      // If a Mux video exists for this playbackId, drop the thumbnail image item
      return !muxVideos.has(pid);
    });

    // Sort by recorded top/left so JSON order matches Cosmos visual order for this viewport
    filtered.sort((a, b) => ((a._top || 0) - (b._top || 0)) || ((a._left || 0) - (b._left || 0)));

    // Strip internal fields
    const items = filtered.map(({ _top, _left, ...rest }) => rest);

    okPayload.count = items.length;
    okPayload.items = items;

    await safeWrite(OUT_FILE, okPayload);
    console.log(`✔ ${path.basename(OUT_FILE)} saved, items: ${items.length}`);
  } catch (e) {
    console.error("Scrape failed:", e);

    const failPayload = {
      ok: false,
      source: COSMOS_URL,
      error: String(e?.message || e),
      count: 0,
      items: [],
    };

    await safeWrite(OUT_FILE, failPayload);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
};

run();
