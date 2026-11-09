"""Optional: fetch per-episode ratings for the most popular shows (for the season heatmap).

One request per season, so keep --top modest (3000 shows is roughly 15k requests, about 10 minutes).

    python pipeline/fetch_episodes.py --top 3000
"""
import argparse
import json
from concurrent.futures import ThreadPoolExecutor, as_completed

from common import DEFAULT_DB, Tmdb, load_shows, open_db


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=3000)
    ap.add_argument("--max-seasons", type=int, default=25)
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--rate", type=float, default=30)
    args = ap.parse_args()

    tmdb = Tmdb(per_second=args.rate)
    con = open_db(args.db)
    shows = sorted(load_shows(con), key=lambda s: s.get("vote_count", 0), reverse=True)[: args.top]
    have = {(r[0], r[1]) for r in con.execute("SELECT show_id, season FROM seasons")}
    jobs = [
        (s["id"], n)
        for s in shows
        for n in range(1, min(s.get("number_of_seasons", 0), args.max_seasons) + 1)
        if (s["id"], n) not in have
    ]
    print(f"{len(jobs):,} seasons to fetch")

    def work(job):
        sid, n = job
        return sid, n, tmdb.get(f"/tv/{sid}/season/{n}")

    with ThreadPoolExecutor(8) as pool:
        for i, fut in enumerate(as_completed([pool.submit(work, j) for j in jobs]), 1):
            sid, n, data = fut.result()
            eps = []
            for e in (data or {}).get("episodes", []):
                eps.append([e.get("episode_number"), round(e.get("vote_average") or 0, 1), e.get("vote_count") or 0])
            con.execute("INSERT OR REPLACE INTO seasons VALUES (?,?,?)", (sid, n, json.dumps(eps)))
            if i % 300 == 0:
                con.commit()
                print(f"  {i:,}/{len(jobs):,}")
    con.commit()
    print("Done.")


if __name__ == "__main__":
    main()
