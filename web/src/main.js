import './style.css';
import { loadCore, loadDetails, posterUrl } from './data.js';
import { createMap } from './map.js';
import { createSearch } from './search.js';
import { createUniverse } from './universe.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MOODS = ['small town mystery', 'mind-bending sci-fi', 'cosy feel-good comedy', 'slow-burn crime', 'dark Indian thriller', 'epic fantasy with dragons', 'true story', 'office comedy'];

const core = await loadCore().catch((err) => {
  $('#loading').textContent = err.message;
  throw err;
});
const search = createSearch(core);
const universe = createUniverse(core);
const state = { view: 'explore', current: null, cluster: null, mode: 'title' };

const map = await createMap($('#map'), core, {
  onSelect: (i) => selectShow(i),
  onBackground: () => {
    if (state.view === 'explore' && state.current) clearSelection();
  },
});

$('#loading').classList.add('gone');
// on phones the details panel is a bottom sheet: hide the floating controls while it is open
new MutationObserver(() => document.body.classList.toggle('sheet-open', !$('#side').hidden))
  .observe($('#side'), { attributes: true, attributeFilter: ['hidden'] });
$('#hint').textContent = `Scroll to zoom · drag to move · click a star · ${core.count.toLocaleString()} shows${core.count > 15000 ? ' (zoom in to see more)' : ''}${core.demo ? ' (demo data)' : ''}`;

// ------------------------------------------------------------------ galaxies panel
function renderGalaxies() {
  const list = $('#galaxy-list');
  list.innerHTML = core.clusters
    .map((c) => `<button type="button" class="galaxy ${state.cluster === c.id ? 'on' : ''}" data-c="${c.id}" aria-pressed="${state.cluster === c.id}">
        <span class="dot" style="background:${c.color};box-shadow:0 0 8px ${c.color}"></span>
        <span>${esc(c.name)}</span><span class="count">${c.count.toLocaleString()}</span></button>`)
    .join('') +
    `<p class="muted" style="padding:10px 10px 4px;font-size:11px;margin:0">Data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.${core.demo ? ' <span class="badge">demo data</span>' : ''}</p>`;
  list.querySelectorAll('.galaxy').forEach((b) =>
    b.addEventListener('click', () => {
      const c = +b.dataset.c;
      state.cluster = state.cluster === c ? null : c;
      if (state.view === 'universe') setView('explore');
      state.current = null;
      $('#side').hidden = true;
      map.setHighlight({ cluster: state.cluster });
      if (state.cluster !== null) map.flyToPoints(core.shows.filter((s) => s.c === c).map((s) => s.idx));
      renderGalaxies();
    }),
  );
}
$('#galaxies-toggle').addEventListener('click', (e) => {
  const open = e.currentTarget.getAttribute('aria-expanded') === 'true';
  e.currentTarget.setAttribute('aria-expanded', String(!open));
  $('#galaxy-list').hidden = open;
});
if (window.innerWidth <= 760) $('#galaxies-toggle').click();

// ------------------------------------------------------------------ show panel
function heatColor(r) {
  if (r == null || r === 0) return 'rgba(255,255,255,0.07)';
  const t = Math.max(0, Math.min(1, (r - 6) / 3.2));
  return `hsl(${Math.round(t * 130)}, 70%, ${42 + t * 6}%)`;
}

function metaLine(s, d) {
  const lang = core.languages[s.l] || (s.l || '').toUpperCase();
  const years = s.y0 ? `${s.y0}${d.st === 'Ended' || d.st === 'Canceled' ? (d.y1 && d.y1 !== s.y0 ? '–' + d.y1 : '') : '–'}` : '';
  const bits = [years, d.ns ? `${d.ns} season${d.ns > 1 ? 's' : ''}` : '', (d.nets || []).join(', '), lang];
  if (d.vc >= 20) bits.push(`★ ${d.va.toFixed(1)}`);
  return bits.filter(Boolean).map(esc).join(' · ');
}

