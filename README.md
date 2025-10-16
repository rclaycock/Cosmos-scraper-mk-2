# Cosmos scraper → JSON feeds

Scrapes one or more Cosmos gallery URLs and publishes JSON feeds to GitHub Pages.

## Setup
1. Create this repo with the structure in this README (include an empty `public/` folder).
2. Push/Upload all files via github.com.
3. Go to **Actions** → enable workflows if prompted.
4. Go to **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: **gh-pages** / **/** (root)
5. Run a scrape: **Actions → “Cosmos Gallery → gallery.json” → Run workflow**.

JSON feeds appear at:https://.github.io/cosmos-scraper/.json
Where `<slug>` is the last segment of the Cosmos URL (e.g. `swim`, `studio-tests`, …).

## Change galleries
Edit `.github/workflows/cosmos-gallery.yml`, update `URLS` (comma-separated), commit, run again.

## Tuning
Adjust env vars in the workflow:
- `MAX_SCROLLS`, `WAIT_BETWEEN`, `FIRST_IDLE`, `STABLE_CHECKS`.

## Consume in 22Slides
Use the JSON URL in your embed block’s `data-feed`.

---