// "My Universe": shows you've watched, saved on this device.
const KEY = 'tvgalaxy.watched.v1';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

export function createUniverse(core) {
  let ids = read(); // TMDB ids, in the order they were marked
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch { /* storage off: keep in memory */ }
  };
  const indices = () => ids.map((id) => core.byId.get(id)).filter((i) => i !== undefined);

  return {
    has: (i) => ids.includes(core.shows[i].id),
    toggle(i) {
      const id = core.shows[i].id;
      ids = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
      save();
    },
    indices,
    /** Minimum spanning tree between watched stars, so the constellation lines look natural. */
    constellation() {
      const pts = indices();
      if (pts.length < 2) return [];
      const inTree = new Set([pts[0]]);
      const edges = [];
      while (inTree.size < pts.length) {
        let best = null;
        for (const a of inTree) {
          for (const b of pts) {
            if (inTree.has(b)) continue;
            const sa = core.shows[a], sb = core.shows[b];
            const d = (sa.x - sb.x) ** 2 + (sa.y - sb.y) ** 2;
            if (!best || d < best[2]) best = [a, b, d];
          }
        }
        inTree.add(best[1]);
        edges.push([best[0], best[1]]);
      }
      return edges;
    },
    stats() {
      const pts = indices();
      const explored = new Set(pts.map((i) => core.shows[i].c));
      let suggestion = null;
      if (pts.length) {
        const cx = pts.reduce((a, i) => a + core.shows[i].x, 0) / pts.length;
        const cy = pts.reduce((a, i) => a + core.shows[i].y, 0) / pts.length;
        const unexplored = core.clusters.filter((c) => !explored.has(c.id));
        unexplored.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
        const target = unexplored[0];
        if (target) {
          const best = core.shows.filter((s) => s.c === target.id).sort((a, b) => b.p - a.p)[0];
          suggestion = { cluster: target, show: best.idx };
        }
      }
      return { count: pts.length, explored: explored.size, total: core.clusters.length, suggestion };
    },
  };
}
