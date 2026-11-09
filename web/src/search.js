// Two kinds of search:
//  - title search: "stranger things" -> jump to that star
//  - vibe search:  "small town investigation mystery" -> shows that fit the description
// Vibe score = 0.6 meaning match (embeddings, if built) + 0.3 keyword match + 0.1 popularity.
// Without embeddings it falls back to keyword match (0.85) + popularity (0.15).
import { loadEmbeddings } from './data.js';

const STOP = new Set('a an the and or of in on at to for with about like show shows series something some that is are was be by from set where who which this kind type sort want watch me i my'.split(' '));

// A small hand-made list so plain words still find TMDB's keyword phrasing.
const SYNONYMS = {
  investigation: ['detective', 'murder investigation', 'police', 'investigation'],
  detective: ['detective', 'investigation', 'police'],
  cop: ['police', 'detective', 'police officer'],
  village: ['village', 'small town', 'rural'],
  town: ['small town'],
  creepy: ['supernatural', 'horror', 'surreal'],
  scary: ['horror', 'supernatural'],
  spooky: ['supernatural', 'horror'],
  funny: ['comedy', 'sitcom', 'dark comedy'],
  cozy: ['slice of life', 'family', 'friendship', 'small town'],
  cosy: ['slice of life', 'family', 'friendship', 'small town'],
  feelgood: ['slice of life', 'friendship', 'comedy'],
  heist: ['heist', 'robbery'],
  gangster: ['gangster', 'mafia', 'drug cartel', 'organized crime'],
  mafia: ['mafia', 'gangster', 'organized crime'],
  drugs: ['drug dealer', 'drug cartel', 'drug lord'],
  space: ['space', 'spaceship', 'outer space'],
  future: ['dystopia', 'near future', 'future'],
  robots: ['robot', 'artificial intelligence'],
  ai: ['artificial intelligence', 'robot'],
  time: ['time travel', 'time loop'],
  mindbending: ['time travel', 'surreal', 'dimension', 'memory'],
  romance: ['romance', 'love'],
  romantic: ['romance', 'love'],
  dragons: ['dragon', 'magic', 'medieval'],
  medieval: ['medieval', 'kingdom', 'throne'],
  courtroom: ['courtroom', 'lawyer', 'law firm'],
  lawyer: ['lawyer', 'law firm', 'courtroom'],
  office: ['office', 'workplace'],
  students: ['students', 'school', 'college', 'coaching'],
  college: ['college', 'students', 'university'],
  indian: ['india', 'mumbai', 'delhi', 'uttar pradesh'],
  korean: ['south korea'],
  true: ['based on true story'],
  real: ['based on true story'],
  serial: ['serial killer'],
  killer: ['serial killer', 'murder'],
  zombie: ['zombie', 'plague'],
  anime: ['anime', 'based on manga'],
};

