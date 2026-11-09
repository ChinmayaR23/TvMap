"""Shared helpers: paths, the SQLite cache and a polite TMDB client."""
import json
import os
import sqlite3
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
WEB_DATA = ROOT / "web" / "public" / "data"
DEFAULT_DB = DATA_DIR / "tmdb.sqlite"

API = "https://api.themoviedb.org/3"


def open_db(path=DEFAULT_DB):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("CREATE TABLE IF NOT EXISTS shows (id INTEGER PRIMARY KEY, json TEXT NOT NULL, fetched_at REAL)")
    con.execute("CREATE TABLE IF NOT EXISTS missing (id INTEGER PRIMARY KEY)")
    con.execute(
        "CREATE TABLE IF NOT EXISTS seasons (show_id INTEGER, season INTEGER, json TEXT NOT NULL, "
        "PRIMARY KEY (show_id, season))"
    )
    con.commit()
    return con


def load_shows(con):
    return [json.loads(r[0]) for r in con.execute("SELECT json FROM shows")]


class RateLimiter:
    """Simple token bucket shared across threads (TMDB allows roughly 40-50 requests/second)."""

    def __init__(self, per_second):
        self.interval = 1.0 / per_second
        self.lock = threading.Lock()
        self.next_time = time.monotonic()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            if now < self.next_time:
                time.sleep(self.next_time - now)
            self.next_time = max(now, self.next_time) + self.interval


class Tmdb:
    def __init__(self, token=None, per_second=30):
        import requests

        token = token or os.environ.get("TMDB_TOKEN")
        if not token:
            raise SystemExit(
                "Set TMDB_TOKEN to your TMDB 'API Read Access Token' (Settings > API on themoviedb.org)."
            )
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {token}", "Accept": "application/json"})
        self.limiter = RateLimiter(per_second)

    def get(self, path, **params):
        for attempt in range(6):
            self.limiter.wait()
            try:
                r = self.session.get(API + path, params=params, timeout=20)
            except Exception:
                time.sleep(2 ** attempt)
                continue
            if r.status_code == 200:
                return r.json()
            if r.status_code == 404:
                return None
            if r.status_code == 429:
                time.sleep(float(r.headers.get("Retry-After", 2)))
                continue
            if r.status_code in (401, 403):
                raise SystemExit("TMDB rejected the token (HTTP %s). Check TMDB_TOKEN." % r.status_code)
            time.sleep(2 ** attempt)
        return None
