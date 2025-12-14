import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const COSMOS_URL = process.env.COSMOS_URL;
const OUT_FILE = process.env.OUT_FILE || "public/gallery.json";

const MAX_SCROLLS = Number(process.env.MAX_SCROLLS || 200);
const WAIT_BETWEEN = Number(process.env.WAIT_BETWEEN || 1000);
const FIRST_IDLE = Number(process.env.FIRST_IDLE || 9000);
const STABLE_CHECKS = Number(process.env.STABLE_CHECKS || 6);

const VIEWPORT_W = Number(process.env.VIEWPORT_W || 1400);
const VIEWPORT_H = Number(process.env.VIEWPORT_H || 900);

// IMPORTANT: your rlp-scripts Cosmos bridge reverses the array before rendering.
// If you keep that, leave this = 1.
// If you remove the reverse in rlp-scripts later, set this to 0.
const OUTPUT_REVERSED_FOR_RLP_SCRIPTS = (process.env.OUTPUT_REVERSED_FOR_RLP_SCRIPTS ?? "1") !== "0";

if (!COSMOS_URL) {
  console.error("Missing COSMOS_URL env var");
  process.exit(1);
}

function ensureDir(fp) {
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
  });

  const page = await context.newPage();

  try {
    await page.goto(COSMOS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: FIRST_IDLE });
    } catch {
      // networkidle is often noisy on Next.js sites, ignore
    }

    // Scroll until listitem count stabilises
    let lastCount = 0;
    let stable = 0;

    for (let i = 0; i < MAX_SCROLLS; i++) {
      const count = await page.locator('[role="listitem"]').count();
      if (count === lastCount) stable++;
      else stable = 0;

      lastCount = count;
      if (stable >= STABLE_CHECKS) break;

      await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 1.5)));
      await page.waitForTimeout(WAIT_BETWEEN);

      try {
        await page.waitForLoadState("networkidle", { timeout: 1500 });
      } catch {
        // ignore
      }
    }

    // Give the layout a beat to settle after final scroll
    await page.waitForTimeout(600);

    const extracted = await page.evaluate(() => {
      const SKIP_AVATAR_RE = /cdn\.cosmos\.so\/default-avatars\//i;

      const cleanUrl = (u) => {
        try {
          const x = new URL(u, window.location.href);
          x.search = "";
          x.hash = "";
          return x.toString();
        } catch {
          return null;
        }
      };

      const bestFromSrcset = (srcset) => {
        if (!srcset || typeof srcset !== "string") return null;
        const parts = srcset
          .split(",")
          .map(s => s.trim())
          .map(s => {
            const [url, size] = s.split(/\s+/);
            let score = 0;
            if (size?.endsWith("w")) score = parseInt(size, 10) || 0;
            if (size?.endsWith("x")) score = (parseFloat(size) || 0) * 1000;
            return { url, score };
          })
          .filter(p => p.url);

        if (!parts.length) return null;
        parts.sort((a, b) => b.score - a.score);
        return parts[0].url;
      };

      const upgradeMuxToHigh = (u) => {
        try {
          const x = new URL(u);
          if (x.host.toLowerCase() !== "stream.mux.com") return cleanUrl(x.toString());
          const seg = x.pathname.split("/").filter(Boolean);
          if (seg.length >= 2) seg[1] = "high.mp4";
          x.pathname = "/" + seg.join("/");
          x.search = "";
          x.hash = "";
          return x.toString();
        } catch {
          return cleanUrl(u);
        }
      };

      const getMuxPlaybackId = (u) => {
        try {
          const x = new URL(u);
          if (x.host.toLowerCase() !== "stream.mux.com") return null;
          const seg = x.pathname.split("/").filter(Boolean);
          return seg[0] || null;
        } catch {
          return null;
        }
      };

      const getCosmosUuid = (u) => {
        try {
          const x = new URL(u);
          const m = x.pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          return m ? m[0].toLowerCase() : null;
        } catch {
          return null;
        }
      };

      const isMuxThumbnail = (u) => {
        try {
          const x = new URL(u);
          return x.host.toLowerCase() === "image.mux.com" && x.pathname.toLowerCase().endsWith("/thumbnail.png");
        } catch {
          return false;
        }
      };

      const absHref = (href) => {
        try { return new URL(href, window.location.href).toString(); }
        catch { return null; }
      };

      const pickPermalink = (root) => {
        const anchors = Array.from(root.querySelectorAll("a[href]"))
          .map(a => absHref(a.getAttribute("href")))
          .filter(Boolean);

        if (!anchors.length) return null;

        // Prefer a link that stays inside this cluster path
        const here = new URL(window.location.href);
        const prefer = anchors.find(h => {
          try {
            const u = new URL(h);
            return u.host === here.host && u.pathname.startsWith(here.pathname);
          } catch { return false; }
        });

        return prefer || anchors[0];
      };

      const pickVideoSrc = (root) => {
        const urls = new Set();

        const push = (u) => {
          const cu = cleanUrl(u);
          if (cu) urls.add(cu);
        };

        // Most common
        root.querySelectorAll("video").forEach(v => {
          const s = v.getAttribute("src");
          if (s) push(s);
          const p = v.getAttribute("poster");
          if (p) push(p);
        });

        root.querySelectorAll("source[src]").forEach(s => push(s.getAttribute("src")));

        // Any element with src or data-src
        root.querySelectorAll("[src],[data-src]").forEach(n => {
          const s1 = n.getAttribute("src");
          const s2 = n.getAttribute("data-src");
          if (s1) push(s1);
          if (s2) push(s2);
        });

        const mp4s = Array.from(urls).filter(u => /\.mp4(\?|$)/i.test(u));
        if (!mp4s.length) return null;

        // Prefer Mux mp4
        const mux = mp4s.find(u => {
          try { return new URL(u).host.toLowerCase() === "stream.mux.com"; }
          catch { return false; }
        });

        return mux || mp4s[0];
      };

      const pickPoster = (root) => {
        // Prefer mux thumbnail.png
        const imgs = Array.from(root.querySelectorAll("img")).map(img => {
          const fromSet = bestFromSrcset(img.getAttribute("srcset"));
          return cleanUrl(fromSet || img.getAttribute("src") || img.getAttribute("data-src"));
        }).filter(Boolean);

        const muxThumb = imgs.find(u => isMuxThumbnail(u));
        if (muxThumb) return muxThumb;

        // fallback first image
        return imgs[0] || null;
      };

      const pickImageSrc = (root) => {
        const imgs = Array.from(root.querySelectorAll("img")).map(img => {
          const fromSet = bestFromSrcset(img.getAttribute("srcset"));
          return cleanUrl(fromSet || img.getAttribute("src") || img.getAttribute("data-src"));
        }).filter(Boolean);

        // Filter out junk
        const filtered = imgs.filter(u => !SKIP_AVATAR_RE.test(u));

        // If the only thing we found is a mux thumbnail, treat it as not-an-item
        const nonMuxThumb = filtered.find(u => !isMuxThumbnail(u));
        return nonMuxThumb || null;
      };

      const listitems = Array.from(document.querySelectorAll('[role="listitem"]'));

      const raw = listitems.map(li => {
        const rect = li.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        const left = rect.left + window.scrollX;

        const permalink = pickPermalink(li);

        const videoSrc0 = pickVideoSrc(li);
        const poster0 = pickPoster(li);
        const imageSrc0 = pickImageSrc(li);

        if (videoSrc0) {
          const upgraded = upgradeMuxToHigh(videoSrc0);
          return {
            top,
            left,
            keyHint: permalink || null,
            type: "video",
            src: upgraded,
            poster: poster0 || null,
            width: 0,
            height: 0,
            link: permalink || null,
          };
        }

        if (imageSrc0) {
          // Ignore mux thumbnails as standalone images
          if (isMuxThumbnail(imageSrc0)) return null;

          return {
            top,
            left,
            keyHint: permalink || null,
            type: "image",
            src: imageSrc0,
            width: 0,
            height: 0,
            link: permalink || null,
          };
        }

        return null;
      }).filter(Boolean);

      // Sort in visual order at this viewport
      raw.sort((a, b) => (a.top - b.top) || (a.left - b.left));

      // Dedupe using permalink first, then playbackId, then cosmos uuid, then src
      const seen = new Set();
      const out = [];

      for (const it of raw) {
        let key = null;

        if (it.keyHint) key = `link:${it.keyHint}`;

        if (!key && it.type === "video") {
          const pid = getMuxPlaybackId(it.src);
          if (pid) key = `mux:${pid}`;
        }

        if (!key) {
          const uuid = getCosmosUuid(it.src);
          if (uuid) key = `uuid:${uuid}`;
        }

        if (!key) key = `src:${it.src}`;

        if (seen.has(key)) continue;
        seen.add(key);

        out.push(it);
      }

      return out;
    });

    // Match your current rlp-scripts behaviour (it reverses items before rendering)
    const itemsForJson = OUTPUT_REVERSED_FOR_RLP_SCRIPTS
      ? extracted.slice().reverse()
      : extracted;

    const payload = {
      ok: true,
      source: COSMOS_URL,
      scrapedAt: new Date().toISOString(),
      viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
      count: itemsForJson.length,
      items: itemsForJson.map(({ top, left, keyHint, ...rest }) => rest),
    };

    ensureDir(OUT_FILE);
    fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
    console.log(`Wrote ${payload.count} items -> ${OUT_FILE}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  const fail = {
    ok: false,
    source: COSMOS_URL,
    count: 0,
    items: [],
    error: String(e?.message || e),
  };
  try {
    ensureDir(OUT_FILE);
    fs.writeFileSync(OUT_FILE, JSON.stringify(fail, null, 2));
  } catch {}
  process.exit(1);
});
