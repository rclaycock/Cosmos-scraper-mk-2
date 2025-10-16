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

const MAX_SCROLLS = Number(process.env.MAX_SCROLLS || 100);
const WAIT_BETWEEN = Number(process.env.WAIT_BETWEEN || 1000);
const FIRST_IDLE = Number(process.env.FIRST_IDLE || 9000);
const STABLE_CHECKS = Number(process.env.STABLE_CHECKS || 6);

const MEDIA_EXT_RE = /\.(jpe?g|png|webp|gif|avif|mp4|webm|m4v|mov|heic)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|webm|m4v|mov)(\?|$)/i;
const SKIP_RE = /cdn\.cosmos\.so\/default-avatars\//i;

function normaliseURL(src, base = COSMOS_URL) {
  try {
    const u = new URL(src, base);
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

function allowByExt(url) {
  try {
    const u = new URL(url);
    return MEDIA_EXT_RE.test(u.pathname);
  } catch {
    return false;
  }
}

function uniq(items) {
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

  console.log(`🔍 Visiting ${COSMOS_URL}`);
  await page.goto(COSMOS_URL, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(FIRST_IDLE);

  // ---- Step 1: Try internal JSON for videos (if present) ----
  const jsonMedia = await page.evaluate(() => {
    const s = document.querySelector("script#__NEXT_DATA__");
    if (!s) return [];
    try {
      const j = JSON.parse(s.textContent);
      const blocks =
        j?.props?.pageProps?.collection?.items ||
        j?.props?.pageProps?.content?.items ||
        j?.props?.pageProps?.blocks ||
        [];
      const vids = [];
      const EXT = /\.(mp4|webm|m4v|mov)(\?|$)/i;
      for (const b of blocks) {
        const url =
          b?.video?.url || b?.asset?.url || b?.image?.url || b?.url || b?.href;
        if (!url || !EXT.test(url)) continue;
        vids.push({
          type: "video",
          src: url,
          width: b?.video?.width || 0,
          height: b?.video?.height || 0,
        });
      }
      return vids;
    } catch {
      return [];
    }
  });

  console.log(`🧩 Found ${jsonMedia.length} videos in internal JSON`);

  // ---- Step 2: Scroll + collect all DOM assets (images + videos) ----
  const found = new Map();

  async function collectFromDOM() {
    const batch = await page.evaluate(() => {
      const results = [];
      const SKIP = /cdn\.cosmos\.so\/default-avatars\//i;
      const EXT = /\.(jpe?g|png|webp|gif|avif|mp4|webm|m4v|mov|heic)(\?|$)/i;

      document.querySelectorAll("img,video").forEach(el => {
        const src =
          el.currentSrc ||
          el.src ||
          el.getAttribute("src") ||
          el.querySelector("source")?.src ||
          "";
        if (!src || SKIP.test(src) || !EXT.test(src)) return;

        const rect = el.getBoundingClientRect();
        const w = el.naturalWidth || el.videoWidth || 0;
        const h = el.naturalHeight || el.videoHeight || 0;
        const type = /\.(mp4|webm|m4v|mov)(\?|$)/i.test(src)
          ? "video"
          : "image";
        results.push({ type, src, width: w, height: h, top: rect.top + window.scrollY });
      });

      return results;
    });

    for (const it of batch) {
      const n = normaliseURL(it.src);
      if (!n || SKIP_RE.test(n) || !allowByExt(n)) continue;
      found.set(n, { ...it, src: n });
    }
  }

  let lastH = 0;
  let stable = 0;
  for (let i = 0; i < MAX_SCROLLS; i++) {
    await collectFromDOM();
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(WAIT_BETWEEN);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastH) {
      stable++;
      if (stable >= STABLE_CHECKS) break;
    } else {
      stable = 0;
      lastH = h;
    }
  }

  await collectFromDOM();
  await browser.close();

  const domItems = Array.from(found.values()).sort((a, b) => a.top - b.top);
  const merged = uniq([...domItems, ...jsonMedia]);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      { ok: true, source: COSMOS_URL, count: merged.length, items: merged },
      null,
      2
    )
  );

  console.log(`💾 Saved ${merged.length} items → ${OUT_FILE}`);
})();
