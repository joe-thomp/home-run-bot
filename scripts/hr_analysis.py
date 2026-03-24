#!/usr/bin/env python3
"""
HR Analysis: physics engine + ballpark overlay image generator.

Ports the dinger-machine physics model exactly and generates a matplotlib
ballpark overlay image showing the ball flight path.

Called from Node.js via:
    python scripts/hr_analysis.py --launch_speed 112.3 --launch_angle 28.5 \
        --hit_distance 450 --hc_x 140.2 --hc_y 165.8 --plate_z 3.2 \
        --home_team NYY --player_name "Aaron Judge" --pitcher_name "Gerrit Cole" \
        --output_image tmp/hr_overlay.png --fences_path data/fences.json

Returns JSON to stdout.
"""

import argparse
import json
import math
import os
import sys
import urllib.request

import matplotlib
matplotlib.use("Agg")  # Non-interactive backend
import matplotlib.pyplot as plt
import matplotlib.patches as patches
import numpy as np
from PIL import Image


# ── Physics constants ────────────────────────────────────────────────────────
G = -32.174  # ft/s^2  (gravity, negative = downward)
SCALE = 2.495671  # MLBAM coordinate scale factor
TEAM_LOGO_CODES = {
    "ARI": "ari",
    "ATL": "atl",
    "BAL": "bal",
    "BOS": "bos",
    "CHC": "chc",
    "CIN": "cin",
    "CLE": "cle",
    "COL": "col",
    "CWS": "chw",
    "DET": "det",
    "HOU": "hou",
    "KC": "kc",
    "LAA": "laa",
    "LAD": "lad",
    "MIA": "mia",
    "MIL": "mil",
    "MIN": "min",
    "NYM": "nym",
    "NYY": "nyy",
    "OAK": "oak",
    "PHI": "phi",
    "PIT": "pit",
    "SD": "sd",
    "SEA": "sea",
    "SF": "sf",
    "STL": "stl",
    "TB": "tb",
    "TEX": "tex",
    "TOR": "tor",
    "WAS": "wsh",
}


def compute_spray_angle(hc_x, hc_y):
    """Compute spray angle from Statcast hit coordinates (MLBAM system)."""
    hc_x_ = SCALE * (hc_x - 125.0)
    hc_y_ = SCALE * (199.0 - hc_y)
    if hc_y_ == 0:
        return 0.0
    spray = math.atan(hc_x_ / hc_y_) * 180.0 / math.pi * 0.75
    return round(spray, 1)


def compute_landing_xy(hc_x, hc_y, hit_distance):
    """Compute landing spot x,y in the fence coordinate system."""
    hc_x_ = SCALE * (hc_x - 125.0)
    hc_y_ = SCALE * (199.0 - hc_y)
    r = math.sqrt(hc_x_ ** 2 + hc_y_ ** 2)
    if r == 0:
        return 0.0, hit_distance
    # Scale the direction vector to the actual hit distance
    land_x = hc_x_ / r * hit_distance
    land_y = hc_y_ / r * hit_distance
    return land_x, land_y


def compute_stadium_spray_angle(x_value, y_value):
    """Compute spray angle from already-transformed stadium coordinates."""
    if y_value == 0:
        return 0.0
    return math.degrees(math.atan2(x_value, y_value)) * 0.75


def get_team_logo_url(team_abbr):
    """Return ESPN CDN logo URL for the given MLB team abbreviation."""
    logo_code = TEAM_LOGO_CODES.get((team_abbr or "").upper())
    if not logo_code:
        return None
    return f"https://a.espncdn.com/i/teamlogos/mlb/500/{logo_code}.png"


def get_player_headshot_url(player_id):
    """Return MLB headshot URL for the given player ID."""
    if not player_id:
        return None
    return (
        "https://img.mlbstatic.com/mlb-photos/image/upload/"
        "d_people:generic:headshot:67:current.png/w_213,q_auto:best/"
        f"v1/people/{player_id}/headshot/67/current"
    )


def load_cached_image(url, cache_dir, cache_name):
    """Download and cache an image, then return it as an RGBA numpy array."""
    if not url:
        return None

    os.makedirs(cache_dir, exist_ok=True)
    cache_path = os.path.join(cache_dir, cache_name)

    if not os.path.exists(cache_path):
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        try:
            with urllib.request.urlopen(request, timeout=4) as response:
                with open(cache_path, "wb") as image_file:
                    image_file.write(response.read())
        except Exception:
            return None

    try:
        with Image.open(cache_path) as image:
            return np.array(image.convert("RGBA"))
    except Exception:
        try:
            os.remove(cache_path)
        except OSError:
            pass
        return None


