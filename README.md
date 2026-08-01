# Aim 3D

A first person gridshot: the mouse turns a camera, not a cursor. Part of
[Maybaah's Arcade](https://maybaah.github.io/arcade/).

**Play:** https://maybaah.github.io/aim3d/

## Rules

- Three spheres stand on a wall ten metres out. Break one and another appears.
- A run is 30 kills. The clock runs from the first shot to the last kill.
- A miss costs 0.25s, not the run.
- Three sizes, three boards: **easy** (r 0.55), **medium** (r 0.35), **hard**
  (r 0.22), in a world where the wall spans 9 by 5 metres.
- Escape gives the mouse back and ends the run where it stands, because the tape
  is wall time and a paused run has none.
- A blip marks a kill, a low thud a miss. `M` mutes.

## Sensitivity

Yours, in whatever units you keep it: cm/360 with your DPI, the raw CS or Source
number, the raw Valorant number, or degrees per count if you would rather say it
directly.

| Preset | Degrees per count |
| :-- | :-- |
| cm/360 | `360 / (cm360 / 2.54 * dpi)` |
| CS / Source | `0.022 * sens` |
| Valorant | `0.07 * sens` |
| deg / count | the number itself |

Where the browser supports it the camera asks for raw mouse input
(`requestPointerLock({ unadjustedMovement: true })`) so pointer acceleration
stays out of the way. That is a Chromium feature today; elsewhere the operating
system still scales the deltas, so the feel is consistent but not identical to a
native trainer reading the mouse directly. That is the honest ceiling of a page.

Settings live in the shared `maybaah:arcade:v1` store under `prefs.aim3d`, so
the arcade keeps one key rather than one per cabinet.

## How a run is verified

Nothing is submitted but evidence: the seed and a tape of every shot, each one
`<ms since the last shot><h|m><yaw>,<pitch>;` with the angles in thousandths of
a degree. The spheres come out of the seed alone, so `arcade-leaderboard`
rebuilds the pool, turns each angle back into a ray, fires it itself, and adds
up the clock and the penalties.

Sensitivity is not in the tape and is not trusted: it only decides how many
degrees a mouse count is worth on the way in, which is the player's own
business, exactly like their DPI.

A tape whose own marks disagree with the replay is rejected, with one exception
worth knowing: a shot within `AIM3_EPS` (a millionth of the radius) of a
silhouette is taken as the page called it, because that is the width of the
disagreement two builds of the same engine can have about a sine. Nothing can be
aimed at that precision.

The block between the `── the engine ──` markers in [`game.js`](game.js) is
duplicated byte for byte in `site/worker/src/index.js`.

What no replay can defend is the clock: the gaps are the browser's own
timestamps. The Worker holds a floor of 40ms and a ceiling of 20s under and over
each of them, and computes the score itself, which is as far as a shooting game
gets.

## Boards

| Board | What |
| :-- | :-- |
| `easy` / `medium` / `hard` | all-time, one row per player, best run counts |
| `<mode>-<YYYYMMDD>` | the same run on the day it was played, dated by the Worker |

## Stack

Vanilla HTML/CSS/JS, no build step, no dependencies. The renderer is a hand
written perspective projection onto a 2D canvas: no WebGL, no shaders, no
matrices beyond a camera basis. Design system, arcade client and leaderboard API
come from
[Maybaah.github.io](https://github.com/Maybaah/Maybaah.github.io).
