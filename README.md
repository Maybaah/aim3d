# Aim 3D

A first person gridshot: the mouse turns a camera, not a cursor. Part of
[Maybaah's Arcade](https://maybaah.github.io/arcade/).

**Play:** https://maybaah.github.io/aim3d/

## Scenarios

Three spheres stand on a wall ten metres out. Break one and another appears.

| Scenario | Board | What ranks it |
| :-- | :-- | :-- |
| **30 kills** | `<mode>` | the clock, first shot to thirtieth kill, plus 0.25s per miss |
| **60 seconds** | `sprint-<mode>` | kills taken in one minute, ties to whoever wasted fewer shots |
| **Tracking** | `track-<mode>` | milliseconds the crosshair was on a single moving sphere, out of a minute |

The tracking path is the **Worker's** to choose, not the page's: it comes from
the day and the mode, so everyone gets the same minute on the same day. A run
that picks its own seed can go hunting for a lazy sphere, and that is not a run.

## Rules

- A miss costs 0.25s, not the run.
- Three seconds of countdown before the clock starts.
- `1` `2` `3` pick the difficulty, `4` `5` `6` the scenario, and both live on
  the view itself so they are still there in full screen.
- Leaving the tab mid run voids it, because a run is wall time and a hidden tab
  stops drawing but not counting.
- Three sizes, three boards: **easy** (r 0.55), **medium** (r 0.35), **hard**
  (r 0.22), in a world where the wall spans 9 by 5 metres.
- Escape gives the mouse back and ends the run where it stands, because the tape
  is wall time and a paused run has none.
- A blip marks a kill, a low thud a miss. `M` mutes.
- `F` fills the screen. The view letterboxes to 16:9 rather than stretching,
  because the aiming would lie if it stretched, and the canvas is redrawn at the
  size it is shown at rather than blown up from 960 wide. Go full screen before
  a run: some browsers drop the pointer lock when the window changes shape, and
  a released mouse ends the run.

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
| `easy` / `medium` / `hard` | 30 kills, all-time, one row per player |
| `sprint-<mode>` | kills in a minute |
| `track-<mode>` | milliseconds on target |
| `<board>-<YYYYMMDD>` | the same run on the day it was played, dated by the Worker |

The 30 kill boards keep the bare mode name they shipped with, so the runs
already standing on them stayed where they were when the other two arrived.

## Watching a run back

A shot run's tape is small enough to keep, so the Worker stores it on the row
and `GET /api/replay?game=aim3d&board=…&rid=…` hands it back. Rows with a tape
grow a **watch** button on the board, and the page plays the run against the
same seed: the pool moves as it moved, and every shot lands where it landed.
The camera between shots is walked from one recorded angle to the next, because
the tape holds where each shot was aimed and not the path taken to get there.

Tracking runs keep no tape: a minute of it is eighteen hundred samples, which
has no business in a leaderboard row.

## Stack

Vanilla HTML/CSS/JS, no build step, no dependencies. The renderer is a hand
written perspective projection onto a 2D canvas: no WebGL, no shaders, no
matrices beyond a camera basis. Design system, arcade client and leaderboard API
come from
[Maybaah.github.io](https://github.com/Maybaah/Maybaah.github.io).
