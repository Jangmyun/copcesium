# copcesium example: advanced-viewer

A fuller reference viewer built on the published `copcesium` npm package: a
collapsible sidebar with tabbed sections (Data / Global / Appearance /
Filter / Points / Info / Help), preset datasets, per-color-mode legends, a
classification filter panel, terrain/imagery pickers, a camera/FPS HUD, and
light/dark theming.

See `examples/basic-viewer` for the minimal, unstyled reference this example
builds on top of — same public API (`CopcDataSource.load()`, live setters,
`destroy()`), just wired into a real app-shaped UI.

This is a standalone project — it installs `copcesium` from the npm
registry, not from this repo's `src/`.

## Run

```bash
npm install
cp .env.example .env   # set VITE_CESIUM_TOKEN for Cesium Ion terrain/imagery — without it,
                        # World Terrain silently falls back to a flat ellipsoid, which also
                        # throws off the camera's rotate/tilt pivot near the loaded dataset
npm run dev
```

## Benchmark

The sidebar's **Benchmark** tab measures what a session actually cost: file
size, bytes transferred, the percentage of the file that crossed the wire,
request count, and fetch/decode/upload latency percentiles.

```bash
npm run dev:src          # `stats` only exists in this repo's src/ for now
```

Two ways to use it, answering different questions:

**Fly the camera yourself.** Open the tab and the numbers tick as you drag and
zoom. Every session differs, so this can't prove an optimization helped — but
for "what did looking at this dataset cost me", a real viewing session is the
more honest measurement.

**Run the fixed walk.** The button drives a scripted six-stop route (zooming
from 2.5x the dataset radius down to 0.25x, orbiting, then pulling back).
Reproducible, so two builds can be compared. Waypoints are offsets from the
dataset's own bounding sphere, which makes the same walk meaningful for an
81 MB file and a 51.9 GB one alike. Flight time scales with the distance
covered, so the camera never outruns the loader.

`?bench` runs the walk automatically once the page loads, and
`?bench=<preset>` picks the dataset first:

```
http://localhost:5173/?bench=autzen     # 81 MB
http://localhost:5173/?bench=nyc        # 26.5 GB
http://localhost:5173/?bench=montreal   # 51.9 GB
```

Results also go to the console and `window.__copcesiumBench`.

## Build

```bash
npm run build
npm run preview
```

## Developing against this repo's `src/` instead

`npm run dev:src` runs the same example but aliases the `copcesium` import to
`../../src`, so a change to this repo's source is visible in the browser
immediately via Vite HMR — no build, `npm pack`, or publish step. `main.ts`
and `index.html` are unchanged; only where `copcesium` resolves to differs.

`npm run dev` (no `:src`) remains the way to verify the *published* package,
since it installs `copcesium` from the npm registry like a real consumer.