def split_visible_path_runs(points, min_visible_y):
    """Split a closed path into visible runs without bridging clipped gaps."""
    if not points:
        return []

    runs = []
    current_run = []

    for point in points:
        if point["y"] >= min_visible_y:
            current_run.append(point)
        elif current_run:
            runs.append(current_run)
            current_run = []

    if current_run:
        if runs and points[0]["y"] >= min_visible_y:
            runs[0] = current_run + runs[0]
        else:
            runs.append(current_run)

    return [run for run in runs if len(run) >= 2]


def dedupe_fence_plot_points(fence_points):
    """Remove duplicate spray-angle points for plotting while keeping fence shape smooth."""
    by_angle = {}
    ordered_angles = []

    for point in fence_points:
        angle_key = round(float(point["spray_angle"]), 4)
        if angle_key not in by_angle:
            ordered_angles.append(angle_key)
            by_angle[angle_key] = point
            continue

        # Prefer the smoother inner point when duplicate spray angles exist.
        if float(point["d_wall"]) < float(by_angle[angle_key]["d_wall"]):
            by_angle[angle_key] = point

    return [by_angle[angle_key] for angle_key in ordered_angles]


def extract_outfield_wall_path(path_points, foul_line_points):
    """Extract the foul-pole-to-foul-pole wall run from GeomMLBStadiums outfield paths."""
    if len(path_points) < 3:
        return path_points

    left_line = [point for point in foul_line_points if point["x"] <= 0]
    right_line = [point for point in foul_line_points if point["x"] >= 0]
    if not left_line or not right_line:
        return path_points

    def pole_subset(line_points):
        distances = [
            math.hypot(float(point["x"]), float(point["y"]))
            for point in line_points
        ]
        cutoff = np.percentile(distances, 80)
        subset = [
            point
            for point, distance in zip(line_points, distances)
            if distance >= cutoff
        ]
        return subset or line_points

    def nearest_index(target_points):
        best_index = 0
        best_distance = float("inf")
        for index, point in enumerate(path_points):
            for target in target_points:
                dx = float(point["x"]) - float(target["x"])
                dy = float(point["y"]) - float(target["y"])
                distance = (dx * dx) + (dy * dy)
                if distance < best_distance:
                    best_distance = distance
                    best_index = index
        return best_index

    left_index = nearest_index(pole_subset(left_line))
    right_index = nearest_index(pole_subset(right_line))
    if left_index == right_index:
        return path_points

    start_index, end_index = sorted((left_index, right_index))
    direct_run = path_points[start_index:end_index + 1]
    wrapped_run = path_points[end_index:] + path_points[:start_index + 1]

    def run_score(points):
        avg_y = sum(float(point["y"]) for point in points) / len(points)
        avg_radius = sum(
            math.hypot(float(point["x"]), float(point["y"]))
            for point in points
        ) / len(points)
        return avg_y, avg_radius, len(points)

    return max((direct_run, wrapped_run), key=run_score)


def build_outfield_overlay(path_points, fence_points):
    """Project dinger-machine fence heights onto the GeomMLBStadiums outfield wall."""
    overlay_points = []
    for point in path_points:
        spray_angle = compute_stadium_spray_angle(point["x"], point["y"])
        fence_point = find_nearest_fence_point(spray_angle, fence_points)
        if fence_point is None:
            continue

        overlay_points.append(
            {
                "x": point["x"],
                "y": point["y"],
                "fence_height": float(fence_point["fence_height"]),
            }
        )
    return overlay_points


def spray_direction(angle):
    """Human-readable spray direction."""
    if angle < -15:
        return "Left Field"
    elif angle < -5:
        return "Left-Center"
    elif angle <= 5:
        return "Center Field"
    elif angle <= 15:
        return "Right-Center"
    else:
        return "Right Field"


