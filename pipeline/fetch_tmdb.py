"""Download the most popular TV shows from TMDB into data/tmdb.sqlite.

Usage:
    export TMDB_TOKEN="<your API Read Access Token>"
    python pipeline/fetch_tmdb.py --limit 20000

It can be stopped (Ctrl+C) and run again: shows already in the cache are skipped.
"""
import argparse
import datetime as dt
import gzip
import io
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from common import DEFAULT_DB, Tmdb, open_db

APPEND = "keywords,aggregate_credits,watch/providers,content_ratings,recommendations"


def candidate_ids_from_export(limit):
    """TMDB publishes a daily file listing every TV series id with its popularity.
    limit=None takes every series in the file."""
    import requests

    for days_back in range(1, 5):
        day = dt.date.today() - dt.timedelta(days=days_back)
        url = f"https://files.tmdb.org/p/exports/tv_series_ids_{day:%m_%d_%Y}.json.gz"
        r = requests.get(url, timeout=60)
        if r.status_code != 200:
            continue
        rows = []
        with gzip.open(io.BytesIO(r.content), "rt", encoding="utf-8") as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
        rows.sort(key=lambda x: x.get("popularity", 0), reverse=True)
        print(f"Export {day}: {len(rows):,} series listed")
        return [x["id"] for x in (rows if limit is None else rows[:limit])]
    return None


def candidate_ids_from_discover(tmdb, limit):
    ids = []
    for page in range(1, 501):
        data = tmdb.get("/discover/tv", sort_by="popularity.desc", page=page, include_adult="false")
        if not data or not data.get("results"):
            break
        ids += [x["id"] for x in data["results"]]
        if len(ids) >= limit:
            break
    return ids[:limit]


def extra_language_ids(tmdb, languages, per_language):
    """Global popularity lists miss most regional shows, so also take the top shows per language."""
    ids = []
    for lang in languages:
        got = []
        for page in range(1, per_language // 20 + 2):
            data = tmdb.get("/discover/tv", with_original_language=lang, sort_by="popularity.desc",
                            page=page, include_adult="false")
            if not data or not data.get("results"):
                break
            got += [x["id"] for x in data["results"]]
            if page >= data.get("total_pages", 0):
                break
        print(f"  {lang}: {len(got[:per_language])} shows")
        ids += got[:per_language]
    return ids


def slim(d, region):
    """Keep only what the pipeline and the website use, so the cache stays small."""
    providers = (d.get("watch/providers") or {}).get("results", {})
    reg = providers.get(region) or {}
    return {
        "id": d["id"],
        "name": d.get("name"),
        "original_name": d.get("original_name"),
        "original_language": d.get("original_language"),
        "origin_country": d.get("origin_country") or [],
        "overview": d.get("overview") or "",
        "tagline": d.get("tagline") or "",
        "popularity": d.get("popularity") or 0,
        "vote_average": d.get("vote_average") or 0,
        "vote_count": d.get("vote_count") or 0,
        "first_air_date": d.get("first_air_date") or "",
        "last_air_date": d.get("last_air_date") or "",
        "status": d.get("status") or "",
        "type": d.get("type") or "",
        "adult": d.get("adult", False),
        "poster_path": d.get("poster_path"),
        "backdrop_path": d.get("backdrop_path"),
        "number_of_seasons": d.get("number_of_seasons") or 0,
        "number_of_episodes": d.get("number_of_episodes") or 0,
        "episode_run_time": d.get("episode_run_time") or [],
        "genres": [g["name"] for g in d.get("genres") or []],
        "networks": [n["name"] for n in d.get("networks") or []],
        "created_by": [c["name"] for c in d.get("created_by") or []],
        "keywords": [k["name"] for k in (d.get("keywords") or {}).get("results", [])],
        "cast": [c["name"] for c in (d.get("aggregate_credits") or {}).get("cast", [])[:10]],
        "providers": [p["provider_name"] for p in reg.get("flatrate", [])],
        "providers_link": reg.get("link"),
        "recommendations": [r["id"] for r in (d.get("recommendations") or {}).get("results", [])[:20]],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", default="20000",
                    help="how many of the most popular shows to fetch, or 'all' for every series on TMDB")
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--region", default="IN", help="country for 'where to watch' (ISO code)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--rate", type=float, default=30, help="max requests per second")
    ap.add_argument("--languages", default="hi,ta,te,ml,kn,mr,bn",
                    help="also fetch the top shows in these original languages (comma list, '' for none)")
    ap.add_argument("--per-language", type=int, default=400)
    args = ap.parse_args()

    tmdb = Tmdb(per_second=args.rate)
    con = open_db(args.db)

    limit = None if str(args.limit).lower() in ("all", "0") else int(args.limit)
    ids = candidate_ids_from_export(None if limit is None else int(limit * 1.2)) \
        or candidate_ids_from_discover(tmdb, limit or 10000)
    langs = [x.strip() for x in args.languages.split(",") if x.strip()]
    if langs:
        print("Extra regional shows:")
        seen = set(ids)
        ids += [i for i in extra_language_ids(tmdb, langs, args.per_language) if i not in seen]
    have = {r[0] for r in con.execute("SELECT id FROM shows")} | {r[0] for r in con.execute("SELECT id FROM missing")}
    todo = [i for i in ids if i not in have]
    print(f"{len(ids):,} candidates, {len(todo):,} still to fetch")

    def work(show_id):
        return show_id, tmdb.get(f"/tv/{show_id}", append_to_response=APPEND, language="en-US")

    done, start = 0, time.time()
    with ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(work, i) for i in todo]
        try:
            for fut in as_completed(futures):
                show_id, data = fut.result()
                if data and not data.get("adult"):
                    con.execute(
                        "INSERT OR REPLACE INTO shows VALUES (?,?,?)",
                        (show_id, json.dumps(slim(data, args.region)), time.time()),
                    )
                else:
                    con.execute("INSERT OR IGNORE INTO missing VALUES (?)", (show_id,))
                done += 1
                if done % 200 == 0:
                    con.commit()
                    rate = done / (time.time() - start)
                    print(f"  {done:,}/{len(todo):,}  ({rate:.1f}/s, ~{(len(todo) - done) / rate / 60:.0f} min left)")
        except KeyboardInterrupt:
            print("Stopping, progress is saved. Run again to continue.")
            pool.shutdown(cancel_futures=True)
    con.commit()
    total = con.execute("SELECT COUNT(*) FROM shows").fetchone()[0]
    print(f"Done. {total:,} shows in {args.db}")


if __name__ == "__main__":
    main()
