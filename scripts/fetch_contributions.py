"""Scrape the public contribution calendar into data/contributions.json."""
import json, re, sys, urllib.request
from pathlib import Path

USER = sys.argv[1] if len(sys.argv) > 1 else "sarang-cmd"
html = urllib.request.urlopen(
    urllib.request.Request(f"https://github.com/users/{USER}/contributions",
                           headers={"User-Agent": "readme-cards"}), timeout=30).read().decode()

tips = {}
for m in re.finditer(r'<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)', html):
    n = re.match(r"\s*(No|\d+)\s+contribution", m.group(2))
    if n:
        tips[m.group(1)] = 0 if n.group(1) == "No" else int(n.group(1))

days = []
for m in re.finditer(r'<td[^>]*data-date="([\d-]+)"[^>]*id="([^"]+)"[^>]*data-level="(\d)"', html):
    days.append({"date": m.group(1), "count": tips.get(m.group(2), 0), "level": int(m.group(3))})
days.sort(key=lambda d: d["date"])
Path(__file__).resolve().parent.parent.joinpath("data", "contributions.json").write_text(
    json.dumps({"user": USER, "days": days}, indent=1))
print(f"{len(days)} days, {sum(d['count'] for d in days)} contributions")
