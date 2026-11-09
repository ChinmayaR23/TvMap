// The galaxy: WebGL rendering (PixiJS) of every show as a glowing star, with pan / zoom / pinch,
// galaxy nebulas, labels that appear as you zoom in, highlight lines and click-to-select.
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';

const WORLD = 1000;
const MAX_LABELS = 140;

function radialTexture(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, a]) => grad.addColorStop(o, `rgba(255,255,255,${a})`));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return Texture.from(c);
}

export async function createMap(el, core, { onSelect, onBackground }) {
  const app = new Application();
  await app.init({
    // WebGL explicitly: WebGPU start-up is slow or broken on many Android WebViews
    preference: 'webgl',
    resizeTo: el,
    background: '#05060F',
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  });
  el.appendChild(app.canvas);

  const starTex = radialTexture(64, [[0, 1], [0.12, 0.95], [0.25, 0.45], [0.55, 0.08], [1, 0]]);
  const nebTex = radialTexture(256, [[0, 0.55], [0.4, 0.22], [0.75, 0.05], [1, 0]]);
  const dustTex = radialTexture(8, [[0, 1], [0.6, 0.4], [1, 0]]);

  // background dust (slow parallax)
  const dust = new Container();
  app.stage.addChild(dust);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < 500; i++) {
    const d = new Sprite(dustTex);
    d.anchor.set(0.5);
    d.x = rnd() * 3000 - 1000;
    d.y = rnd() * 3000 - 1000;
    d.scale.set(rnd() < 0.85 ? 0.18 : 0.32);
    d.alpha = 0.15 + rnd() * 0.45;
    dust.addChild(d);
  }

  const world = new Container();
  app.stage.addChild(world);
  const nebLayer = new Container();
  const lineLayer = new Graphics();
  const starLayer = new Container();
  const extraLayer = new Container();
  world.addChild(nebLayer, lineLayer, starLayer, extraLayer);
  let shown = 0; // stars[0..shown) are in starLayer
  const labelLayer = new Container(); // screen space
  app.stage.addChild(labelLayer);

  const colorOf = (s) => core.clusters[s.c]?.color || '#9FD8FF';
  const NEB_ALPHA = core.clusters.length > 12 ? 0.16 : 0.32;

  core.clusters.forEach((c) => {
    const n = new Sprite(nebTex);
    n.anchor.set(0.5);
    n.position.set(c.x, c.y);
    n.width = n.height = c.r * 2.8;
    n.tint = c.color;
    n.alpha = NEB_ALPHA;
    n.blendMode = 'add';
    nebLayer.addChild(n);
    c._sprite = n;
  });

  // with thousands of stars, shrink them and stop additive blending, or the centre burns out to white
  // Level of detail: shows are sorted by popularity, so index = rank. Zoomed out we draw only the
  // top BASE_VISIBLE; zooming in reveals more. Searched / selected shows are always drawn.
  const N = core.shows.length;
  const BASE_VISIBLE = 15000;
  let visibleCount = N;
  const isVisible = (i) => i < visibleCount || focus.has(i);
  const crowd = N > 1000;
  const density = Math.max(0.2, Math.min(1, Math.sqrt(400 / Math.min(N, BASE_VISIBLE))));
  const stars = core.shows.map((s) => {
    const sp = new Sprite(starTex);
    sp.anchor.set(0.5);
    sp.position.set(s.x, s.y);
    sp.tint = colorOf(s);
    sp.blendMode = crowd ? 'normal' : 'add';
    sp._base = (0.12 + 0.28 * s.p * s.p) * density * (crowd ? 1.6 : 1);
    return sp;
  });

  // ---------- spatial grid for clicks / labels
  const CELL = 20;
  const grid = new Map();
  core.shows.forEach((s, i) => {
    const key = `${Math.floor(s.x / CELL)},${Math.floor(s.y / CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  function nearest(wx, wy, radius) {
    let best = -1, bd = radius * radius;
    const r = Math.ceil(radius / CELL);
    const cx = Math.floor(wx / CELL), cy = Math.floor(wy / CELL);
    for (let gx = cx - r; gx <= cx + r; gx++) {
      for (let gy = cy - r; gy <= cy + r; gy++) {
        for (const i of grid.get(`${gx},${gy}`) || []) {
          const s = core.shows[i];
          const d = (s.x - wx) ** 2 + (s.y - wy) ** 2;
          if (d < bd && emph[i] > 0.3 && isVisible(i)) { bd = d; best = i; }
        }
      }
    }
    return best;
  }

  // ---------- view state
  let minScale = 0.5;
  function fitScale() {
    return Math.min(app.screen.width, app.screen.height - 140) / WORLD * 0.92;
  }
  const TOP_PAD = 60; // keep the galaxy below the search bar
  function setView(scale, cx, cy) {
    world.scale.set(scale);
    world.position.set(app.screen.width / 2 - cx * scale, app.screen.height / 2 - cy * scale);
    changed();
  }
  function viewCenter() {
    const s = world.scale.x;
    return [(app.screen.width / 2 - world.x) / s, (app.screen.height / 2 - world.y) / s, s];
  }
  function fit() {
    minScale = fitScale() * 0.6;
    animateTo(fitScale(), WORLD / 2, WORLD / 2 - TOP_PAD / fitScale());
  }

  let anim = null;
  function animateTo(scale, cx, cy, ms = 650) {
    const [x0, y0, s0] = viewCenter();
    const t0 = performance.now();
    anim = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const s = Math.exp(Math.log(s0) + (Math.log(scale) - Math.log(s0)) * e);
      setView(s, x0 + (cx - x0) * e, y0 + (cy - y0) * e);
      if (t >= 1) anim = null;
    };
  }

  function zoomAt(factor, sx, sy) {
    const s0 = world.scale.x;
    const s1 = Math.max(minScale, Math.min(60, s0 * factor));
    const wx = (sx - world.x) / s0, wy = (sy - world.y) / s0;
    world.scale.set(s1);
    world.position.set(sx - wx * s1, sy - wy * s1);
    changed();
  }

  // ---------- input: drag, wheel, pinch, click
  const pointers = new Map();
  let dragged = false, pinchDist = 0, downAt = null;
  const canvas = app.canvas;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged = false;
    downAt = { x: e.clientX, y: e.clientY };
    anim = null;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return hover(e);
    if (pointers.size === 1) {
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) dragged = true;
      world.x += dx;
      world.y += dy;
      changed();
    } else if (pointers.size === 2) {
      p.x = e.clientX; p.y = e.clientY;
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist) zoomAt(d / pinchDist, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinchDist = d;
      dragged = true;
      return;
    }
    p.x = e.clientX; p.y = e.clientY;
  });
  const end = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    pinchDist = 0;
    if (!dragged && pointers.size === 0 && e.type === 'pointerup') {
      const rect = canvas.getBoundingClientRect();
      const s = world.scale.x;
      const wx = (e.clientX - rect.left - world.x) / s, wy = (e.clientY - rect.top - world.y) / s;
      const i = nearest(wx, wy, (e.pointerType === 'touch' ? 22 : 14) / s);
      if (i >= 0) onSelect(i);
      else onBackground?.();
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    anim = null;
    const rect = canvas.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  function hover(e) {
    const rect = canvas.getBoundingClientRect();
    const s = world.scale.x;
    const i = nearest((e.clientX - rect.left - world.x) / s, (e.clientY - rect.top - world.y) / s, 12 / s);
    canvas.style.cursor = i >= 0 ? 'pointer' : 'grab';
    if (i !== hoverIdx) { hoverIdx = i; restyled(); }
  }
  let hoverIdx = -1;

  // ---------- highlight
  const emph = new Float32Array(core.shows.length).fill(1);
  let focus = new Set();     // shows that keep their label + glow
  let primary = -1;
  let activeCluster = null;
  let lines = [];            // [[i, j, color]]

  function setHighlight({ set = null, primary: p = -1, lines: ls = [], cluster = null } = {}) {
    primary = p;
    lines = ls;
    activeCluster = cluster;
    focus = new Set(set || []);
    if (p >= 0) focus.add(p);
    const anyFocus = focus.size > 0;
    core.shows.forEach((s, i) => {
      if (anyFocus) emph[i] = focus.has(i) ? 1 : 0.13;
      else if (cluster !== null) emph[i] = s.c === cluster ? 1 : 0.13;
      else emph[i] = 1;
    });
    core.clusters.forEach((c) => {
      c._sprite.alpha = cluster !== null ? (c.id === cluster ? 0.45 : 0.06) : anyFocus ? NEB_ALPHA * 0.45 : NEB_ALPHA;
    });
    drawLines();
    restyled();
  }

  function drawLines() {
    lineLayer.clear();
    for (const [i, j, color] of lines) {
      const a = core.shows[i], b = core.shows[j];
      lineLayer.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: color || '#9FD8FF', alpha: 0.55, pixelLine: true });
    }
  }

  // ---------- labels
  const pool = [];
  for (let k = 0; k < MAX_LABELS; k++) {
    const t = new Text({ text: '', style: { fontFamily: 'Inter, sans-serif', fontSize: 11, fill: '#E8EAF6' } });
    t.visible = false;
    t.resolution = Math.min(window.devicePixelRatio || 1, 2);
    labelLayer.addChild(t);
    pool.push(t);
  }
  const clusterLabels = core.clusters.map((c) => {
    const t = new Text({
      text: c.name.toUpperCase(),
      style: { fontFamily: 'Space Grotesk, sans-serif', fontSize: 12, fill: c.color, letterSpacing: 2, fontWeight: '600' },
    });
    t.anchor.set(0.5);
    t.resolution = Math.min(window.devicePixelRatio || 1, 2);
    labelLayer.addChild(t);
    return t;
  });
  let assigned = []; // [labelIdx -> showIdx]

  function chooseLabels() {
    const s = world.scale.x;
    const W = app.screen.width, H = app.screen.height;
    const zoomRatio = s / fitScale();
    const budget = Math.min(MAX_LABELS, Math.round(14 * zoomRatio * zoomRatio));
    const cand = [];
    const consider = (i) => {
      const sh = core.shows[i];
      const x = sh.x * s + world.x, y = sh.y * s + world.y;
      if (x < -50 || y < -20 || x > W + 50 || y > H + 20) return;
      if (emph[i] < 0.5) return;
      const prio = (focus.has(i) ? 10 : 0) + (i === primary ? 10 : 0) + (i === hoverIdx ? 20 : 0) + sh.p;
      cand.push([prio, i, x, y]);
    };
    for (let i = 0; i < Math.min(visibleCount, N); i++) consider(i);
    focus.forEach((i) => { if (i >= visibleCount) consider(i); });
    cand.sort((a, b) => b[0] - a[0]);
    const taken = new Set();
    assigned = [];
    for (const [prio, i, x, y] of cand) {
      if (assigned.length >= MAX_LABELS) break;
      if (prio < 10 && assigned.length >= budget) break;
      const key = `${Math.floor(x / 120)},${Math.floor(y / 18)}`;
      if (taken.has(key) && prio < 20) continue;
      taken.add(key);
      assigned.push(i);
    }
  }

  let dirty = true, lastPick = 0, styleDirty = true, lastS = 0;
  function changed() { dirty = true; }
  function restyled() { styleDirty = true; dirty = true; }

  app.ticker.add(() => {
    const now = performance.now();
    if (anim) anim(now);
    if (!dirty) return;
    dirty = false;
    const s = world.scale.x;
    dust.position.set(world.x * 0.15, world.y * 0.15);
    const sizeK = Math.pow(s, -0.65) * 2.4;
    const zr = s / fitScale();
    visibleCount = N <= BASE_VISIBLE ? N : Math.min(N, Math.round(BASE_VISIBLE * zr * zr));
    // panning only moves the world container: re-style the stars only when zoom or highlight changed
    // (small zoom steps are skipped: the stars already scale with the world, the difference is invisible)
    const restyle = styleDirty || Math.abs(s / (lastS || s) - 1) > 0.05 || !lastS;
    styleDirty = false;
    if (restyle) lastS = s;
    if (restyle) {
      // only the drawn stars live in the scene: the top `shown` in starLayer, plus searched /
      // selected stars beyond that in extraLayer
      const want = Math.min(visibleCount, N);
      while (shown < want) starLayer.addChild(stars[shown++]);
      while (shown > want) { starLayer.removeChildAt(starLayer.children.length - 1); shown--; }
      extraLayer.removeChildren();
      focus.forEach((i) => { if (i >= shown) extraLayer.addChild(stars[i]); });
      const style = (i) => {
        const sp = stars[i];
        const big = i === primary ? 2.0 : i === hoverIdx ? 1.6 : focus.has(i) ? 1.3 : 1;
        sp.scale.set(sp._base * sizeK * big);
        sp.alpha = emph[i];
      };
      for (let i = 0; i < shown; i++) style(i);
      focus.forEach((i) => { if (i >= shown) style(i); });
    }
    if (now - lastPick > 90 || !assigned.length) { chooseLabels(); lastPick = now; } else { dirty = true; }
    pool.forEach((t, k) => {
      const i = assigned[k];
      if (i === undefined) { t.visible = false; return; }
      const sh = core.shows[i];
      if (t.text !== sh.n) t.text = sh.n;
      t.visible = true;
      t.style.fontWeight = i === primary ? '700' : '400';
      t.style.fontSize = i === primary ? 14 : 11;
      t.alpha = i === primary || i === hoverIdx ? 1 : focus.has(i) ? 0.95 : 0.72;
      t.position.set(Math.round(sh.x * s + world.x + 7), Math.round(sh.y * s + world.y - 7));
    });
    // galaxy names: biggest galaxies first, skip any that would overlap a name already placed
    const zoomRatio = s / fitScale();
    const placed = [];
    clusterLabels.forEach((t, c) => {
      const cl = core.clusters[c];
      t.position.set(cl.x * s + world.x, (cl.y - cl.r * 0.6) * s + world.y);
      const faded = (activeCluster !== null && activeCluster !== c) || focus.size > 0;
      const box = [t.x - t.width / 2 - 6, t.y - 9, t.x + t.width / 2 + 6, t.y + 9];
      const hit = placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      const show = activeCluster === c || (!hit && zoomRatio <= 3.5);
      if (show) placed.push(box);
      t.alpha = !show ? 0 : faded && activeCluster !== c ? 0.25 : 0.9;
    });
  });

  new ResizeObserver(() => restyled()).observe(el);
  setView(fitScale(), WORLD / 2, WORLD / 2 - TOP_PAD / fitScale());
  minScale = fitScale() * 0.6;

  return {
    setHighlight,
    visibleCount: () => Math.min(visibleCount, N),
    fit,
    zoomBy: (f) => zoomAt(f, app.screen.width / 2, app.screen.height / 2),
    flyTo(i, zoom = 6) {
      const sh = core.shows[i];
      const target = Math.max(world.scale.x, fitScale() * zoom);
      // keep the star clear of the right-hand panel on wide screens
      const shift = app.screen.width > 900 ? 210 / target : 0;
      const down = app.screen.width <= 760 ? 120 / target : 0;
      animateTo(target, sh.x + shift, sh.y + down);
    },
    /** Zoom so these stars fit in the free part of the screen (not under the panels). */
    flyToPoints(idxs) {
      if (!idxs.length) return;
      const xs = idxs.map((i) => core.shows[i].x), ys = idxs.map((i) => core.shows[i].y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const W = app.screen.width, H = app.screen.height, phone = W <= 760;
      // free area in screen px: [left, top, right, bottom]
      const area = phone ? [20, 150, W - 20, H * 0.38] : [W > 900 ? 290 : 20, 140, W - (W > 900 ? 440 : 20), H - 80];
      const aw = area[2] - area[0], ah = area[3] - area[1];
      let s = Math.min(aw / Math.max(40, x1 - x0), ah / Math.max(40, y1 - y0)) * 0.85;
      s = Math.max(fitScale() * 0.9, Math.min(s, fitScale() * 10));
      // centre of the free area, converted to a world-space centre for the whole screen
      const cx = (x0 + x1) / 2 - ((area[0] + area[2]) / 2 - W / 2) / s;
      const cy = (y0 + y1) / 2 - ((area[1] + area[3]) / 2 - H / 2) / s;
      animateTo(s, cx, cy);
    },
  };
}
