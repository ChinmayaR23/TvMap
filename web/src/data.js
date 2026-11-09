// Loads the files written by pipeline/build_map.py (and build_embeddings.py, if run).
// VITE_DATA_URL lets the Android app read the data from the website instead of bundling it.
const BASE = import.meta.env.VITE_DATA_URL || import.meta.env.BASE_URL + 'data/';

export async function loadCore() {
  const res = await fetch(BASE + 'shows.json');
  if (!res.ok) throw new Error('Could not load the show data. Run the Build data workflow (or the pipeline) first.');
  const core = await res.json();
  core.byId = new Map(core.shows.map((s, i) => [s.id, i]));
  core.shows.forEach((s, i) => {
    s.idx = i;
    s.genreNames = s.g.map((g) => core.genres[g]);
    // older data files kept keywords inside shows.json
    if (s.k && core.keywords) s.kwNames = s.k.map((k) => core.keywords[k]);
  });
  return core;
}

let kwPromise = null;
/** Keywords are only needed by vibe search, so they are fetched the first time it runs. */
export function loadKeywords(core) {
  if (core.shows[0]?.kwNames) return Promise.resolve();
  if (!kwPromise) {
    kwPromise = fetch(BASE + 'kw.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((kw) => {
        core.shows.forEach((s, i) => {
          s.kwNames = kw ? (kw.k[i] || []).map((k) => kw.keywords[k]) : [];
        });
      });
  }
  return kwPromise;
}

const chunkCache = new Map();
export async function loadDetails(core, idx) {
  const c = Math.floor(idx / core.chunk);
  if (!chunkCache.has(c)) {
    chunkCache.set(c, fetch(`${BASE}details/${c}.json`).then((r) => r.json()));
  }
  const chunk = await chunkCache.get(c);
  return chunk[idx];
}

let embPromise = null;
/** Returns {model, dim, count, vectors: Int8Array} or null when the embeddings were not built.
 *  count can be smaller than the number of shows: only the most popular shows get vectors. */
export function loadEmbeddings() {
  if (!embPromise) {
    embPromise = (async () => {
      try {
        const metaRes = await fetch(BASE + 'emb.json');
        if (!metaRes.ok) return null;
        const meta = await metaRes.json();
        const bin = await fetch(BASE + 'emb.bin').then((r) => r.arrayBuffer());
        return { ...meta, vectors: new Int8Array(bin) };
      } catch {
        return null;
      }
    })();
  }
  return embPromise;
}

export function posterUrl(path, size = 'w185') {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}
