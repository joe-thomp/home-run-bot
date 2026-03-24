#!/usr/bin/env python3
"""Refresh local ballpark geometry from upstream GeomMLBStadiums + dinger-machine data."""

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path


SCALE = 2.495671
TEAM_NAME_OVERRIDES = {
    "guardians": "CLE",
}


def transform_geom_coords(x_value, y_value):
    """Apply the GeomMLBStadiums MLBAM coordinate transform."""
    return {
        "x": round(SCALE * (float(x_value) - 125.0), 4),
        "y": round(SCALE * (199.0 - float(y_value)), 4),
    }


def load_team_slug_to_abbr(fences_csv_path):
    """Build a mapping from dinger-machine team slug to team abbreviation."""
    team_slug_to_abbr = {}
    with fences_csv_path.open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            team_slug_to_abbr.setdefault(row["team"], row["team_abbr"])
    team_slug_to_abbr.update(TEAM_NAME_OVERRIDES)
    return team_slug_to_abbr


def build_stadium_paths_json(geom_csv_path, fences_csv_path):
    """Convert GeomMLBStadiums path CSV into the JSON shape used by the bot."""
    team_slug_to_abbr = load_team_slug_to_abbr(fences_csv_path)
    stadium_paths = defaultdict(lambda: defaultdict(list))

    with geom_csv_path.open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            team_slug = row["team"]
            team_key = "generic" if team_slug == "generic" else team_slug_to_abbr[team_slug]
            stadium_paths[team_key][row["segment"]].append(
                transform_geom_coords(row["x"], row["y"])
            )

    return {
        team_key: dict(segments)
        for team_key, segments in sorted(stadium_paths.items())
    }


def build_fences_json(fences_csv_path):
    """Convert dinger-machine fence CSV into the JSON shape used by the bot."""
    fences = defaultdict(lambda: {"stadium": "", "fence_points": []})

    with fences_csv_path.open(newline="", encoding="utf-8") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            team_key = row["team_abbr"]
            fences[team_key]["stadium"] = row["stadium"]
            fences[team_key]["fence_points"].append(
                {
                    "spray_angle": round(float(row["spray_angle_stadia"]), 4),
                    "d_wall": round(float(row["d_wall"]), 4),
                    "fence_height": round(float(row["fence_height"]), 4),
                    "x": round(float(row["x"]), 4),
                    "y": round(float(row["y"]), 4),
                }
            )

    for team_data in fences.values():
        team_data["fence_points"].sort(key=lambda point: point["spray_angle"])

    return dict(sorted(fences.items()))


def write_json(output_path, payload):
    """Write a JSON file with stable formatting."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Refresh ballpark data files")
    parser.add_argument("--geom_csv", required=True, type=Path)
    parser.add_argument("--fences_csv", required=True, type=Path)
    parser.add_argument("--out_paths_json", required=True, type=Path)
    parser.add_argument("--out_fences_json", required=True, type=Path)
    args = parser.parse_args()

    stadium_paths = build_stadium_paths_json(args.geom_csv, args.fences_csv)
    fences = build_fences_json(args.fences_csv)

    write_json(args.out_paths_json, stadium_paths)
    write_json(args.out_fences_json, fences)

    print(
        json.dumps(
            {
                "stadium_paths_teams": len(stadium_paths),
                "fence_teams": len(fences),
                "sample_stadium": stadium_paths.get("BAL", {}).keys(),
                "sample_fence_points": len(fences.get("BAL", {}).get("fence_points", [])),
            },
            default=list,
        )
    )


if __name__ == "__main__":
    main()
