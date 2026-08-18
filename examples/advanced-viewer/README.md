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

`?bench` runs a fixed six-stop camera walk and reports what it cost — file
size, bytes actually transferred, the percentage of the file that crossed the
wire, and per-stop fetch/decode/upload percentiles. Results render in a panel
on the page (and go to the console and `window.__copcesiumBench`).

```bash
npm run dev:src          # `stats` only exists in this repo's src/ for now
```

Then open the printed URL with the query appended:

```
http://localhost:5173/?bench            # whatever dataset loads by default
http://localhost:5173/?bench=nyc        # 26.5 GB New York City
http://localhost:5173/?bench=montreal   # 51.9 GB Montreal
```

Waypoints are offsets from the dataset's own bounding sphere, so the same walk
is comparable across datasets of very different extent. Hand-flying the camera
gives a different number every run, which is what this exists to avoid.

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