async function selectShow(i, { fly = true, push = true } = {}) {
  if (state.view === 'universe') setView('explore', { keepPanel: true });
  state.current = { type: 'show', i };
  state.cluster = null;
  renderGalaxies();
  const s = core.shows[i];
  const color = core.clusters[s.c].color;
  const d = await loadDetails(core, i);
  if (state.current?.i !== i) return;
  const nbs = d.nb.slice(0, 8);
  map.setHighlight({ primary: i, set: nbs.map((n) => n[0]), lines: nbs.map((n) => [i, n[0], color]) });
  if (fly) map.flyToPoints([i, ...nbs.slice(0, 6).map((n) => n[0])], i);
  if (push) history.replaceState(null, '', `#show=${s.id}`);

  const poster = posterUrl(d.poster);
  const watched = universe.has(i);
  const side = $('#side');
  side.hidden = false;
  side.innerHTML = `
    <button type="button" class="close" aria-label="Close">${closeIcon}</button>
    <div class="show-head">
      ${poster ? `<img class="poster" src="${poster}" alt="" loading="lazy">` : `<div class="poster blank" style="background:linear-gradient(160deg,${color}66,#11142A 70%)">no poster</div>`}
      <div>
        <div class="eyebrow" style="color:${color}">${esc(core.clusters[s.c].name)}</div>
        <h2>${esc(s.n)}</h2>
        <div class="meta-line">${metaLine(s, d)}</div>
      </div>
    </div>
    <div>
      <div class="section-title">Nearest stars <small>match % · why</small></div>
      <div class="similar">
        ${nbs.map(([j, pct, why]) => {
          const o = core.shows[j];
          return `<button type="button" class="sim" data-i="${j}">
            <span class="dot" style="background:${core.clusters[o.c].color};margin-top:5px"></span>
            <span><span class="name">${esc(o.n)}</span><div class="why">${esc(why.join(' · ') || 'similar overall')}</div></span>
            <span class="pct">${pct}%</span></button>`;
        }).join('')}
      </div>
    </div>
    <details class="fold" data-fold="about" ${folds.about ? 'open' : ''}>
      <summary>About the show ${chevron}</summary>
      <div class="fold-body">
        ${d.ov ? `<p class="overview">${esc(d.ov)}</p>` : '<p class="muted">No summary on TMDB.</p>'}
        ${s.genreNames.length || d.kw.length ? `<div class="tags">${[...s.genreNames, ...d.kw.slice(0, 8)].map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        ${d.cr.length || d.cast.length ? `<div class="muted">${d.cr.length ? `Created by ${esc(d.cr.join(', '))}` : ''}${d.cr.length && d.cast.length ? '<br>' : ''}${d.cast.length ? `Starring ${esc(d.cast.slice(0, 4).join(', '))}` : ''}</div>` : ''}
        ${d.prov.length ? `<div class="muted">Streaming in India: <b style="color:var(--text)">${esc(d.prov.join(', '))}</b>${d.provLink ? ` · <a href="${esc(d.provLink)}" target="_blank" rel="noopener" style="color:var(--accent)">details</a>` : ''}<br><span style="font-size:11px">Streaming data by JustWatch</span></div>` : ''}
      </div>
    </details>
    ${d.heat ? `<details class="fold" data-fold="ratings" ${folds.ratings ? 'open' : ''}>
      <summary>Episode ratings <small>each square is one episode</small> ${chevron}</summary>
      <div class="fold-body">
        <div>${d.heat.map((row, k) => `<div class="heat-row"><span>S${k + 1}</span>${row.map((r, e) => `<div class="heat-cell" style="background:${heatColor(r)}" title="S${k + 1} E${e + 1}: ${r ?? 'no rating'}"></div>`).join('')}</div>`).join('')}
        <div class="heat-legend"><span>weaker</span><span>stronger</span></div></div>
      </div>
    </details>` : ''}
    <div class="actions">
      <button type="button" class="btn primary ${watched ? 'done' : ''}" id="watch-btn">${watched ? 'Watched ✓' : 'Mark as watched'}</button>
      ${core.demo ? '' : `<a class="btn" href="https://www.themoviedb.org/tv/${s.id}" target="_blank" rel="noopener">Open on TMDB</a>`}
    </div>`;
  side.scrollTop = 0;
  side.querySelector('.close').addEventListener('click', clearSelection);
  side.querySelectorAll('.sim').forEach((b) => b.addEventListener('click', () => selectShow(+b.dataset.i)));
  // remember which sections the user opened, so they stay open for the next show
  side.querySelectorAll('details.fold').forEach((f) => f.addEventListener('toggle', () => { folds[f.dataset.fold] = f.open; }));
  side.querySelector('#watch-btn').addEventListener('click', () => {
    universe.toggle(i);
    selectShow(i, { fly: false });
  });
}

const folds = { about: false, ratings: false };
const chevron = '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const closeIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function clearSelection() {
  state.current = null;
  $('#side').hidden = true;
  map.setHighlight({ cluster: state.cluster });
  history.replaceState(null, '', location.pathname + location.search);
}

// ------------------------------------------------------------------ vibe search
async function runVibe(q, { push = true } = {}) {
  if (state.view === 'universe') setView('explore', { keepPanel: true });
  state.current = { type: 'vibe', q };
  state.cluster = null;
  renderGalaxies();
  const side = $('#side');
  side.hidden = false;
  side.innerHTML = `<div class="results-head"><div class="eyebrow" style="color:var(--accent)">Vibe search</div><h2>“${esc(q)}”</h2></div><p class="muted" id="vibe-status">Searching…</p>`;
  const { results, usedModel } = await search.vibe(q, {
    onStatus: (msg) => { const el = $('#vibe-status'); if (el) el.textContent = msg; },
  });
  if (state.current?.q !== q) return;
  if (push) history.replaceState(null, '', `#vibe=${encodeURIComponent(q)}`);
  const top = results.slice(0, 20);
  map.setHighlight({ set: top.map((r) => r.i) });
  map.flyToPoints(top.slice(0, 10).map((r) => r.i));
  side.innerHTML = `
    <button type="button" class="close" aria-label="Close">${closeIcon}</button>
    <div class="results-head"><div class="eyebrow" style="color:var(--accent)">Vibe search</div><h2>“${esc(q)}”</h2></div>
    <p class="muted" style="margin:0">${top.length ? `${top.length} shows fit best. They glow on the map.` : 'Nothing matched. Try other words, or a mood below the search box.'}
      ${usedModel ? '' : '<br><span style="font-size:11px">Keyword matching only. Build the embeddings for meaning-based search.</span>'}</p>
    <div class="similar">
      ${top.map(({ i, matched }) => {
        const s = core.shows[i];
        const why = matched.length ? matched.slice(0, 4).map((m) => `<mark>${esc(m)}</mark>`).join(' · ') : esc(s.genreNames.join(' · '));
        return `<button type="button" class="sim" data-i="${i}">
          <span class="dot" style="background:${core.clusters[s.c].color};margin-top:5px"></span>
          <span><span class="name">${esc(s.n)}</span><div class="why">${s.y0 || ''} · ${why}</div></span></button>`;
      }).join('')}
    </div>`;
  side.querySelector('.close').addEventListener('click', clearSelection);
  side.querySelectorAll('.sim').forEach((b) => b.addEventListener('click', () => selectShow(+b.dataset.i)));
}

// ------------------------------------------------------------------ search box
const input = $('#q');
const suggest = $('#suggest');
const PLACEHOLDER = window.innerWidth <= 760
  ? { title: 'Search a show title…', vibe: 'Describe a vibe…', auto: 'Title or a vibe…' }
  : { title: 'Search a show title…', vibe: 'Describe a vibe: small town investigation mystery…', auto: 'Search a show, or describe a vibe…' };
input.placeholder = PLACEHOLDER.title;
let active = -1;
let items = [];

function renderSuggest() {
  const q = input.value.trim();
  if (!q) { suggest.hidden = true; items = []; return; }
  const t = state.mode === 'vibe' ? [] : search.titles(q, 7);
  items = [];
  // in Title mode the vibe option only appears when no title matches
  if (state.mode !== 'title' || t.length === 0) items.push({ type: 'vibe', q });
  t.forEach((r) => items.push({ type: 'show', i: r.i }));
  if (state.mode === 'auto' && search.looksLikeTitle(q) && items[0]?.type === 'vibe') items.push(items.shift());
  suggest.innerHTML = items
    .map((it, k) => {
      if (it.type === 'vibe') {
        return `<li role="option" id="opt-${k}" data-k="${k}" class="vibe-row" aria-selected="${k === active}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>
          Find shows that feel like “${esc(it.q)}”</li>`;
      }
      const s = core.shows[it.i];
      return `<li role="option" id="opt-${k}" data-k="${k}" aria-selected="${k === active}">
        <span class="dot" style="background:${core.clusters[s.c].color}"></span>${esc(s.n)}
        <span class="meta">${s.y0 || ''} · ${esc(core.clusters[s.c].name)}</span></li>`;
    })
    .join('');
  suggest.hidden = items.length === 0;
  suggest.querySelectorAll('li').forEach((li) => li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(items[+li.dataset.k]); }));
}

