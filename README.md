# TV Galaxy

An interactive map of TV shows. Every show is a star; similar shows sit close together and form
coloured galaxies (Crime, Indian web series, K-drama, Anime…). Works as a website and as an Android app.

- **Search by title** — the map flies to the show and draws lines to its nearest stars, with a match % and the reasons.
- **Search by vibe** — type *"small town investigation mystery"* and the shows that fit glow on the map.
- **Episode-ratings heatmap** — see whether a show got better or worse over its seasons.
- **My Universe** — mark shows as watched; they light up as a constellation and the app points you to galaxies you haven't explored. Saved on the device only.
- **Shareable links** — `#show=<tmdb id>` or `#vibe=<words>`.

The repo ships with a 50-show **demo dataset** so the site runs immediately. Replace it with real TMDB data using the steps below.

## Project layout

```
pipeline/            Python scripts that build the data
  fetch_tmdb.py        download the top N shows from TMDB (resumable, cached in data/tmdb.sqlite)
  fetch_episodes.py    optional: per-episode ratings for the heatmap
  build_map.py         similarity, match %, 2-D map (UMAP) and galaxies (HDBSCAN) -> web/public/data
  build_embeddings.py  optional: meaning vectors for vibe search -> web/public/data/emb.bin
  make_demo_data.py    the small hand-written demo dataset
web/                 the website (Vite + PixiJS), also packaged as the Android app (Capacitor)
```

## Prerequisites

| What | Why |
|---|---|
| TMDB account + **API Read Access Token** (free: themoviedb.org → Settings → API) | downloading show data |
| Python 3.10+ | the data pipeline |
| Node.js 20+ | the website |
| Android Studio + JDK 17 | only for building the APK |

## 1. Build the real data

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r pipeline/requirements.txt

export TMDB_TOKEN="your API Read Access Token"          # Windows PowerShell: $env:TMDB_TOKEN="..."
python pipeline/fetch_tmdb.py --limit 20000            # about 1-2 hours; Ctrl+C and re-run to resume
python pipeline/fetch_episodes.py --top 3000           # optional, for the ratings heatmap
python pipeline/build_map.py                           # a few minutes
python pipeline/build_embeddings.py                    # optional, for meaning-based vibe search
```

This rewrites `web/public/data/`. Commit those files to publish them.

To rebuild the demo instead: `python pipeline/make_demo_data.py && python pipeline/build_map.py --db data/tmdb_demo.sqlite --demo --min-votes 0`.

## 2. Run the website

```bash
cd web
npm install
npm run dev          # http://localhost:5173
npm run build        # production files in web/dist
```

Pushing to `main` deploys the site with GitHub Actions. One-time setup: repo **Settings → Pages → Source: GitHub Actions**.

## 3. Build the Android app

```bash
cd web
npm run build
npx cap add android      # first time only
npx cap sync android
npx cap open android     # Android Studio: Build > Build APK(s)
```

## How similarity works

Each show becomes one vector made of eight weighted blocks. The dot product of two shows is the weighted sum of how alike they are in each block:

| Block | Weight | Built from |
|---|---|---|
| Themes | 0.40 | TMDB keywords, TF-IDF (rare shared keywords count more) |
| Genres | 0.25 | TMDB genres |
| Creators | 0.10 | created by |
| Language | 0.08 | original language (+ language family, e.g. all Indian languages) |
| Cast | 0.05 | main cast |
| Network | 0.04 | network / streaming service |
| Era | 0.04 | 5-year bucket, neighbours count half |
| Format | 0.04 | episode length, number of seasons, animated, miniseries |

If TMDB lists two shows as recommendations for each other, the pair gets a small bonus (+0.05).
**Match %** ranks a pair's score against every show's 12 best scores and maps it to 50–99%.
The reasons under each match are the shared keywords, genres, creator, cast or language that produced the score.
Weights live at the top of `pipeline/build_map.py`.

**Vibe search** = 0.6 × meaning match (all-MiniLM-L6-v2 sentence embeddings; the same model runs in the browser via Transformers.js) + 0.3 × keyword match + 0.1 × popularity. Without embeddings it uses keywords only.

## Credits

Data from [TMDB](https://www.themoviedb.org/). This product uses the TMDB API but is not endorsed or certified by TMDB.
Streaming availability data by JustWatch (via TMDB). Inspired by Mikey Guinness's Movie Map.
