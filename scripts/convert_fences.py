#!/usr/bin/env python3
"""
One-time script to download fence_heights_complete.csv from the dinger-machine
GitHub repo and convert it to data/fences.json for use by hr_analysis.py.

Usage:
    python scripts/convert_fences.py
"""

import csv
import json
import os
import io
import urllib.request

CSV_URL = "https://raw.githubusercontent.com/danmorse314/dinger-machine/main/data/fence_heights_complete.csv"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_PATH = os.path.join(SCRIPT_DIR, "..", "data", "fences.json")

# Map team abbreviations to stadium names
STADIUM_NAMES = {
    "ARI": "Chase Field",
    "ATL": "Truist Park",
    "BAL": "Oriole Park at Camden Yards",
    "BOS": "Fenway Park",
    "CHC": "Wrigley Field",
    "CWS": "Guaranteed Rate Field",
    "CIN": "Great American Ball Park",
    "CLE": "Progressive Field",
    "COL": "Coors Field",
    "DET": "Comerica Park",
    "HOU": "Minute Maid Park",
    "KC": "Kauffman Stadium",
    "LAA": "Angel Stadium",
    "LAD": "Dodger Stadium",
    "MIA": "loanDepot park",
    "MIL": "American Family Field",
    "MIN": "Target Field",
    "NYM": "Citi Field",
    "NYY": "Yankee Stadium",
    "OAK": "Oakland Coliseum",
    "PHI": "Citizens Bank Park",
    "PIT": "PNC Park",
    "SD": "Petco Park",
    "SF": "Oracle Park",
    "SEA": "T-Mobile Park",
    "STL": "Busch Stadium",
    "TB": "Tropicana Field",
    "TEX": "Globe Life Field",
    "TOR": "Rogers Centre",
    "WAS": "Nationals Park",
    "WSH": "Nationals Park",
}


def download_csv(url):
    """Download CSV content from URL."""
    print(f"Downloading {url}...")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        return resp.read().decode("utf-8")


def parse_and_group(csv_text):
    """Parse CSV text and group fence points by team."""
    reader = csv.DictReader(io.StringIO(csv_text))
    teams = {}

    for row in reader:
        team = row["team_abbr"].strip()
        if team not in teams:
            teams[team] = []

        teams[team].append({
            "spray_angle": float(row["spray_angle_stadia"]),
            "d_wall": float(row["d_wall"]),
            "fence_height": float(row["fence_height"]),
            "x": float(row["x"]),
            "y": float(row["y"]),
        })

    # Sort each team's fence points by spray_angle
    for team in teams:
        teams[team].sort(key=lambda p: p["spray_angle"])

    return teams


def build_output(teams):
    """Build the final JSON structure."""
    output = {}
    for team, points in sorted(teams.items()):
        stadium = STADIUM_NAMES.get(team, f"{team} Stadium")
        output[team] = {
            "stadium": stadium,
            "fence_points": points,
        }
    return output


def main():
    csv_text = download_csv(CSV_URL)
    teams = parse_and_group(csv_text)

    print(f"Found {len(teams)} teams:")
    for team in sorted(teams.keys()):
        print(f"  {team}: {len(teams[team])} fence points")

    output = build_output(teams)

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nWrote {OUTPUT_PATH}")
    print(f"Total teams: {len(output)}")


if __name__ == "__main__":
    main()