function choose(it) {
  if (!it) return;
  suggest.hidden = true;
  active = -1;
  input.blur();
  if (it.type === 'vibe') runVibe(it.q);
  else { input.value = core.shows[it.i].n; selectShow(it.i); }
}

function submit() {
  const q = input.value.trim();
  if (!q) return;
  if (active >= 0) return choose(items[active]);
  const title = search.titles(q, 1)[0];
  if (state.mode === 'title' || (state.mode === 'auto' && search.looksLikeTitle(q))) {
    if (title) return choose({ type: 'show', i: title.i });
  }
  choose({ type: 'vibe', q });
}

input.addEventListener('input', () => { active = -1; renderSuggest(); });
input.addEventListener('focus', renderSuggest);
input.addEventListener('blur', () => setTimeout(() => (suggest.hidden = true), 120));
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    active = Math.max(-1, Math.min(items.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
    renderSuggest();
    input.setAttribute('aria-activedescendant', active >= 0 ? `opt-${active}` : '');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    submit();
  } else if (e.key === 'Escape') {
    suggest.hidden = true;
  }
});
document.querySelectorAll('.mode button').forEach((b) =>
  b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll('.mode button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    input.placeholder = PLACEHOLDER[state.mode];
    renderSuggest();
    input.focus();
  }),
);
$('#moods').innerHTML = MOODS.map((m) => `<button type="button" class="chip">${esc(m)}</button>`).join('');
$('#moods').querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { input.value = c.textContent; runVibe(c.textContent); }));

