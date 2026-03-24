# Claude Code Prompt — Enhanced HR Discord Bot

## Overview

Improve the existing Discord HR bot that detects home runs by specific MLB players and sends a Discord message. The bot runs on a Raspberry Pi. Keep all existing functionality intact and add the following enhancements to the Discord message.

## New Features

### 1. Enhanced Stats in the Message

When a home run is detected, the Discord message should now include:

- **Exit velocity** (mph)
- **Launch angle** (degrees)
- **Projected distance** (feet)
- **How many of the 30 MLB ballparks this HR would clear** (e.g., "⚾ Dinger in 27/30 MLB parks")
- **Season HR count** for that player (e.g., "HR #14 on the season")

All of this data is available from MLB's Statcast system. Use the Baseball Savant Statcast search endpoint (`baseballsavant.mlb.com/statcast_search`) or the MLB Stats API (`statsapi.mlb.com`) to pull exit velocity (`launch_speed`), launch angle (`launch_angle`), and hit distance (`hit_distance_sc`). For the season HR count, query the player's season stats via the MLB Stats API.

### 2. Ballpark Overlay Image (attached to the Discord message)

Generate an image similar to what the [@would_it_dong](https://x.com/would_it_dong) Twitter bot produces. This image should be **generated programmatically by the bot** (not pulled from an external source) and attached to the Discord embed. It should include:

#### Ballpark Outline
- Draw a top-down outline of the ballpark where the HR was hit, showing the outfield fence shape.
- Use fence distance data at various spray angles for all 30 MLB parks. The best open-source dataset for this is the `fences.rds` file from the [dinger-machine](https://github.com/danmorse314/dinger-machine) project. Convert this R data to JSON or CSV for use in Python. Alternatively, compile fence distances and wall heights from [Clem's Baseball](http://www.andrewclem.com/Baseball/Dimensions.html) and official MLB sources.
- The fence data should include **distance from home plate** and **wall height** at multiple angles across the outfield arc for each park.

#### Ball Flight Path
- Plot the projected landing spot of the HR based on the spray angle and distance from Statcast data.
- Draw a line or arc from home plate to the landing spot.
- Visually distinguish whether the ball cleared the fence (it did — it's a HR) and by how much.

#### Wall Height Reference
- Optionally include a small side-view inset or label showing the wall height at the point where the ball crossed the fence vs. the height of the ball at that point.

#### Stats Overlay on the Image
- Display on the image: exit velo, launch angle, projected distance.
- Display the "X/30 parks" result prominently.
- Include the player name, opponent pitcher (if available), and team hashtag or logo.

#### Image Generation Approach
- Use **Python** with **matplotlib** or **Pillow (PIL)** to generate the image. Matplotlib is well-suited for plotting the polar/cartesian ballpark outline and ball flight path.
- The image should be saved as a PNG and attached to the Discord message embed.
- Keep image generation fast and lightweight — this runs on a Raspberry Pi.

### 3. "Would It Dong?" Calculation

To determine how many parks the HR would be a home run in:

1. From Statcast, get the HR's **exit velocity**, **launch angle**, and **spray angle** (derived from `hc_x` and `hc_y` hit coordinates).
2. Using projectile motion physics (accounting for gravity; optionally drag), calculate the ball's **distance traveled** and **height at each fence distance** for all 30 parks at the appropriate spray angle.
3. Compare the ball's height at the fence distance to the **wall height** at that spray angle for each park.
4. If the ball clears the wall → it's a dong in that park. Count the total.

Reference implementation: The [dinger-machine](https://github.com/danmorse314/dinger-machine) repo (`dinger_calculation.R`) does exactly this in R. Port the logic to Python. Key physics:

```
# Simplified projectile motion (no drag)
g = 32.174  # ft/s^2
v0 = exit_velocity (converted to ft/s)
theta = launch_angle (radians)
# Time to reach fence distance d at spray angle:
# horizontal velocity component in the spray direction
# Height at that time vs. wall height
```

For better accuracy, include air drag. The dinger-machine uses a more detailed model. Start simple and iterate.

### 4. Season HR Count

Query the MLB Stats API for the player's current season hitting stats to get their HR total. Endpoint: `statsapi.mlb.com/api/v1/people/{playerId}/stats?stats=season&season={year}&group=hitting`

## Technical Notes

- **Raspberry Pi constraints**: Keep dependencies lightweight. Matplotlib is fine. Avoid heavy ML/image libraries. Cache the fence data (it only changes when a park renovates — basically once a year at most). Pre-compute and store the fence profiles as a JSON file bundled with the bot.
- **Image size**: Target around 800x800 or 1000x800 pixels. Discord embeds display well at this size.
- **Timing**: Statcast data for a HR may not be available instantly. The bot may need to poll or wait a short interval after detecting the HR event before the detailed Statcast data (exit velo, launch angle, etc.) is available. Build in a retry/delay mechanism.
- **Fence data**: Include both the **distance** and **wall height** at each angle. Wall heights vary significantly (Fenway's Green Monster is 37 ft; most walls are 8-12 ft). This matters for the calculation.
- **Error handling**: If Statcast data isn't available yet for a HR, send the basic HR notification immediately and follow up with the enhanced image/stats message once data is available. Don't block the initial alert.

## Discord Message Format

The final Discord message should be an **embed** with:

- **Title**: `🚀 [Player Name] HOME RUN!`
- **Description**: `HR #[count] | [Batter Team] vs [Pitcher Name]`
- **Fields**:
  - Exit Velo: `XXX.X mph`
  - Launch Angle: `XX°`
  - Distance: `XXX ft`
  - Parks: `⚾ Dinger in XX/30 MLB ballparks`
- **Image**: The generated ballpark overlay PNG (attached)
- **Footer**: Game score, inning, or other existing info the bot already sends

## Summary

The end result: when a tracked player hits a HR, the Discord channel gets a rich embed with the ballpark visualization image showing the ball flight on the field outline, all the Statcast metrics, how many parks it would leave, and the player's season HR total. Everything generated locally on the Pi, no external image APIs needed.
