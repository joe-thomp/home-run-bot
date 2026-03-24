#!/usr/bin/env python3
"""Render a quick gallery of all stadium outlines for visual inspection."""

import argparse
import json
from math import ceil
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from hr_analysis import extract_outfield_wall_path

def draw_stadium(ax, team, stadium_paths):
    """Draw a single stadium preview onto the provided axis."""
    path_data = stadium_paths.get(team)
    if not path_data:
        ax.axis("off")
        return

    path_x = []
    path_y = []

    segment_styles = {
        "foul_lines": 1.0,
        "home_plate": 0.8,
        "infield_inner": 0.8,
        "infield_outer": 0.9,
        "outfield_inner": 0.9,
        "outfield_outer": 1.0,
    }

    for segment_name in (
        "foul_lines",
        "home_plate",
        "infield_inner",
        "infield_outer",
        "outfield_inner",
        "outfield_outer",
    ):
        points = path_data.get(segment_name)
        if not points or len(points) < 2:
            continue

        sx = [point["x"] for point in points]
        sy = [point["y"] for point in points]
        path_x.extend(sx)
        path_y.extend(sy)
        ax.plot(sx, sy, color="black", linewidth=segment_styles[segment_name])

    outfield_outer = extract_outfield_wall_path(
        path_data.get("outfield_outer", []),
        path_data.get("foul_lines", []),
    )
    if len(outfield_outer) >= 2:
        fx = [point["x"] for point in outfield_outer]
        fy = [point["y"] for point in outfield_outer]
        ax.plot(fx, fy, color="#225b84", linewidth=2.2, solid_joinstyle="round", solid_capstyle="round")
    else:
        fx = []
        fy = []

    all_x = fx + path_x + [0]
    all_y = fy + path_y + [0]
    ax.set_xlim(min(all_x) - 20, max(all_x) + 20)
    ax.set_ylim(min(all_y) - 20, max(all_y) + 20)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title(team, fontsize=10, fontweight="bold", pad=4)


def main():
    parser = argparse.ArgumentParser(description="Render a gallery of all ballparks")
    parser.add_argument("--paths", default="data/stadium_paths.json", type=Path)
    parser.add_argument("--output", default="tmp/stadium_gallery.png", type=Path)
    parser.add_argument("--cols", default=5, type=int)
    args = parser.parse_args()

    stadium_paths = json.loads(args.paths.read_text(encoding="utf-8"))

    teams = sorted(team for team in stadium_paths.keys() if team != "generic")
    cols = max(1, args.cols)
    rows = ceil(len(teams) / cols)

    fig, axes = plt.subplots(rows, cols, figsize=(cols * 3.3, rows * 3.0))
    axes = axes.flatten() if hasattr(axes, "flatten") else [axes]
    fig.patch.set_facecolor("white")

    for ax, team in zip(axes, teams):
        draw_stadium(ax, team, stadium_paths)

    for ax in axes[len(teams):]:
        ax.axis("off")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout(pad=1.0)
    fig.savefig(args.output, dpi=220, bbox_inches="tight", facecolor="white", edgecolor="none")
    plt.close(fig)
    print(args.output)


if __name__ == "__main__":
    main()