// ------------------------------------------------------------------ My Universe
function setView(view, { keepPanel = false } = {}) {
  state.view = view;
  $('#nav-explore').classList.toggle('active', view === 'explore');
  $('#nav-universe').classList.toggle('active', view === 'universe');
  if (view === 'universe') renderUniverse();
  else if (!keepPanel) clearSelection();
}

function renderUniverse() {
  state.current = null;
  state.cluster = null;
  renderGalaxies();
  const pts = universe.indices();
  const st = universe.stats();
  map.setHighlight({ set: pts, lines: universe.constellation().map(([a, b]) => [a, b, '#9FD8FF']) });
  if (pts.length) map.flyToPoints(pts); else map.fit();
  const side = $('#side');
  side.hidden = false;
  const sug = st.suggestion;
  side.innerHTML = `
    <button type="button" class="close" aria-label="Close">${closeIcon}</button>
    <div class="results-head"><div class="eyebrow" style="color:var(--accent)">My Universe</div><h2>Your universe</h2></div>
    ${pts.length ? `
      <div class="stat-grid">
        <div class="stat"><b>${st.count}</b><span>shows watched</span></div>
        <div class="stat"><b>${st.explored}/${st.total}</b><span>galaxies explored</span></div>
      </div>
      ${sug ? `<div class="callout" style="border-color:${sug.cluster.color}66;background:${sug.cluster.color}14">
        <span class="eyebrow" style="color:${sug.cluster.color}">Unexplored galaxy nearby</span>
        <b style="font-family:var(--head);font-size:17px">${esc(sug.cluster.name)}</b>
        <span class="muted">Start with <button type="button" class="sim-link" data-i="${sug.show}" style="background:none;border:0;padding:0;color:var(--accent);font-weight:600">${esc(core.shows[sug.show].n)}</button>.</span></div>` : ''}
      <div class="similar">${pts.slice().reverse().map((i) => `<button type="button" class="sim" data-i="${i}"><span class="dot" style="background:${core.clusters[core.shows[i].c].color};margin-top:5px"></span><span class="name">${esc(core.shows[i].n)}</span></button>`).join('')}</div>`
    : `<p class="muted">Open any show and press “Mark as watched”. Your watched shows light up here and join into a constellation. Everything is saved on this device only.</p>`}`;
  side.querySelector('.close').addEventListener('click', () => setView('explore'));
  side.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => selectShow(+b.dataset.i)));
}

$('#nav-explore').addEventListener('click', () => setView('explore'));
$('#nav-universe').addEventListener('click', () => setView(state.view === 'universe' ? 'explore' : 'universe'));

// ------------------------------------------------------------------ controls + deep links
$('#zoom-in').addEventListener('click', () => map.zoomBy(1.6));
$('#zoom-out').addEventListener('click', () => map.zoomBy(1 / 1.6));
$('#zoom-fit').addEventListener('click', () => map.fit());
window.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
  if (e.key === 'Escape' && document.activeElement !== input) clearSelection();
});

renderGalaxies();
// shareable links: #show=<tmdb id> or #vibe=<words>
function openFromHash() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('show') && core.byId.has(+hash.get('show'))) selectShow(core.byId.get(+hash.get('show')), { push: false });
  else if (hash.get('vibe')) { input.value = hash.get('vibe'); runVibe(hash.get('vibe'), { push: false }); }
}
window.addEventListener('hashchange', openFromHash);
openFromHash();