def would_it_dong(launch_speed, launch_angle_deg, hit_distance, plate_z,
                  fence_points, force_dong=False):
    """
    Exact dinger-machine physics port.
    Returns (clears: bool, height_at_wall: float, fence_height: float).
    """
    launch_angle_rad = math.radians(launch_angle_deg)
    v0 = launch_speed * 5280.0 / 3600.0  # mph → ft/s

    vx = v0 * math.cos(launch_angle_rad)
    vy = v0 * math.sin(launch_angle_rad)

    # Total flight time (time to return to ground from plate_z height)
    discriminant = vy ** 2 + 2.0 * G * plate_z
    if discriminant < 0:
        discriminant = 0
    total_time = -(vy + math.sqrt(discriminant)) / G

    if total_time <= 0:
        return force_dong, 0.0, 0.0

    # Back-calculate horizontal acceleration (captures drag implicitly)
    ax = (-2.0 * vx / total_time) + (2.0 * hit_distance / (total_time ** 2))

    # Find nearest fence point by spray angle (already computed by caller)
    d_wall = fence_points["d_wall"]
    fence_height = fence_points["fence_height"]

    # Time to reach the wall distance
    disc_wall = vx ** 2 + 2.0 * ax * d_wall
    if disc_wall < 0:
        return force_dong, 0.0, fence_height

    t_wall = (-vx + math.sqrt(disc_wall)) / ax if ax != 0 else d_wall / vx

    # Height at the wall
    height_at_wall = vy * t_wall + 0.5 * G * (t_wall ** 2)

    clears = height_at_wall > fence_height
    if force_dong:
        clears = True

    return clears, round(height_at_wall, 1), fence_height


def find_nearest_fence_point(spray_angle, fence_points_list):
    """Find the fence point with the nearest spray angle (no interpolation)."""
    best = None
    best_diff = float("inf")
    for pt in fence_points_list:
        diff = abs(spray_angle - pt["spray_angle"])
        if diff < best_diff:
            best_diff = diff
            best = pt
    return best


def analyze_all_parks(launch_speed, launch_angle, hit_distance, plate_z,
                      spray_angle, home_team, fences_data):
    """Check would-it-dong across all 30 parks."""
    parks_cleared = []
    parks_not_cleared = []
    park_details = []

    for team, data in sorted(fences_data.items()):
        fence_pt = find_nearest_fence_point(spray_angle, data["fence_points"])
        if fence_pt is None:
            continue

        is_home = (team == home_team)
        clears, h_wall, f_height = would_it_dong(
            launch_speed, launch_angle, hit_distance, plate_z,
            fence_pt, force_dong=is_home
        )

        detail = {
            "team": team,
            "stadium": data["stadium"],
            "clears": clears,
            "height_at_wall": h_wall,
            "fence_height": f_height,
            "wall_distance": fence_pt["d_wall"],
        }
        park_details.append(detail)

        if clears:
            parks_cleared.append(team)
        else:
            parks_not_cleared.append(team)

    return parks_cleared, parks_not_cleared, park_details


# ── Image generation (Would It Dong style) ───────────────────────────────────

