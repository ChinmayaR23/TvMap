"""Turn the TMDB cache into the files the website loads.

    python pipeline/build_map.py                 # uses data/tmdb.sqlite
    python pipeline/build_map.py --db data/tmdb_demo.sqlite --demo

Steps
1. Each show becomes 8 feature blocks (themes, genres, creators, cast, language, network, era, format).
   Each block is L2-normalised and scaled by sqrt(weight), then the blocks are joined into one vector.
   So the dot product of two shows = sum over blocks of  weight x (similarity in that block).
2. Similar shows: the 12 highest dot products per show (+ a small bonus when TMDB lists the pair
   as "recommended"), with a per-block breakdown that becomes the "why it matched" reasons.
3. Match %: each pair score is ranked against every show's top-12 scores, mapped to 50-99%.
4. Map: TruncatedSVD -> UMAP for 2-D positions; HDBSCAN on the SVD vectors for galaxies (clusters).
"""
import argparse
import json
import math
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from scipy import sparse

from common import DEFAULT_DB, WEB_DATA, load_shows, open_db

WEIGHTS = {
    "themes": 0.40,
    "genres": 0.25,
    "creators": 0.10,
    "cast": 0.05,
    "language": 0.08,
    "network": 0.04,
    "era": 0.04,
    "format": 0.04,
}
TOP_K = 12
REC_BONUS = 0.05
CHUNK = 500  # shows per details file

LANG_NAMES = {
    "en": "English", "hi": "Hindi", "ta": "Tamil", "te": "Telugu", "ml": "Malayalam", "kn": "Kannada",
    "mr": "Marathi", "bn": "Bengali", "ko": "Korean", "ja": "Japanese", "zh": "Chinese", "es": "Spanish",
    "de": "German", "fr": "French", "it": "Italian", "tr": "Turkish", "pt": "Portuguese", "th": "Thai",
    "da": "Danish", "sv": "Swedish", "no": "Norwegian", "ru": "Russian", "pl": "Polish", "ar": "Arabic",
    "nl": "Dutch", "he": "Hebrew", "tl": "Filipino", "id": "Indonesian",
}
LANG_GROUP = {"hi": "indian", "ta": "indian", "te": "indian", "ml": "indian", "kn": "indian", "mr": "indian",
              "bn": "indian", "pa": "indian", "gu": "indian", "da": "nordic", "sv": "nordic", "no": "nordic",
              "zh": "chinese", "cn": "chinese", "es": "spanish", "pt": "spanish"}
GROUP_NAMES = {"indian": "Indian", "nordic": "Nordic", "chinese": "Chinese", "spanish": "Spanish-language"}

PALETTE = ["#F5A524", "#4CC9F0", "#B794FF", "#FF6B8B", "#4ADE80", "#FF8A3D", "#FFD84D", "#5EEAD4",
           "#F472B6", "#93C5FD", "#A3E635", "#FDA4AF", "#C4B5FD", "#FCD34D", "#67E8F9", "#FB923C"]


# ---------------------------------------------------------------- feature blocks
def multi_hot(lists, min_df=1, idf=False, max_features=None):
    df = Counter(t for lst in lists for t in set(lst))
    vocab = [t for t, c in df.most_common(max_features) if c >= min_df]
    index = {t: i for i, t in enumerate(vocab)}
    n = len(lists)
    rows, cols, vals = [], [], []
    for r, lst in enumerate(lists):
        for t in set(lst):
            j = index.get(t)
            if j is None:
                continue
            rows.append(r)
            cols.append(j)
            vals.append(math.log(n / df[t]) + 1.0 if idf else 1.0)
    m = sparse.csr_matrix((vals, (rows, cols)), shape=(n, max(len(vocab), 1)), dtype=np.float32)
    return normalize_rows(m), vocab, df


def normalize_rows(m):
    norms = np.sqrt(np.asarray(m.multiply(m).sum(axis=1)).ravel())
    norms[norms == 0] = 1.0
    return sparse.diags(1.0 / norms).dot(m).tocsr().astype(np.float32)