const norm = (t) => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function createSearch(core) {
  const names = core.shows.map((s) => norm(s.n));

  // ---------- title search
  function titles(q, limit = 8) {
    const nq = norm(q);
    if (!nq) return [];
    const out = [];
    names.forEach((n, i) => {
      let sc = 0;
      if (n === nq) sc = 1;
      else if (n.startsWith(nq)) sc = 0.9;
      else if ((' ' + n).includes(' ' + nq)) sc = 0.75;
      else if (n.includes(nq)) sc = 0.6;
      if (sc) out.push([sc + core.shows[i].p * 0.05, i]);
    });
    return out.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([score, i]) => ({ i, score }));
  }

  // ---------- keyword index for vibe search
  let index = null;
  function buildIndex() {
    const df = new Map();
    const docs = core.shows.map((s) => {
      const phrases = new Set([...s.kwNames.map(norm), ...s.genreNames.map((g) => norm(g.replace('&', ' ')))]);
      const words = new Set();
      phrases.forEach((p) => p.split(' ').forEach((w) => w.length > 2 && words.add(w)));
      const all = new Set([...phrases, ...words]);
      all.forEach((t) => df.set(t, (df.get(t) || 0) + 1));
      return { phrases, all };
    });
    const N = core.shows.length;
    const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));
    index = { docs, idf };
  }

  function queryTerms(q) {
    const words = norm(q).split(' ').filter((w) => w && !STOP.has(w));
    const terms = new Map(); // term -> weight
    const add = (t, w) => terms.set(t, Math.max(terms.get(t) || 0, w));
    words.forEach((w) => {
      add(w, 1);
      if (w.endsWith('s') && w.length > 4) add(w.slice(0, -1), 0.9);
      (SYNONYMS[w] || []).forEach((t) => add(t, 0.7));
    });
    for (let k = 0; k < words.length - 1; k++) add(words[k] + ' ' + words[k + 1], 1.4);
    return { words, terms };
  }

  function keywordScores(q) {
    if (!index) buildIndex();
    const { terms } = queryTerms(q);
    const scores = new Float32Array(core.shows.length);
    const matched = core.shows.map(() => []);
    let maxPossible = 0;
    terms.forEach((w, t) => (maxPossible += w * index.idf(t)));
    index.docs.forEach((d, i) => {
      let sc = 0;
      terms.forEach((w, t) => {
        if (d.all.has(t)) {
          sc += w * index.idf(t);
          matched[i].push(t);
        }
      });
      scores[i] = maxPossible ? sc / maxPossible : 0;
    });
    return { scores, matched };
  }

  // ---------- meaning match (embeddings, runs the model in the browser)
  let extractor = null;
  async function embedQuery(q, meta, onStatus) {
    if (!extractor) {
      onStatus?.('Loading the vibe model (first time only, ~25 MB)…');
      const { pipeline } = await import('@huggingface/transformers');
      extractor = await pipeline('feature-extraction', meta.model, { dtype: 'q8' });
    }
    const out = await extractor(q, { pooling: 'mean', normalize: true });
    return out.data;
  }

  async function vibe(q, { onStatus, limit = 30 } = {}) {
    const { scores: kw, matched } = keywordScores(q);
    const emb = await loadEmbeddings();
    const n = core.shows.length;
    let sem = null;
    if (emb) {
      try {
        const v = await embedQuery(q, emb, onStatus);
        sem = new Float32Array(n);
        const d = emb.dim;
        let max = -1, min = 1;
        for (let i = 0; i < n; i++) {
          let dot = 0;
          const off = i * d;
          for (let k = 0; k < d; k++) dot += v[k] * emb.vectors[off + k];
          dot /= 127;
          sem[i] = dot;
          if (dot > max) max = dot;
          if (dot < min) min = dot;
        }
        const floor = Math.max(min, max - 0.35);
        for (let i = 0; i < n; i++) sem[i] = Math.max(0, (sem[i] - floor) / (max - floor || 1));
      } catch (err) {
        console.warn('Vibe model unavailable, using keywords only', err);
        sem = null;
      }
    }
    const kwMax = Math.max(...kw) || 1;
    const res = [];
    for (let i = 0; i < n; i++) {
      const k = kw[i] / kwMax;
      const pop = core.shows[i].p;
      const score = sem ? 0.6 * sem[i] + 0.3 * k + 0.1 * pop : k > 0 ? 0.85 * k + 0.15 * pop : 0;
      if (score > 0.05) {
        // show "small town", not "small · town · small town"
        const m = [...new Set(matched[i])].sort((a, b) => b.length - a.length);
        const tidy = m.filter((t) => !m.some((o) => o !== t && o.includes(' ') && o.split(' ').includes(t)));
        res.push({ i, score, matched: tidy });
      }
    }
    res.sort((a, b) => b.score - a.score);
    return { results: res.slice(0, limit), usedModel: !!sem, words: queryTerms(q).words };
  }

  function looksLikeTitle(q) {
    const t = titles(q, 1)[0];
    const wordCount = norm(q).split(' ').filter(Boolean).length;
    return t && (t.score >= 0.9 || (t.score >= 0.75 && wordCount <= 2));
  }

  return { titles, vibe, looksLikeTitle };
}
