"""Meaning vectors for "describe the vibe" search.

Run after build_map.py (it follows the show order in web/public/data/shows.json):

    python pipeline/build_embeddings.py

Uses all-MiniLM-L6-v2 (384 numbers per show). The website runs the same model in the browser
(Transformers.js, "Xenova/all-MiniLM-L6-v2") on the user's query, so query and show vectors match.
Vectors are stored as int8 to keep the download small (20k shows is about 7.5 MB).
"""
import argparse
import json

import numpy as np

from common import DEFAULT_DB, WEB_DATA, load_shows, open_db

MODEL = "sentence-transformers/all-MiniLM-L6-v2"
BROWSER_MODEL = "Xenova/all-MiniLM-L6-v2"


def show_text(s):
    parts = [s.get("name", "")]
    if s.get("genres"):
        parts.append(", ".join(s["genres"]))
    if s.get("keywords"):
        parts.append("Themes: " + ", ".join(s["keywords"][:20]))
    if s.get("tagline"):
        parts.append(s["tagline"])
    parts.append(s.get("overview", ""))
    return ". ".join(p for p in parts if p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--out", default=str(WEB_DATA))
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--top", type=int, default=40000,
                    help="only the N most popular shows get vectors (keeps the download small); "
                         "the rest are still found by keyword")
    args = ap.parse_args()

    from sentence_transformers import SentenceTransformer

    core = json.loads((WEB_DATA / "shows.json").read_text(encoding="utf-8"))
    by_id = {s["id"]: s for s in load_shows(open_db(args.db))}
    # shows.json is sorted by popularity, so the first N are the most popular
    texts = [show_text(by_id[s["id"]]) for s in core["shows"][: args.top]]

    model = SentenceTransformer(MODEL)
    vecs = model.encode(texts, batch_size=args.batch, normalize_embeddings=True, show_progress_bar=True)
    q = np.clip(np.round(vecs * 127), -127, 127).astype(np.int8)
    (WEB_DATA / "emb.bin").write_bytes(q.tobytes())
    (WEB_DATA / "emb.json").write_text(json.dumps({"model": BROWSER_MODEL, "dim": int(q.shape[1]), "count": int(q.shape[0])}))
    print(f"Wrote {q.shape[0]:,} x {q.shape[1]} vectors ({q.nbytes / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
