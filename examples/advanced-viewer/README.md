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

### Tuning options

Options with no UI can be set from the query string, so a sweep needs no edit
and no dev-server restart:

```
http://localhost:5173/?bench=nyc&concurrency=5&maxConcurrentRequests=24
http://localhost:5173/?bench=nyc&maxVisibleNodes=400&maxPoints=20000000
```

Vary one at a time, alternate the order across repeats rather than running
all of one setting back to back, and keep DevTools open with "Disable cache"
checked — a second run over the same walk otherwise serves from the HTTP
cache and reads as a win for whichever setting went second.

`concurrency`, `maxConcurrentRequests`, `maxCacheNodes`, `maxCacheBytes`,
`maxVisibleNodes`, `maxPoints`, `debounceMs`, and `lodHysteresis` are accepted; anything
non-numeric is ignored with a console warning. `sseThreshold` is deliberately
not here — it has a slider, and two sources for one value would fight. The
values in effect are recorded in the walk's JSON under `options`, so two
pasted results can be told apart.

### Reading the numbers

Compare configurations with `totalLoadMs`, not `totalConvergeMs`. Every stop
ends with a fixed `SETTLE_MS` quiet period used to decide the view has
stopped changing; across six stops that is a constant ~3.8 s, roughly half a
typical walk, and leaving it in halves the apparent size of any difference.
`loadMs` is `convergeMs` with it removed, and `bytesPerSec` is computed over
`loadMs` for the same reason.

`convergeMs`, `loadMs`, `bytesDelta`, `requestsDelta`, `nodesDelta`, and
`bytesPerSec` are scoped to a single stop. The `session*` percentiles are not: they are
snapshots of the data source's rolling window taken on arrival, so a stop that
transfers nothing still reports whatever the window held, and consecutive
stops often repeat a value. Compare configurations with `totalConvergeMs` and
`bytesPerSec`, not with the percentiles.

`nodes decoded` and `nodes on GPU` differ by design. A node that is decoded
but never drawn — the camera moved on, or it lost a budget cut — never builds
its GPU buffers, so the second number trails the first.

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