def generate_image(fences_data, home_team, spray_angle, hit_distance,
                   hc_x, hc_y, player_name, launch_speed, launch_angle,
                   total_dongs, parks_cleared, pitcher_name, output_path,
                   stadium_paths=None, fence_height=None, player_id=None):
    """Generate ballpark overlay image matching Would It Dong style."""
    from matplotlib.collections import LineCollection
    from matplotlib.colors import LinearSegmentedColormap

    # Dinger-machine color gradient: teal → dark navy
    dm_cmap = LinearSegmentedColormap.from_list(
        "dinger", ["#5BA8D0", "#003459"])

    fig, ax = plt.subplots(1, 1, figsize=(8.75, 6.6))
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    # Get home park fence data
    home_data = fences_data.get(home_team)
    if not home_data:
        home_data = fences_data.get("NYY", list(fences_data.values())[0])

    fence_pts = home_data["fence_points"]
    stadium_name = home_data["stadium"]

    path_x = []
    path_y = []
    outfield_wall_points = []

    # Draw stadium outline from GeomMLBStadiums path data
    if stadium_paths and home_team in stadium_paths:
        path_data = stadium_paths[home_team]
        segment_styles = {
            "foul_lines": {"linewidth": 1.6, "zorder": 2},
            "home_plate": {"linewidth": 1.4, "zorder": 2},
            "infield_inner": {"linewidth": 1.3, "zorder": 2},
            "infield_outer": {"linewidth": 1.3, "zorder": 2},
            "outfield_inner": {"linewidth": 1.3, "zorder": 2},
            "outfield_outer": {"linewidth": 1.6, "zorder": 2},
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

            sx = [p["x"] for p in points]
            sy = [p["y"] for p in points]
            path_x.extend(sx)
            path_y.extend(sy)

            ax.plot(
                sx,
                sy,
                color="black",
                linewidth=segment_styles[segment_name]["linewidth"],
                zorder=segment_styles[segment_name]["zorder"],
                solid_joinstyle="round",
                solid_capstyle="round",
            )

        wall_path_points = extract_outfield_wall_path(
            path_data.get("outfield_outer", []),
            path_data.get("foul_lines", []),
        )
        outfield_wall_points = build_outfield_overlay(wall_path_points, fence_pts)
    else:
        outfield_wall_points = dedupe_fence_plot_points(fence_pts)
        path_x.extend(point["x"] for point in outfield_wall_points)
        path_y.extend(point["y"] for point in outfield_wall_points)

    # Draw wall overlay using exact GeomMLBStadiums outfield geometry.
    fx = [pt["x"] for pt in outfield_wall_points]
    fy = [pt["y"] for pt in outfield_wall_points]
    fh = [pt["fence_height"] for pt in outfield_wall_points]
    home_fence_pt = find_nearest_fence_point(spray_angle, fence_pts)
    wall_distance = home_fence_pt["d_wall"] if home_fence_pt else None

    if len(outfield_wall_points) >= 2:
        ax.plot(
            fx,
            fy,
            color="#12314a",
            linewidth=4.0,
            zorder=2.8,
            solid_joinstyle="round",
            solid_capstyle="round",
        )

        points_arr = np.array([fx, fy]).T.reshape(-1, 1, 2)
        segments = np.concatenate([points_arr[:-1], points_arr[1:]], axis=1)
        heights = [(fh[i] + fh[i + 1]) / 2 for i in range(len(fh) - 1)]

        norm = plt.Normalize(vmin=min(fh), vmax=max(fh))
        lc = LineCollection(segments, cmap=dm_cmap, norm=norm,
                            linewidths=3.1, zorder=3)
        lc.set_array(np.array(heights))
        ax.add_collection(lc)

    # Ball flight path — landing spot
    land_x, land_y = compute_landing_xy(hc_x, hc_y, hit_distance)

    # Curvature matching dinger-machine: spray_angle / (-90)
    curv = spray_angle / (-90.0)

    # Draw solid blue flight line
    ax.annotate("", xy=(land_x, land_y), xytext=(0, 0),
                arrowprops=dict(arrowstyle="-", color="#0047AB",
                                connectionstyle=f"arc3,rad={curv}",
                                linewidth=2.5),
                zorder=5)

    # Landing spot — explosion/star marker
    ax.plot(land_x, land_y, marker="*", color="red", markersize=20,
            markeredgecolor="orange", markeredgewidth=1.2, zorder=6)

    # Compute plot bounds
    field_x = fx + path_x + [0]
    field_y = fy + path_y + [0]
    field_min_x = min(field_x)
    field_max_x = max(field_x)
    field_min_y = min(field_y)
    field_max_y = max(field_y)

    all_x = field_x + [land_x]
    all_y = field_y + [land_y]
    layout_min_x = min(all_x) - 24
    layout_min_y = min(all_y) - 40
    layout_max_y = max(all_y) + 20
    right_panel_width = 88
    layout_max_x = max(field_max_x, land_x) + right_panel_width

    field_height = field_max_y - field_min_y
    label_center_x = (field_min_x + field_max_x) / 2
    info_x = layout_min_x + 6
    info_y = layout_min_y + 6
    asset_cache_dir = os.path.join(
        os.path.dirname(output_path) or ".", "asset_cache"
    )
    logo_image = load_cached_image(
        get_team_logo_url(home_team),
        asset_cache_dir,
        f"team_logo_{home_team.lower()}.png",
    )
    player_headshot = load_cached_image(
        get_player_headshot_url(player_id),
        asset_cache_dir,
        f"player_headshot_{player_id}.png",
    ) if player_id else None

    if logo_image is not None:
        logo_height = field_height * 0.23
        logo_width = logo_height * (logo_image.shape[1] / logo_image.shape[0])
        logo_center_y = field_min_y + field_height * 0.64
        ax.imshow(
            logo_image,
            extent=(
                label_center_x - logo_width / 2,
                label_center_x + logo_width / 2,
                logo_center_y - logo_height / 2,
                logo_center_y + logo_height / 2,
            ),
            alpha=0.14,
            zorder=0.6,
        )
        stadium_label_y = field_min_y + field_height * 0.48
    else:
        team_label_y = field_min_y + field_height * 0.64
        stadium_label_y = field_min_y + field_height * 0.48
        ax.text(label_center_x, team_label_y, home_team, fontsize=11,
                ha="center", va="bottom", alpha=0.65, color="#003459",
                fontweight="bold", zorder=1)

    ax.text(label_center_x, stadium_label_y, stadium_name, fontsize=14,
            ha="center", va="bottom", alpha=0.28, color="#6f6f6f", zorder=1)

    details_lines = [
        f"Exit Velo: {launch_speed:.1f} mph",
        f"Launch Angle: {launch_angle:.1f}°",
    ]
    if wall_distance is not None:
        details_lines.append(f"Wall Dist: {int(round(wall_distance))} ft")
    if pitcher_name and pitcher_name != "Unknown":
        details_lines.append(f"Off: {pitcher_name}")

    details_text = "\n".join(details_lines)
    ax.text(layout_max_x - 8, info_y + 34, details_text,
            fontsize=8.2, ha="right", va="bottom", color="#1a1a1a",
            linespacing=1.15, zorder=10)

    # Distance stays in the bottom-right corner
    ax.text(layout_max_x - 8, info_y,
            f"{int(round(hit_distance))} FT", fontsize=15, ha="right",
            va="bottom", alpha=0.75, color="#3B73C5",
            fontweight="bold", zorder=10)

    # Player info text (bottom-left)
    info_text = f"{player_name}\nHome Run\nHR in {total_dongs}/30 parks"
    if player_headshot is not None:
        portrait_height = field_height * 0.21
        portrait_width = portrait_height * (
            player_headshot.shape[1] / player_headshot.shape[0]
        )
        portrait_bottom = info_y + 58
        ax.imshow(
            player_headshot,
            extent=(
                info_x,
                info_x + portrait_width,
                portrait_bottom,
                portrait_bottom + portrait_height,
            ),
            zorder=10,
        )
        ax.add_patch(
            patches.Rectangle(
                (info_x, portrait_bottom),
                portrait_width,
                portrait_height,
                fill=False,
                edgecolor="#d0d0d0",
                linewidth=0.8,
                zorder=11,
            )
        )

    ax.text(info_x, info_y, info_text, fontsize=10.5, ha="left",
            va="bottom", fontweight="semibold", zorder=10)

    # Wall Height bar (right side) — matching Would It Dong style
    if fence_height is not None and fence_height > 0:
        legend_min = min(fh)
        legend_max = max(fh)
        legend_width = 18
        legend_height = 84 if legend_min == legend_max else 112
        legend_x = layout_max_x - legend_width - 18
        legend_bottom = info_y + 86
        legend_top = legend_bottom + legend_height

        if legend_min == legend_max:
            legend_vmin = legend_min - 1
            legend_vmax = legend_max + 1
        else:
            legend_vmin = legend_min
            legend_vmax = legend_max

        legend_norm = plt.Normalize(vmin=legend_vmin, vmax=legend_vmax)
        gradient = np.linspace(legend_vmin, legend_vmax, 256).reshape(256, 1)
        ax.imshow(
            gradient,
            extent=(legend_x, legend_x + legend_width, legend_bottom, legend_top),
            origin="lower",
            cmap=dm_cmap,
            norm=legend_norm,
            aspect="auto",
            zorder=8,
        )
        ax.add_patch(
            patches.Rectangle(
                (legend_x, legend_bottom),
                legend_width,
                legend_height,
                fill=False,
                edgecolor="#1a1a1a",
                linewidth=0.8,
                zorder=9,
            )
        )

        ax.text(legend_x + legend_width / 2, legend_top + 14,
                "Wall Height (ft)", fontsize=10, ha="center", va="bottom",
                fontweight="bold", color="#1a1a1a", zorder=9)

        unique_heights = sorted({int(round(height)) for height in fh})
        if len(unique_heights) > 5:
            tick_values = [int(round(value)) for value in np.linspace(
                legend_min, legend_max, 5
            )]
        else:
            tick_values = unique_heights

        for tick in sorted(set(tick_values)):
            tick_y = legend_bottom + (
                (tick - legend_vmin) / (legend_vmax - legend_vmin)
            ) * legend_height
            ax.plot([legend_x - 3, legend_x], [tick_y, tick_y],
                    color="#ffffff", linewidth=0.8, alpha=0.85, zorder=9)
            ax.plot([legend_x + legend_width, legend_x + legend_width + 3],
                    [tick_y, tick_y], color="#ffffff", linewidth=0.8,
                    alpha=0.85, zorder=9)
            ax.text(legend_x + legend_width + 9, tick_y, str(tick),
                    fontsize=9.5, ha="left", va="center",
                    color="#1a1a1a", zorder=9)

        marker_y = legend_bottom + (
            (fence_height - legend_vmin) / (legend_vmax - legend_vmin)
        ) * legend_height
        ax.plot([legend_x - 14, legend_x], [marker_y, marker_y],
                color="#1a1a1a", linewidth=0.8,
                linestyle=(0, (3, 2)), zorder=9)
        ax.text(legend_x - 16, marker_y, str(int(round(fence_height))),
                fontsize=10.5, ha="right", va="center",
                fontweight="bold", color="#1a1a1a", zorder=9)

    # Clean up axes
    ax.set_aspect("equal")
    ax.set_xlim(layout_min_x, layout_max_x)
    ax.set_ylim(layout_min_y, layout_max_y)
    ax.axis("off")
    fig.subplots_adjust(left=0.02, right=0.98, top=0.98, bottom=0.02)

    # Save at high DPI
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    fig.savefig(output_path, dpi=300, bbox_inches="tight",
                facecolor="white", edgecolor="none")
    plt.close(fig)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="HR Analysis Engine")
    parser.add_argument("--launch_speed", type=float, required=True)
    parser.add_argument("--launch_angle", type=float, required=True)
    parser.add_argument("--hit_distance", type=float, required=True)
    parser.add_argument("--hc_x", type=float, required=True)
    parser.add_argument("--hc_y", type=float, required=True)
    parser.add_argument("--plate_z", type=float, default=3.5)
    parser.add_argument("--home_team", type=str, required=True)
    parser.add_argument("--player_name", type=str, default="Unknown")
    parser.add_argument("--player_id", type=str, default=None)
    parser.add_argument("--pitcher_name", type=str, default="Unknown")
    parser.add_argument("--output_image", type=str, required=True)
    parser.add_argument("--fences_path", type=str, required=True)
    parser.add_argument("--stadium_paths", type=str, default=None)

    args = parser.parse_args()

    # Load fence data
    with open(args.fences_path, "r") as f:
        fences_data = json.load(f)

    # Load stadium paths (optional, for full stadium outlines)
    stadium_paths = None
    if args.stadium_paths and os.path.exists(args.stadium_paths):
        with open(args.stadium_paths, "r") as f:
            stadium_paths = json.load(f)

    # Compute spray angle
    spray_angle = compute_spray_angle(args.hc_x, args.hc_y)
    direction = spray_direction(spray_angle)

    # Analyze all parks
    parks_cleared, parks_not_cleared, park_details = analyze_all_parks(
        args.launch_speed, args.launch_angle, args.hit_distance,
        args.plate_z, spray_angle, args.home_team, fences_data
    )

    total_dongs = len(parks_cleared)

    # Get fence height at home park for image
    home_fence_pt = find_nearest_fence_point(
        spray_angle, fences_data.get(args.home_team, {}).get("fence_points", [])
    )
    home_fence_height = home_fence_pt["fence_height"] if home_fence_pt else None

    # Generate image
    try:
        generate_image(
            fences_data, args.home_team, spray_angle, args.hit_distance,
            args.hc_x, args.hc_y, args.player_name,
            args.launch_speed, args.launch_angle,
            total_dongs, parks_cleared, args.pitcher_name, args.output_image,
            stadium_paths=stadium_paths, fence_height=home_fence_height,
            player_id=args.player_id
        )
        image_generated = True
    except Exception as e:
        image_generated = False
        print(f"Image generation error: {e}", file=sys.stderr)

    # Output JSON
    result = {
        "success": True,
        "spray_angle": spray_angle,
        "spray_direction": direction,
        "total_dongs": total_dongs,
        "parks_cleared": parks_cleared,
        "parks_not_cleared": parks_not_cleared,
        "park_details": park_details,
        "image_path": args.output_image if image_generated else None,
    }

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        error_result = {"success": False, "error": str(e)}
        print(json.dumps(error_result))
        sys.exit(1)
