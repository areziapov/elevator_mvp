# 🛗 ELEVATOR — MVP

A crash game in the style of Aviator: a glass elevator climbs an endless skyscraper while the multiplier grows. Cash out before the cables snap.

A pure static project: `index.html` + `style.css` + `game.js`. No build step, no backend, no dependencies. Works on any static hosting (GitHub Pages, Netlify, Vercel, etc.).

## Table of Contents

- [How to Play](#how-to-play)
- [Math](#math)
- [Configuration](#configuration)

## How to Play

- Between rounds there is a 5-second countdown: the doors in the back wall of the cabin open, and passengers walk in and stand along the sides.
- **BET** during the countdown places your bet (the balance is deducted immediately). Pressing it again turns it into **CANCEL**.
- During the flight the button shows the current multiplier and the **CASH OUT** amount. The `Space` key also cashes out.
- Pressing **BET** during the flight queues a bet for the next round.
- **AUTO BET** places a bet every round.
- **AUTO CASHOUT** cashes out automatically at the specified multiplier (the value is editable right inside the button).
- The **⇄** icon opens **Provably Fair**: the hash of the server seed is published before the round, and the seed is revealed after the crash. The demo balance reset button is also there.
- The **👥** icon shows "live bets" (bots, for atmosphere).

Balance, history, and bet are saved in the browser's `localStorage`.

## Math

### Crash point

```text
r     = SHA-256(seed:round)[0..52 bits] / 2^52
crash = max(1.00, floor(100 · 0.97 / (1 − r)) / 100)
```

For any target multiplier `x`, the probability of surviving that far is ≈ `0.97 / x`, so the expected return of any strategy is **97%** (house edge **3%**). Roughly 3% of rounds are instant crashes at `1.00x`.

### Multiplier growth

```text
m(t) = e^(0.10 · t)
```

| Multiplier | Time to reach |
| ---------: | ------------: |
|         2x |          ≈ 7 s |
|         5x |         ≈ 16 s |
|        10x |         ≈ 23 s |
|       100x |         ≈ 46 s |

The exponential curve gives the "accelerating" feel of Aviator.

### Elevator speed

```text
v = 70 · m   px/s   (capped at 1500 px/s)
```

Speed is proportional to the multiplier, so the elevator accelerates along with it, and at high speed the windows blur.

## Configuration

All parameters are in the `CFG` object at the top of `game.js`.
