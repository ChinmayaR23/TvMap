// Loads the files written by pipeline/build_map.py (and build_embeddings.py, if run).
// VITE_DATA_URL lets the Android app read the data from the website instead of bundling it.
//
// Everything is kept in the browser's Cache Storage, so after the first launch the map opens
// without waiting for the network. shows.json is refreshed in the background and the new
// version is used from the next launch. Each data file carries the build time ("generated" /
// "_v"), so files from different builds are never mixed.
const BASE = import.meta.env.VITE_DATA_URL || import.meta.env.BASE_URL + 'data/';
const CACHE = 'tvgalaxy-data-v1';

async function openCache() {
  try { return 'caches' in self ? await caches.open(CACHE) : null; } catch { return null; }
}

async function fromCache(url) {
  const c = await openCache();
  const r = c && (await c.match(url));
  if (!r) return null;
  try { return await r.json(); } catch { return null; }
}

async function toCache(url, text) {
  const c = await openCache();
  if (c) await c.put(url, new Response(text, { headers: { 'Content-Type': 'application/json' } })).catch(() => {});
}

/** Network fetch that reports progress in bytes. */
async function fetchText(url, onBytes) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!onBytes || !res.body) return res.text();
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onBytes(got);
  }
  const all = new Uint8Array(got);
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.length; }
  return new TextDecoder().decode(all);
}

async function getJson(name, { validate, onBytes } = {}) {
  const url = BASE + name;
  const cached = await fromCache(url);
  if (cached && (!validate || validate(cached))) return cached;
  const text = await fetchText(url, onBytes);
  await toCache(url, text);
  return JSON.parse(text);
}

function prepare(core) {
  core.byId = new Map(core.shows.map((s, i) => [s.id, i]));
  core.shows.forEach((s, i) => {
    s.idx = i;
    s.genreNames = s.g.map((g) => core.genres[g]);
    // older data files kept keywords inside shows.json
    if (s.k && core.keywords) s.kwNames = s.k.map((k) => core.keywords[k]);
  });
  return core;
}

export async function loadCore(onStep = () => {}) {
  const url = BASE + 'shows.json';
  const cached = await fromCache(url);
  if (cached) {
    onStep('Opening saved galaxy…');
    // refresh quietly; the new version is used next time the app opens
    fetchText(url)
      .then((text) => {
        const fresh = JSON.parse(text);
        if (fresh.generated !== cached.generated || fresh.count !== cached.count) return toCache(url, text);
      })
      .catch(() => {});
    return prepare(cached);
  }
  onStep('Downloading shows…');
  let text;
  try {
    text = await fetchText(url, (b) => onStep(`Downloading shows… ${(b / 1048576).toFixed(1)} MB`));
  } catch {
    throw new Error('Could not load the show data. Check the internet connection and try again.');
  }
  await toCache(url, text);
  onStep('Reading shows…');
  return prepare(JSON.parse(text));
}

/** The core file in use is older than the other files on the server: drop it and start again. */
async function staleCore() {
  const c = await openCache();
  if (c) await c.delete(BASE + 'shows.json');
  location.reload();
}

let kwPromise = null;
/** Keywords are only needed by vibe search, so they are fetched the first time it runs. */
export function loadKeywords(core) {
  if (core.shows[0]?.kwNames) return Promise.resolve();
  if (!kwPromise) {
    kwPromise = getJson('kw.json', { validate: (kw) => !kw._v || kw._v === core.generated })
      .catch(() => null)
      .then((kw) => {
        if (kw?._v && core.generated && kw._v !== core.generated) return staleCore();
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
    chunkCache.set(c, getJson(`details/${c}.json`, { validate: (ch) => !ch._v || ch._v === core.generated }));
  }
  const chunk = await chunkCache.get(c);
  if (chunk._v && core.generated && chunk._v !== core.generated) {
    await staleCore();
    return new Promise(() => {}); // the page is reloading
  }
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
        const c = await openCache();
        const url = BASE + 'emb.bin?' + (meta.generated || meta.count);
        let res = c && (await c.match(url));
        if (!res) {
          res = await fetch(BASE + 'emb.bin');
          if (c && res.ok) await c.put(url, res.clone()).catch(() => {});
        }
        return { ...meta, vectors: new Int8Array(await res.arrayBuffer()) };
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
