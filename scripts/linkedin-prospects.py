#!/usr/bin/env python3
"""Single shared prospect source for the LinkedIn agent.

Canonical file: ~/linkedin-agent/prospects/shared/prospects.csv  (one row per person, deduped by
LinkedIn URL). Writers: Grok Prospecting via the agent-bus (intake handled by
~/grok-bridge/agent-bus-poll.py), Kyle, any agent. Reader/updater: the LinkedIn agent.

Usage:
  prospects.py add --name N --url U [--title T] [--company C] [--why W] [--source S]
  prospects.py ingest < body        # JSON array / {"prospects":[...]} / pipe-delimited lines
  prospects.py list [--status new]
  prospects.py set-status URL STATUS [--note TEXT]   # new|queued|connected|messaged|replied|skip|done
  prospects.py render               # rewrites prospects.md and dashboard.html next to the csv
"""
import csv, fcntl, html, json, os, re, sys, time, argparse

DIR = os.path.expanduser("~/linkedin-agent/prospects/shared")
CSV = os.path.join(DIR, "prospects.csv")
FIELDS = ["added_at", "url", "name", "title", "company", "why", "source", "status", "updated_at", "notes"]
STATUSES = ["new", "queued", "connected", "messaged", "replied", "skip", "done"]


def safe(v):
    """Neutralize CSV/spreadsheet formula prefixes and control chars in any supplied field."""
    v = re.sub(r"[\x00-\x08\x0b-\x1f]", "", str(v or "")).strip()
    return ("'" + v) if v[:1] in ("=", "+", "-", "@", "\t", "\r") else v


def norm_url(u):
    u = (u or "").strip().split("?")[0].rstrip("/").lower()
    u = re.sub(r"^https?://(www\.|[a-z]{2}\.)?", "https://www.", u)
    return u


def now():
    return time.strftime("%Y-%m-%d %H:%M")


def read():
    if not os.path.exists(CSV):
        return []
    with open(CSV, newline="") as f:
        return list(csv.DictReader(f))


def write(rows):
    os.makedirs(DIR, exist_ok=True)
    tmp = CSV + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, CSV)


class Lock:
    def __enter__(self):
        os.makedirs(DIR, exist_ok=True)
        self.f = open(os.path.join(DIR, ".lock"), "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)

    def __exit__(self, *a):
        self.f.close()


def add_many(items, default_source="unknown"):
    added = dup = bad = 0
    with Lock():
        rows = read()
        seen = {norm_url(r["url"]) for r in rows}
        for it in items:
            url = norm_url(it.get("url") or it.get("linkedin_url") or it.get("linkedin") or "")
            name = (it.get("name") or "").strip()
            if not re.fullmatch(r"https://www\.linkedin\.com/[^\s'\"<>()]+", url) or not name:
                bad += 1
                continue
            if url in seen:
                dup += 1
                continue
            seen.add(url)
            rows.append({
                "added_at": now(), "url": url, "name": safe(name)[:200],
                "title": safe(it.get("title"))[:200], "company": safe(it.get("company"))[:200],
                "why": safe(it.get("why") or it.get("reason") or it.get("notes"))[:1000],
                "source": safe(it.get("source") or default_source)[:80], "status": "new",
                "updated_at": now(), "notes": "",
            })
            added += 1
        if added:
            write(rows)
    if added:
        render()
    return added, dup, bad


def parse_body(body):
    body = body.strip()
    try:
        data = json.loads(body)
        if isinstance(data, dict):
            data = data.get("prospects") or [data]
        return [d for d in data if isinstance(d, dict)]
    except Exception:
        pass
    items = []
    for line in body.splitlines():
        parts = [p.strip() for p in line.strip("-* ").split("|")]
        if len(parts) >= 2 and "linkedin.com/" in parts[1]:
            keys = ["name", "url", "title", "company", "why"]
            items.append(dict(zip(keys, parts)))
    return items


def render():
    rows = read()
    counts = {s: sum(1 for r in rows if r["status"] == s) for s in STATUSES}
    summary = " | ".join(f"{s}: {n}" for s, n in counts.items())
    md = ["# Shared LinkedIn prospects (single source)", "", f"Updated {now()}. {len(rows)} total. {summary}", "",
          "Source of truth: prospects.csv in this folder. Grok Prospecting drops new rows over the agent-bus; the LinkedIn agent updates status.", "",
          "| status | name | title | company | why | source | added |", "|---|---|---|---|---|---|---|"]
    for r in reversed(rows):
        cell = lambda k: html.escape((r[k] or "").replace("|", "/").replace("\n", " "))
        md.append(f"| {r['status']} | [{cell('name')}]({r['url']}) | {cell('title')} | {cell('company')} | {cell('why')[:160]} | {cell('source')} | {r['added_at']} |")
    open(os.path.join(DIR, "prospects.md"), "w").write("\n".join(md) + "\n")
    e = html.escape
    tr = "".join(
        f"<tr class='{e(r['status'])}'><td>{e(r['status'])}</td><td><a href='{e(r['url'])}'>{e(r['name'])}</a></td>"
        f"<td>{e(r['title'])}</td><td>{e(r['company'])}</td><td>{e(r['why'])}</td><td>{e(r['source'])}</td><td>{e(r['added_at'])}</td></tr>"
        for r in reversed(rows))
    page = (f"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
            f"<meta http-equiv=refresh content=300><title>Shared prospects</title>"
            f"<style>body{{font:14px -apple-system,sans-serif;margin:20px;color:#222}}table{{border-collapse:collapse;width:100%}}"
            f"td,th{{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}}tr.new{{background:#f0fff0}}"
            f"tr.skip,tr.done{{color:#888}}</style><h1>Shared LinkedIn prospects</h1><p>Updated {now()}. {len(rows)} total. {e(summary)}</p>"
            f"<table><tr><th>status<th>name<th>title<th>company<th>why<th>source<th>added</tr>{tr}</table>")
    open(os.path.join(DIR, "dashboard.html"), "w").write(page)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    for k in ("name", "url", "title", "company", "why", "source"):
        a.add_argument("--" + k, default="")
    sub.add_parser("ingest").add_argument("--source", default="stdin")
    l = sub.add_parser("list"); l.add_argument("--status")
    s = sub.add_parser("set-status"); s.add_argument("url"); s.add_argument("status", choices=STATUSES); s.add_argument("--note", default="")
    sub.add_parser("render")
    args = ap.parse_args()
    if args.cmd == "add":
        print(add_many([vars(args)], args.source or "cli"))
    elif args.cmd == "ingest":
        print(add_many(parse_body(sys.stdin.read()), args.source))
    elif args.cmd == "list":
        for r in read():
            if not args.status or r["status"] == args.status:
                print(f"{r['status']}\t{r['name']}\t{r['title']}\t{r['company']}\t{r['url']}\t{r['why']}")
    elif args.cmd == "set-status":
        with Lock():
            rows = read(); u = norm_url(args.url); hit = False
            for r in rows:
                if norm_url(r["url"]) == u:
                    r["status"] = args.status; r["updated_at"] = now(); hit = True
                    if args.note: r["notes"] = (r["notes"] + " " + args.note).strip()
            if hit: write(rows)
        render(); print("ok" if hit else "not found"); sys.exit(0 if hit else 1)
    elif args.cmd == "render":
        render()


if __name__ == "__main__":
    main()
