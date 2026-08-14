# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-08-14

### Added

- **`heightOffset` manually corrects a geoid/vertical-datum mismatch between
  the point cloud and the globe surface.** Live property on `CopcDataSource`
  (meters, default `0`), applied by shifting each node's model matrix along
  its local "up" (the ECEF direction from Earth's center through the node
  origin) rather than touching the shader or geometry, so it's a per-frame
  translation update, not a re-decode.
- **`maxPoints` option bounds the LoD render set by total point count, not
  just node count.** `maxVisibleNodes` caps how many nodes `selectNodes()`
  picks, but `Hierarchy.Node.pointCount` isn't uniform across a hierarchy, so
  the same node budget could mean very different actual point counts on
  different datasets — no way to reason directly about rendering cost (draw
  calls, GPU memory, points on screen). `selectNodes()` now also accumulates
  selected nodes' point counts and stops once `maxPoints` (default
  5,000,000) is reached, whichever of the two limits comes first.
  `maxVisibleNodes` is unchanged and still applies. (#118)
- **Opacity/translucency control.** `opacity` (`CopcDataSourceOptions.opacity`
  / live `dataSource.opacity`, `0`-`1`, default `1`, validated at both load
  time and on every assignment) is an alpha multiplier applied to every
  point's colour via a `u_opacity` uniform — a style change, not a re-decode,
  matching `pixelSize`/`colorMode`. Below `1`, the primitive switches to
  alpha blending (`Pass.TRANSLUCENT`, `depthMask: false`) only when opacity
  actually crosses the opaque threshold, not every frame. There's no
  per-point depth sort, so overlapping translucent points may blend out of
  order — sorted transparency would be a separate, larger feature. (#119)

### Fixed

- **Adjacent node fetches are coalesced into fewer HTTP Range Requests, and
  Range Request support is verified up front.** Each node's fetch moved out
  of its worker task and onto the main thread, ahead of the worker handoff —
  requests queued in the same microtask tick are exactly the sibling nodes a
  COPC writer already lays out contiguously, so sibling nodes selected in the
  same LoD pass now share one merged Range Request (capped at 512 KiB per
  group, so one slow response can't block an unbounded batch) instead of each
  firing its own. That move also dropped the concurrency limit `WorkerPool`
  used to provide implicitly (the fetch used to run inside the worker task it
  throttled); merged group fetches are now capped at the worker pool's own
  concurrency so fetch throughput can't outrun decode throughput. A server
  that ignores `Range` and returns the whole file as `200 OK` is now caught
  with a clear error up front (`loadCopcHierarchy()` probes for `206 Partial
  Content`) instead of a confusing parse failure deep inside `Copc.create()`.
  (#86)
- **COPC files whose hierarchy spans multiple pages now subdivide past
  whatever depth the root hierarchy page covered.** `loadCopcHierarchy()`
  previously read only the root page and discarded the sub-page entry points
  it returns, so zooming in on such a file silently stopped revealing more
  detail once the root page's depth was exhausted. `CopcDataSource` now
  lazily loads a needed sub-page mid-traversal, merges it into the live node
  map, and re-runs LoD selection; `maxDepth` is computed live from the
  current node map so it grows as sub-pages load instead of staying pinned
  at the root page's depth. (#116)
- **`RangeFetcher` now checks the HTTP response status and retries transient
  failures.** A non-206 response — a `5xx`, a `416`, a CDN error page, an
  expired pre-signed URL's `403`, or even a `200` from a server that ignored
  the `Range` header and sent the whole file — was previously sliced at
  range-relative offsets and handed to the decoder as if it were point data,
  so the real cause surfaced several layers down as an opaque LAZ decode
  error. `5xx` and network-level failures are now retried up to 3 times with
  cancellable exponential backoff; a `4xx` fails immediately, since an
  expired URL or a bad range won't fix itself on retry. (#117)

## [1.1.1] - 2026-08-07

### Fixed

- **In-flight node fetches are now cancelled when they fall out of the LoD
  selection.** A load still in flight for a key the camera had moved past
  kept decoding data nobody would show, holding a worker slot the current
  selection needed. `WorkerPool.run()` tasks now expose a `cancel()`, and
  `CopcDataSource` calls it for any pending key that drops out of the new
  selection each update; the resulting `AbortError` is treated as expected
  and not logged as a failure. (#86)
- **`THIRD_PARTY_LICENSES.md` no longer lists packages that aren't actually
  bundled.** `node-fetch`, `whatwg-url`, `tr46`, and `webidl-conversions`
  were listed as bundled because they're `cross-fetch`'s dependencies — but
  only for its Node.js entry point. This is a browser build, so Vite
  resolves `cross-fetch`'s browser field instead, a self-contained
  XHR-based polyfill with no dependency on that chain.

## [1.1.0] - 2026-08-03

### Added

- **Point styling API: colour by RGB, intensity, classification, or
  elevation, and filter by classification.** Colour was previously decided
  in the worker and baked into a `Uint8Array` before the main thread saw
  it, so restyling a cached node would have meant re-running `convertNode()`
  — a fresh Range Request and LAZ decode per node. The worker now ships the
  raw per-point attributes alongside the baked colour (Intensity as
  `Uint16`, Classification as `Uint8`, elevation normalized over the header
  range as `Uint16`), and the vertex shader picks the colour from a
  `u_colorMode` uniform. `colorMode`, `classificationFilter`, and
  `intensityRange` are exposed as both `CopcDataSourceOptions` and live
  setters; the classification filter is a 256-bit allow-list, and
  `intensityRange` auto-grows to the highest intensity seen unless pinned.
  `'rgb'` keeps the existing baked colour untouched, so the default path is
  unchanged. `ColorMode` is now exported from the package entry point. (#84)
- **`examples/basic-viewer` gained `colorMode` and classification-filter
  controls.** A colour-mode picker and a per-ASPRS-class checkbox row sit
  alongside the existing `pixelSize`/`sseThreshold` sliders, wired to the
  live setters so the styling API is demonstrable without a console. (#84)

### Fixed

- **`NodeCache` evicted FIFO by load time instead of LRU.** Nothing ever
  bumped an entry's recency — every read went through `peek()`, which
  deliberately doesn't bump — so the backing `Map` never left insertion
  order and `_evictOverBudget()` systematically targeted the shallow
  ancestors a zoom-out needs back. `pin()` now refreshes the recency of the
  keys it pins (the on-screen set `_updateLoD()` already hands it), making
  eviction least-recently-selected at `debounceMs` granularity. (#68)
- **`laz-perf` was an undeclared direct dependency.** `src/worker/worker.ts`
  imports `laz-perf/lib/worker` directly but relied on it resolving as
  `copc`'s transitive dependency. It's now declared explicitly so the build
  can't silently break if `copc`'s own dependency changes, and so it's
  accurately identified for license auditing. (#81)

### Changed

- **Node positions are emitted as node-relative `Float32` offsets with a
  double-precision origin baked into the primitive's model matrix.**
  Positions now leave the worker as `Float32` offsets from the node origin
  (the first point's ECEF), with the origin carried separately. This halves
  the worker→main transfer (12 vs 24 bytes/point) and removes the
  main-thread RTE high/low split (`EncodedCartesian3.encode`, run 3n times
  per node) entirely — precision now lives in the origin rather than in a
  per-coordinate split. (#85)
- Added `THIRD_PARTY_LICENSES.md` documenting the notices for `copc`,
  `laz-perf`, `proj4`, and their transitive dependencies bundled into
  `dist/copc-cesium.mjs`, as MIT/BSD-2-Clause/Apache-2.0 require on
  redistribution. (#80)

## [1.0.3] - 2026-08-03

### Fixed

- **LoD selection could still leave a gap on multi-level camera jumps.**
  `_isReplacementReady()` only checked a node's direct parent/children for
  its replacement; a camera jump that moved the selection cut two or more
  levels in a single pass matched neither, reproducing the #58 gap the
  check was meant to close. Replacement matching now uses octree
  containment at any depth via a new `isAncestorOf()`. (#66)
- **LoD selection dropped ancestor nodes, thinning the visible cloud.**
  `selectNodes()` returned only the frontier nodes it stopped subdividing
  at, discarding every ancestor on the way down. A COPC octree's node
  points are not a coarse copy of its children's — they're distinct points
  partitioning the same volume — so the visible cloud is the union of the
  root down through the current cut, not just the frontier. The full
  root-to-cut path is now rendered. (#76)
- **`examples/basic-viewer`'s lockfile pointed at a local tarball.**
  `package-lock.json` resolved `copcesium` to a leftover
  `file:../../copcesium-1.0.1.tgz` from local `npm pack` testing, which
  isn't in the repository, so `npm ci` failed with ENOENT on a fresh
  clone. Regenerated against the registry (`^1.0.2`). (#69)
- **Release workflow's regression guards never ran.**
  `.github/workflows/publish.yml` ran `npm test` before `npm run build`,
  so the two `dist/`-output regression guards in `src/build.test.ts`
  (gated on `dist/` existing) silently skipped on every CI run instead of
  catching a repeat of the worker-404 bug from #54. `npm run build` now
  runs before `npm test`. (#71)

### Changed

- Added `.github/workflows/publish.yml`, publishing to npm on GitHub
  Release via OIDC trusted publishing instead of a long-lived token. (#63)
- Added a `dev:src` mode to `examples/basic-viewer` that aliases the
  `copcesium` import to `../../src`, so source changes are visible via
  Vite HMR without a build/pack/publish step. (#72)
- Slimmed the README, moving deep-dive content to the wiki.

## [1.0.2] - 2026-07-31

### Fixed

- **`WorkerPool` could wedge or permanently fail after a bad worker.**
  `run()` now rejects (and frees its worker/queue slot) if no response
  arrives within `timeoutMs` (default 30s), so a hung Range Request or a
  wasm decode that never returns no longer leaves that node stuck forever. A
  worker that throws (`onerror`) is now terminated and replaced instead of
  being returned to the pool, so a single crashed worker doesn't fail every
  task subsequently routed to it; replacement is capped at 10 to avoid
  spinning forever against a structurally broken worker. (#44)
- **`selectNodes()` could drop visible nodes and hide populated subtrees.**
  Traversal now expands the highest screen-space-error node first (a
  max-heap keyed on SSE) instead of a FIFO queue, so when `maxVisibleNodes`
  is hit, the nodes that survive are the most visually important ones found
  so far rather than whatever order a pass happened to reach them in —
  previously, minor camera movement during zoom could reshuffle traversal
  order enough to drop a clearly-visible node from one pass to the next.
  Nodes with zero points are no longer selected as leaves regardless of
  SSE — they now always descend into their children if any exist, instead of
  a mask potentially hiding a populated child subtree behind an empty
  parent. (#45, #48)
- **LoD transitions could leave a visible gap.** `_updateLoD()` no longer
  hides a deselected node immediately; it now waits until the node's actual
  replacement (children on subdivision, parent on merge) is cached and
  shown before hiding it, keeping it visible and cache-pinned in the
  meantime. A deselected node with no such replacement in the new selection
  (e.g. it left the frustum) is still hidden immediately, as before. This
  fixed a visible flash-to-empty during zoom, most noticeable looking
  straight down at the data. (#58)

## [1.0.1] - 2026-07-31

### Fixed

- **Worker/wasm 404s in consumer builds.** `CopcDataSource.load()` previously
  constructed its Worker via `new Worker(new URL('./worker/worker.ts',
  import.meta.url))`. Our own build resolved this into a separately emitted
  chunk plus a hardcoded, root-absolute URL string
  (`new URL("/assets/worker-<hash>.js", import.meta.url)`) baked into
  `dist/copc-cesium.mjs`. That broke any real consumer in two independent
  ways:
  - A consumer's own bundler has no static import to trace through an
    already-built dependency, so it never copied the worker chunk or
    `laz-perf.wasm` into its own output — the files simply didn't exist at
    the referenced path after `vite build` (or equivalent) in a fresh app.
  - Even when the files were present (e.g. serving this repo's own `dist/`
    directly at the site root, which is how the original `npm pack`
    consumer-install check was performed), the leading `/` made the URL
    resolve from the origin root, breaking the moment the app was deployed
    under any sub-path.
  - Fix: the worker is now compiled into a Blob at our own build time
    (`?worker&inline`), and `laz-perf.wasm` is embedded inside that worker as
    a base64 string decoded to raw bytes and handed to
    `LazPerf.create({ wasmBinary })`, bypassing emscripten's `locateFile`/
    `fetch` path entirely. The published package now ships a single
    self-contained `dist/copc-cesium.mjs` with no separate worker chunk, no
    `dist/assets/`, and no runtime-fetched asset of any kind — nothing for a
    consumer's bundler or deploy path to break.
  - Added a regression test (`src/build.test.ts`) asserting the built output
    contains no `dist/assets` directory and no root-absolute `/assets/`
    reference.

### Changed

- Restructured `demo/` into `examples/basic-viewer/`, a standalone npm
  project that installs `copcesium` from the registry (not from this repo's
  `src/`), so it exercises the package the same way a real consumer does.
- Removed the now-unnecessary demo-specific dev/build wiring from the root
  `vite.config.ts` and `package.json` (`dev`/`preview` scripts,
  `vite-plugin-cesium` devDependency) — the root project now only builds the
  library.

## [1.0.0] - 2026-07-31

Initial release.

- `CopcDataSource`: COPC metadata/hierarchy loading, CRS auto-detection with
  manual `proj`/`projDef`/`geoidOffset` override, camera-driven screen-space-error
  LoD selection, a reusable `WorkerPool` for off-main-thread LAZ decoding, and
  node caching.
- ESM-only distribution (`dist/copc-cesium.mjs` + `.d.ts`); no CJS build,
  since `import.meta.url`-based Worker construction has no CJS equivalent.
- Published to npm and verified end-to-end via `npm pack` into a separate
  consumer project (ESM import, type resolution, asset presence).