def year_of(s, key="first_air_date"):
    v = s.get(key) or ""
    return int(v[:4]) if v[:4].isdigit() else None


def era_tokens(s):
    y = year_of(s)
    if not y:
        return []
    b = (y // 5) * 5
    return [f"e{b}", f"e{b - 5}~", f"e{b + 5}~"]  # neighbours share a softer token


def format_tokens(s):
    rt = (s.get("episode_run_time") or [0])[0] or 0
    if rt:
        rt_b = "rt15" if rt <= 15 else "rt30" if rt <= 32 else "rt45" if rt <= 48 else "rt60" if rt <= 68 else "rt90"
    else:
        rt_b = None
    ns = s.get("number_of_seasons") or 0
    ns_b = "s1" if ns <= 1 else "s3" if ns <= 3 else "s7" if ns <= 7 else "s8+"
    toks = [ns_b] + ([rt_b] if rt_b else [])
    if "Animation" in s.get("genres", []):
        toks.append("animated")
    if s.get("type") == "Miniseries":
        toks.append("mini")
    return toks


def language_tokens(s):
    lang = s.get("original_language") or "xx"
    toks = ["l_" + lang]
    if lang in LANG_GROUP:
        toks.append("g_" + LANG_GROUP[lang])
    return toks


def era_matrix(shows):
    """Soft era encoding: exact 5-year bucket weight 1, neighbouring buckets weight 0.5."""
    lists = [era_tokens(s) for s in shows]
    buckets = sorted({t.rstrip("~") for lst in lists for t in lst})
    idx = {b: i for i, b in enumerate(buckets)}
    rows, cols, vals = [], [], []
    for r, lst in enumerate(lists):
        for t in lst:
            soft = t.endswith("~")
            rows.append(r)
            cols.append(idx[t.rstrip("~")])
            vals.append(0.5 if soft else 1.0)
    m = sparse.csr_matrix((vals, (rows, cols)), shape=(len(shows), max(len(buckets), 1)), dtype=np.float32)
    return normalize_rows(m)


# ---------------------------------------------------------------- clusters
def name_cluster(members, shows, kw_df, n_total):
    langs = Counter(shows[i].get("original_language") for i in members)
    groups = Counter(LANG_GROUP.get(shows[i].get("original_language"), "") for i in members)
    genres = Counter(g for i in members for g in shows[i].get("genres", []) if g not in ("Drama",))
    if not genres:
        genres = Counter(g for i in members for g in shows[i].get("genres", []))
    kws = Counter(k for i in members for k in shows[i].get("keywords", []))
    size = len(members)

    prefix = ""
    lang, lc = langs.most_common(1)[0]
    grp, gc = groups.most_common(1)[0]
    if grp and gc / size >= 0.6:
        prefix = GROUP_NAMES[grp]
    elif lang != "en" and lc / size >= 0.6:
        prefix = LANG_NAMES.get(lang, lang.upper())

    # second genre only if it is common in this galaxy too
    ranked = genres.most_common(2)
    top_genres = [g for g, c in ranked if c >= 0.4 * size] or [ranked[0][0]] if ranked else []
    if prefix == "Japanese" and "Animation" in top_genres:
        return "Anime"
    if "Animation" in top_genres and prefix == "":
        other = [g for g in top_genres if g != "Animation"]
        return "Animation · " + other[0] if other else "Animation"
    # most characteristic keyword: frequent here, rare elsewhere
    best_kw, best_lift = None, 0
    for k, c in kws.items():
        if c < max(2, size * 0.15):
            continue
        lift = (c / size) / (kw_df[k] / n_total)
        if lift > best_lift:
            best_kw, best_lift = k, lift
    label = " / ".join(top_genres) if top_genres else "Mixed"
    if prefix:
        label = f"{prefix} {top_genres[0] if top_genres else 'Drama'}"
    if best_kw and best_lift > 3 and len(label) < 22:
        label += f" · {best_kw}"
    return label


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--out", default=str(WEB_DATA))
    ap.add_argument("--min-votes", type=int, default=10)
    ap.add_argument("--min-votes-indian", type=int, default=2,
                    help="Indian shows get few TMDB votes, so they need a lower bar")
    ap.add_argument("--keep-talk", action="store_true", help="keep News and Talk Show types")
    ap.add_argument("--min-cluster", type=int, default=0, help="HDBSCAN min cluster size (0 = auto)")
    ap.add_argument("--demo", action="store_true", help="mark output as demo data")
    args = ap.parse_args()
    t0 = time.time()

    con = open_db(args.db)
    shows = [
        s for s in load_shows(con)
        if s.get("name") and not s.get("adult")
        and s.get("vote_count", 0) >= (
            args.min_votes_indian if LANG_GROUP.get(s.get("original_language")) == "indian" else args.min_votes)
        and (s.get("genres") or s.get("keywords"))
        and (args.keep_talk or s.get("type") not in ("News", "Talk Show"))
    ]
    shows.sort(key=lambda s: s.get("popularity", 0), reverse=True)
    n = len(shows)
    if n < 10:
        raise SystemExit(f"Only {n} usable shows in {args.db}. Run fetch_tmdb.py first (or make_demo_data.py).")
    print(f"{n:,} shows")
    id_to_idx = {s["id"]: i for i, s in enumerate(shows)}

    small = n < 500
    themes, kw_vocab, kw_df = multi_hot([s.get("keywords", []) for s in shows], min_df=1 if small else 2,
                                        idf=True, max_features=8000)
    blocks = {
        "themes": themes,
        "genres": multi_hot([s.get("genres", []) for s in shows])[0],
        "creators": multi_hot([s.get("created_by", []) for s in shows], min_df=1 if small else 2)[0],
        "cast": multi_hot([s.get("cast", [])[:6] for s in shows], min_df=1 if small else 2, idf=True)[0],
        "language": multi_hot([language_tokens(s) for s in shows])[0],
        "network": multi_hot([s.get("networks", [])[:2] for s in shows])[0],
        "era": era_matrix(shows),
        "format": multi_hot([format_tokens(s) for s in shows])[0],
    }
    X = sparse.hstack([blocks[b] * math.sqrt(WEIGHTS[b]) for b in WEIGHTS]).tocsr().astype(np.float32)
    print(f"vectors: {X.shape[1]:,} dimensions")

    # ---- nearest neighbours (exact, chunked)
    recs = [set(id_to_idx[r] for r in s.get("recommendations", []) if r in id_to_idx) for s in shows]
    k = min(TOP_K if n <= 50000 else 10, n - 1)
    nb_idx = np.zeros((n, k), dtype=np.int32)
    nb_score = np.zeros((n, k), dtype=np.float32)
    XT = X.T.tocsc()
    rows_per_chunk = max(64, min(1000, int(4e7 // n)))  # keeps each dense block around 160 MB
    for start in range(0, n, rows_per_chunk):
        stop = min(n, start + rows_per_chunk)
        if start and start % (rows_per_chunk * 50) == 0:
            print(f"  neighbours {start:,}/{n:,}")
        S = (X[start:stop] @ XT).toarray()
        for r in range(stop - start):
            i = start + r
            S[r, i] = -1
            for j in recs[i]:
                S[r, j] += REC_BONUS
        top = np.argpartition(-S, k, axis=1)[:, :k] if n - 1 > k else np.argsort(-S, axis=1)[:, :k]
        for r in range(stop - start):
            order = top[r][np.argsort(-S[r, top[r]])]
            nb_idx[start + r] = order
            nb_score[start + r] = S[r, order]
    calib = np.sort(nb_score.ravel())

    def match_pct(score):
        pct = np.searchsorted(calib, score, side="right") / len(calib)
        return int(round(50 + 49 * pct))

    # per-block contributions for every neighbour pair (vectorised)
    I = np.repeat(np.arange(n), k)
    J = nb_idx.ravel()
    contrib = {}
    for b, m in blocks.items():
        parts = []
        for s0 in range(0, len(I), 200000):
            ii, jj = I[s0:s0 + 200000], J[s0:s0 + 200000]
            parts.append(np.asarray(m[ii].multiply(m[jj]).sum(axis=1)).ravel())
        contrib[b] = WEIGHTS[b] * np.concatenate(parts)

    kw_idf = {t: math.log(n / kw_df[t]) + 1 for t in kw_df}

    def reasons(i, j, p):
        a, b = shows[i], shows[j]
        out = []
        shared_kw = sorted(set(a.get("keywords", [])) & set(b.get("keywords", [])), key=lambda t: -kw_idf.get(t, 0))
        if shared_kw:
            out.append(" · ".join(shared_kw[:3]))
        shared_g = [g for g in a.get("genres", []) if g in b.get("genres", [])]
        if shared_g and contrib["genres"][p] > 0.1:
            out.append(" · ".join(shared_g[:2]))
        cr = set(a.get("created_by", [])) & set(b.get("created_by", []))
        if cr:
            out.append("Same creator: " + sorted(cr)[0])
        cast = [c for c in a.get("cast", [])[:6] if c in b.get("cast", [])[:6]]
        if cast:
            out.append("Cast: " + cast[0])
        la, lb = a.get("original_language"), b.get("original_language")
        if la == lb and la != "en":
            out.append("Both " + LANG_NAMES.get(la, la))
        if j in recs[i] or i in recs[j]:
            out.append("Viewers watch both")
        return out[:4]

    # ---- 2-D map + galaxies
    from sklearn.decomposition import TruncatedSVD
    import umap
    import hdbscan

    dims = max(2, min(64, n - 2, X.shape[1] - 1))
    Z = TruncatedSVD(n_components=dims, random_state=42).fit_transform(X)
    Z /= np.linalg.norm(Z, axis=1, keepdims=True) + 1e-9
    # larger min_dist/spread keep thousands of stars from piling into one bright core
    xy = umap.UMAP(n_neighbors=min(15, n - 1) if small else 25, min_dist=0.12 if small else 0.45,
                   spread=1.0 if small else 1.8, metric="cosine", random_state=42,
                   init="random" if small else "spectral").fit_transform(Z)
    xy -= xy.min(axis=0)
    xy /= xy.max(axis=0).max() + 1e-9
    xy = 40 + xy * 920  # world units 40..960

    min_cluster = args.min_cluster or (3 if small else max(15, n // 350 if n <= 30000 else n // 400))
    if n > 30000:
        # on very large maps cluster the 2-D layout itself: much faster, and galaxies match what you see
        labels = hdbscan.HDBSCAN(min_cluster_size=min_cluster, min_samples=10).fit_predict(xy)
    else:
        labels = hdbscan.HDBSCAN(min_cluster_size=min_cluster, min_samples=max(2, min_cluster // 3)).fit_predict(Z)
    for i in np.where(labels < 0)[0]:  # noise: borrow the label of the nearest clustered neighbour
        for j in nb_idx[i]:
            if labels[j] >= 0:
                labels[i] = labels[j]
                break
    if (labels < 0).all():
        labels[:] = 0
    labels[labels < 0] = labels.max() + 1
    uniq = sorted(set(labels.tolist()), key=lambda c: -int((labels == c).sum()))
    remap = {c: i for i, c in enumerate(uniq)}
    labels = np.array([remap[c] for c in labels])

    clusters = []
    for c in range(len(uniq)):
        members = np.where(labels == c)[0]
        cx, cy = xy[members].mean(axis=0)
        spread = float(np.percentile(np.linalg.norm(xy[members] - [cx, cy], axis=1), 80)) if len(members) > 1 else 20
        clusters.append({
            "id": c,
            "name": name_cluster(members.tolist(), shows, kw_df, n),
            "color": PALETTE[c % len(PALETTE)],
            "x": round(float(cx), 1), "y": round(float(cy), 1),
            "r": round(max(spread, 18.0), 1),
            "count": int(len(members)),
        })
    print(f"{len(clusters)} galaxies")

    # ---- write files
    out = Path(args.out)
    (out / "details").mkdir(parents=True, exist_ok=True)
    for f in (out / "details").glob("*.json"):
        f.unlink()
    genre_vocab = sorted({g for s in shows for g in s.get("genres", [])})
    g_index = {g: i for i, g in enumerate(genre_vocab)}
    kw_core = sorted({kw for s in shows for kw in s.get("keywords", [])[:15]})
    k_index = {kw: i for i, kw in enumerate(kw_core)}
    pops = np.array([s.get("popularity", 0) for s in shows], dtype=float)
    pop_rank = (np.argsort(np.argsort(-pops)) / max(1, n - 1))

    core = {
        "version": 1,
        "generated": time.strftime("%Y-%m-%d"),
        "demo": bool(args.demo),
        "count": n,
        "chunk": CHUNK,
        "weights": WEIGHTS,
        "genres": genre_vocab,
        "languages": LANG_NAMES,
        "clusters": clusters,
        # shows are sorted by popularity, so the index is also the popularity rank
        "shows": [
            {
                "id": s["id"],
                "n": s["name"],
                "x": round(float(xy[i, 0]), 1),
                "y": round(float(xy[i, 1]), 1),
                "c": int(labels[i]),
                "p": round(float(1 - pop_rank[i]), 3),
                "y0": year_of(s),
                "l": s.get("original_language"),
                "g": [g_index[g] for g in s.get("genres", [])],
            }
            for i, s in enumerate(shows)
        ],
    }
    (out / "shows.json").write_text(json.dumps(core, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    # keywords are only needed for vibe search, so they live in their own file loaded on demand
    kw_file = {"keywords": kw_core, "k": [[k_index[kw] for kw in s.get("keywords", [])[:15]] for s in shows]}
    (out / "kw.json").write_text(json.dumps(kw_file, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    seasons = defaultdict(dict)
    for sid, num, js in con.execute("SELECT show_id, season, json FROM seasons"):
        seasons[sid][num] = json.loads(js)

    for start in range(0, n, CHUNK):
        chunk = {}
        for i in range(start, min(n, start + CHUNK)):
            s = shows[i]
            heat = None
            if s["id"] in seasons:
                heat = [[e[1] if e[2] >= 5 else None for e in seasons[s["id"]][num]]
                        for num in sorted(seasons[s["id"]]) if seasons[s["id"]][num]]
            nbs = []
            for t in range(k):
                j = int(nb_idx[i, t])
                p = i * k + t
                nbs.append([j, match_pct(nb_score[i, t]), reasons(i, j, p)])
            chunk[i] = {
                "ov": s.get("overview", ""),
                "y1": year_of(s, "last_air_date"),
                "st": s.get("status", ""),
                "ns": s.get("number_of_seasons", 0),
                "ne": s.get("number_of_episodes", 0),
                "rt": (s.get("episode_run_time") or [None])[0],
                "va": s.get("vote_average", 0),
                "vc": s.get("vote_count", 0),
                "nets": s.get("networks", [])[:3],
                "cr": s.get("created_by", [])[:3],
                "cast": s.get("cast", [])[:6],
                "poster": s.get("poster_path"),
                "prov": s.get("providers", []),
                "provLink": s.get("providers_link"),
                "kw": s.get("keywords", [])[:20],
                "nb": nbs,
                "heat": heat,
            }
        (out / "details" / f"{start // CHUNK}.json").write_text(
            json.dumps(chunk, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    print(f"Wrote {out}/shows.json and {math.ceil(n / CHUNK)} detail files in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
