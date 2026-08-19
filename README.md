<p align="center">
  <img src="./assets/icon.png" width="120" alt="copcesium icon" />
</p>

# [copcesium](https://github.com/Jangmyun/copcesium) &middot; [![npm version](https://img.shields.io/npm/v/copcesium.svg)](https://www.npmjs.com/package/copcesium) [![CI](https://github.com/Jangmyun/copcesium/actions/workflows/ci.yml/badge.svg)](https://github.com/Jangmyun/copcesium/actions/workflows/ci.yml) [![Publish](https://github.com/Jangmyun/copcesium/actions/workflows/publish.yml/badge.svg)](https://github.com/Jangmyun/copcesium/actions/workflows/publish.yml) [![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Jangmyun/copcesium/blob/main/LICENSE) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/Jangmyun/copcesium/issues) [![Lines](https://img.shields.io/badge/lines-92.51%25-brightgreen.svg?style=flat)](https://github.com/Jangmyun/copcesium/actions/workflows/ci.yml)

<table align="center">
  <tr>
    <td width="50%" align="center">
      <img src="./assets/demo-autzen.gif" width="100%" alt="copcesium streaming the Autzen Stadium COPC survey onto the CesiumJS globe" />
      <br /><sub><b>Autzen Stadium</b> — Oregon, USA · ~81 MB</sub>
    </td>
    <td width="50%" align="center">
      <img src="./assets/demo-niagara.gif" width="100%" alt="copcesium streaming a dense urban COPC tile of the Niagara Region" />
      <br /><sub><b>Niagara Region</b> — Ontario, Canada · ~140 MB</sub>
    </td>
  </tr>
</table>

[한국어 README](./README.ko.md)

CesiumJS provider for real-time [COPC](https://copc.io/) (Cloud Optimized Point Cloud) streaming and rendering.

**▶ [Try the live demo](https://copcesium.vercel.app/)** — streams multi-gigabyte public COPC files straight from S3 in your browser. No install, no Cesium Ion token.

- **Streaming, not loading:** only the octree nodes visible to the current camera are fetched, over HTTP Range Requests — never the whole file.
- **Off the main thread:** LAZ decompression and coordinate transforms run in a pool of reused Web Workers, so decoding never blocks the UI.
- **Level of detail:** a screen-space-error-driven octree walk decides what to subdivide, so point density matches what the camera can actually resolve, and a node is only ever swapped out once its replacement is ready to show — no flash of empty space mid-transition.
- **CRS-aware:** auto-detects the source coordinate system (including compound CRSes with a non-meter vertical unit) from the file's own WKT metadata, with a proj4-backed EPSG fallback table.
- **Live-tunable:** `pixelSize`, `sseThreshold`, and the whole [styling API](#styling) can be adjusted on a running data source with no reload.
- **Genuinely drop-in:** the published package is a single self-contained `.mjs` file — the Worker and its `laz-perf` WASM module are compiled inline at build time, so there's no separate asset for your bundler to lose track of.

> 📖 **In-depth documentation lives in the [wiki](https://github.com/Jangmyun/copcesium/wiki):** [Architecture](https://github.com/Jangmyun/copcesium/wiki/Architecture) · [Options & Tuning](https://github.com/Jangmyun/copcesium/wiki/Options-and-Tuning) · [Coordinate Systems](https://github.com/Jangmyun/copcesium/wiki/Coordinate-Systems) · [Converting to COPC](https://github.com/Jangmyun/copcesium/wiki/Converting-to-COPC) · [Troubleshooting](https://github.com/Jangmyun/copcesium/wiki/Troubleshooting). This README is the quick reference.

## Table of contents

- [Demo](#demo)
- [Installation](#installation)
- [Setup](#setup)
- [Quick start](#quick-start)
- [Options](#options)
- [API reference](#api-reference)
- [Requirements: HTTP Range Requests and CORS](#requirements-http-range-requests-and-cors)
- [Coordinate systems](#coordinate-systems)
- [Example](#example)
- [Roadmap](#roadmap)
- [Credits](#credits)
- [License](#license)

## Demo

**[copcesium.vercel.app](https://copcesium.vercel.app/)** runs the [`advanced-viewer`](./examples/advanced-viewer) example against public COPC datasets — from the ~81 MB Autzen Stadium survey up to New York City (26.5 GB, 4.76 B points) and Montréal (51.9 GB, 9.72 B points). Nothing is downloaded up front: pan and zoom, and watch only the octree nodes the camera can see get fetched.

It opens on the WGS84 ellipsoid with OpenStreetMap imagery, so no Cesium Ion token is needed. Supply one and Cesium World Terrain and satellite imagery become selectable from the Global tab.

<!-- Walkthrough video slot. Replace VIDEO_ID with the YouTube id, then uncomment:
<p align="center">
  <a href="https://www.youtube.com/watch?v=VIDEO_ID">
    <img src="https://img.youtube.com/vi/VIDEO_ID/maxresdefault.jpg" width="760" alt="Watch the copcesium walkthrough" />
  </a>
</p>
-->

## Installation

```bash
npm install copcesium cesium
```

`cesium` is a peer dependency (`>=1.100.0`) — install whichever version your app already uses. copcesium is **ESM-only** (no CommonJS build): the Worker and its `laz-perf` WASM are inlined into a single `.mjs` at build time, which needs `import.meta.url` semantics that `require()` can't provide.

## Setup

copcesium itself needs no setup — its Worker and WASM are inlined into the published `.mjs`, so there's no side asset to wire up. **CesiumJS does**: it fetches `Workers/`, `Assets/`, `Widgets/`, and `ThirdParty/` at runtime, and a bundler won't find those on its own. Skipping this step leaves a blank page and 404s in the console.

With Vite, [`vite-plugin-cesium`](https://www.npmjs.com/package/vite-plugin-cesium) handles it:

```bash
npm install -D vite-plugin-cesium
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({ plugins: [cesium()] });
```

Cesium also renders into an element you provide, which needs an explicit height — a container with no height produces a 0px canvas, which looks exactly like a broken build:

```html
<!-- index.html -->
<style>
  html, body, #cesiumContainer { margin: 0; width: 100%; height: 100%; overflow: hidden; }
</style>

<div id="cesiumContainer"></div>
<script type="module" src="/main.ts"></script>
```

On another bundler, do the same two things by hand: copy `node_modules/cesium/Build/Cesium/{Assets,ThirdParty,Widgets,Workers}` into your static output, and point Cesium at them before the first `import`:

```js
window.CESIUM_BASE_URL = '/cesium/';
```

## Quick start

```ts
import * as Cesium from 'cesium';
import { CopcDataSource } from 'copcesium';

const viewer = new Cesium.Viewer('cesiumContainer');

const dataSource = await CopcDataSource.load(
  'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
  viewer,
);
```

That's it — `load()` fetches the COPC hierarchy, auto-detects the source coordinate system from the file's WKT (when present), flies the camera to the dataset, and starts streaming nodes as the camera moves. See [`examples/basic-viewer/main.ts`](./examples/basic-viewer/main.ts) for a slightly larger example with a URL input, live `pixelSize`/`sseThreshold` sliders, and error handling.

If the file's WKT doesn't fully describe the CRS (or is missing), pass it explicitly:

```ts
const dataSource = await CopcDataSource.load(url, viewer, {
  proj: 'EPSG:2992',
  projDef:
    '+proj=lcc +lat_1=43 +lat_2=45.5 +lat_0=41.75 +lon_0=-120.5' +
    ' +x_0=399999.9999999999 +y_0=0 +datum=NAD83 +units=ft +no_defs',
  geoidOffset: -20, // meters, local geoid separation from the WGS84 ellipsoid
});
```

When you're done with a data source:

```ts
dataSource.destroy();
```

## Options

All fields on the third argument to `CopcDataSource.load()` are optional.

```ts
interface CopcDataSourceOptions {
  proj?: string;
  projDef?: string | null;
  geoidOffset?: number;
  concurrency?: number;
  maxConcurrentRequests?: number;
  debounceMs?: number;
  maxCacheNodes?: number;
  maxCacheBytes?: number;
  maxVisibleNodes?: number;
  maxPoints?: number;
  pixelSize?: number;
  sseThreshold?: number;
  zFactor?: number;
  xyFactor?: number;
  autoFrame?: boolean;
  colorMode?: 'rgb' | 'intensity' | 'classification' | 'elevation';
  opacity?: number;
  classificationFilter?: number[];
  intensityRange?: [number, number];
}
```

| Option | Default | Description |
| --- | --- | --- |
| `proj` | `'EPSG:4326'` | Source CRS identifier. Auto-detected from the file's WKT when omitted. |
| `projDef` | `null` | proj4 definition string for `proj`, when proj4 doesn't already know it. |
| `geoidOffset` | `0` | Meters to add to every point's height — local geoid separation from the WGS84 ellipsoid, if the file's vertical datum isn't already ellipsoidal. |
| `zFactor` | auto-detected | Factor converting the file's Z unit to meters. Detected from the WKT's vertical unit when present, even if `proj`/`projDef` is overridden. |
| `xyFactor` | auto-detected | Factor converting the file's XY unit to meters (used for bounding-sphere sizing). |
| `concurrency` | `5` | Number of Worker threads decoding nodes in parallel. Ignored if a `workerPool` is passed to `load()`. |
| `maxConcurrentRequests` | = `concurrency` | HTTP Range Requests in flight at once. Fetching is latency-bound and decoding is CPU-bound, so they saturate at different widths; raise this instead of `concurrency` to widen fetching without spawning workers that have nothing to do. |
| `debounceMs` | `100` | Minimum interval between full LoD re-selection passes. A lighter frustum-only visibility check still runs every frame. |
| `maxCacheNodes` | `150` | Maximum nodes kept in memory (LRU) before the least-recently-used, currently-unselected ones are torn down. |
| `maxCacheBytes` | none | Maximum estimated bytes kept in memory, on top of `maxCacheNodes` — evicts on whichever limit is hit first. Estimated as `pointCount * 21` per node (the fixed per-point buffer layout). Unset by default, since a sensible value depends on the dataset's typical points-per-node. |
| `maxVisibleNodes` | `100` | Maximum nodes selected for rendering in a single LoD pass. |
| `maxPoints` | `5,000,000` | Maximum total points across selected nodes in a single LoD pass, on top of `maxVisibleNodes`. |
| `pixelSize` | `2` | Point size in pixels. Live-adjustable after load via `dataSource.pixelSize`. |
| `sseThreshold` | `250` | Screen-space error (pixels) above which a node is subdivided into children. Lower = more detail, more nodes loaded. Live-adjustable via `dataSource.sseThreshold`. |
| `autoFrame` | `true` | Whether `load()` flies the camera to the dataset before resolving. Set `false` if you're managing the camera yourself. |
| `colorMode` | `'rgb'` | How points are coloured. Live-adjustable via `dataSource.colorMode`. See [Styling](#styling). |
| `opacity` | `1` | Alpha multiplier applied to every point's colour. Below `1`, points draw translucent with no per-point depth sort. Live-adjustable via `dataSource.opacity`. |
| `classificationFilter` | all codes | LAS classification codes to draw; everything else is dropped. Live-adjustable via `dataSource.classificationFilter`. |
| `intensityRange` | auto | Raw intensity values at the two ends of the `'intensity'` ramp. Grows to `[0, highest seen]` as nodes load when omitted. |

## API reference

### `CopcDataSource.load(url, viewer, options?, workerPool?): Promise<CopcDataSource>`

Static factory — `CopcDataSource` has no public constructor. Resolves once the hierarchy is loaded (and, if `autoFrame` is enabled, once the camera has finished flying to the dataset).

- `url: string` — URL of the `.copc.laz` file. Must support HTTP Range Requests (see below).
- `viewer: Cesium.Viewer`
- `options?: CopcDataSourceOptions` — see [Options](#options).
- `workerPool?: WorkerPool` — internal parameter, not part of the public API yet ([issue #51](https://github.com/Jangmyun/copcesium/issues/51) tracks exposing it for cross-data-source reuse). Omit it; each `load()` gets its own pool sized by `concurrency`.

### Instance members

```ts
class CopcDataSource {
  pixelSize: number;
  sseThreshold: number;
  colorMode: ColorMode;
  opacity: number;
  classificationFilter: number[] | undefined;
  intensityRange: [number, number];
  heightOffset: number;
  readonly maxDepth: number;
  readonly nodeCount: number;
  readonly cacheSize: number;
  zoomTo(): Promise<void>;
  destroy(): void;
}
```

| Member | Description |
| --- | --- |
| `pixelSize` | Get/set. Updates every currently-rendered node's point size immediately, no reload. |
| `sseThreshold` | Get/set. Triggers an immediate LoD re-selection pass when set. |
| `colorMode` | Get/set. Repaints every loaded node on the next frame — no refetch, no re-decode. |
| `opacity` | Get/set. Updates every currently-rendered node's translucency immediately, no reload. Throws `RangeError` outside 0-1. |
| `classificationFilter` | Get/set. Assign `undefined` to draw everything again. Throws `RangeError` on a value outside 0-255. |
| `intensityRange` | Get/set. Assign `undefined` to hand the range back to auto. |
| `heightOffset` | Get/set. Vertical offset in meters applied to every loaded point, for manually correcting a geoid/vertical-datum mismatch after load — moves the model matrix, not the geometry, so it updates immediately with no reload. Defaults to `0`. |
| `maxDepth` | Read-only. Deepest octree level present in the loaded hierarchy. |
| `nodeCount` | Read-only. Total nodes in the hierarchy (loaded or not). |
| `cacheSize` | Read-only. Nodes currently retained in the LRU cache. |
| `zoomTo()` | Flies the camera to the dataset's root bounding sphere. Called internally by `load()` when `autoFrame` is enabled; call it again yourself to re-frame later. |
| `destroy()` | Tears down the Worker pool (unless it was externally provided), the node cache, and every loaded primitive. Idempotent. |

## Styling

Every point ships to the GPU with its colour, raw intensity, classification, and
normalized elevation, and the colour is chosen in the vertex shader. Switching
modes or filters is therefore a uniform update — no HTTP request, no LAZ decode,
and the node cache is untouched.

```ts
const ds = await CopcDataSource.load(url, viewer);

ds.colorMode = 'classification';   // 'rgb' | 'intensity' | 'classification' | 'elevation'
ds.classificationFilter = [2, 6];  // draw only ground and buildings
ds.classificationFilter = undefined; // ...and back to everything
ds.opacity = 0.5;                  // 0..1, alpha blending below 1
```

| Mode | What it draws |
| --- | --- |
| `'rgb'` | The file's own Red/Green/Blue. Falls back per point to the classification palette, then to flat grey, when the file has no colour. |
| `'intensity'` | Greyscale over `intensityRange`. |
| `'classification'` | The ASPRS palette below, applied unconditionally — unlike the `'rgb'` fallback, this works on a file that *does* have colour. |
| `'elevation'` | Blue → cyan → green → yellow → red over the file header's full Z range. |

The classification palette covers the ASPRS codes below; anything else draws in
light grey.

| Code | Class | Code | Class |
| --- | --- | --- | --- |
| 2 | Ground | 9 | Water |
| 3 | Low Vegetation | 10 | Rail |
| 4 | Medium Vegetation | 11 | Road Surface |
| 5 | High Vegetation | | |
| 6 | Building | | |

Filtered-out points are discarded in the vertex shader, so filtering hides
points rather than reclaiming their GPU memory.

## Requirements: HTTP Range Requests and CORS

copcesium fetches only the bytes it needs (COPC header, hierarchy pages, individual node point data) via HTTP Range Requests, not the whole file. Wherever you host `.copc.laz` files, the server must:

- Support `Range` request headers and respond with `206 Partial Content` (Amazon S3, most static hosts, and CDNs do this by default).
- Send CORS headers (`Access-Control-Allow-Origin`) permitting your app's origin, since these are cross-origin `fetch()` calls unless the file is served from the same origin as your app.

For CORS, Range Request, and misplaced-cloud problems, see the [Troubleshooting](https://github.com/Jangmyun/copcesium/wiki/Troubleshooting) wiki page.

## Coordinate systems

`CopcDataSource` auto-detects the source CRS and unit-conversion factors from the COPC file's WKT VLR when present — including compound CRSes (separate horizontal + vertical definitions, e.g. a state-plane CRS in feet with a NAVD88 vertical datum). If detection fails or you need to override it, pass `proj`/`projDef` explicitly (see [Options](#options)).

Full details — the detection flow, the proj4 fallback table, vertical-unit (`zFactor`) handling, and a coordinate-debugging checklist — are on the [Coordinate Systems](https://github.com/Jangmyun/copcesium/wiki/Coordinate-Systems) wiki page.

## Example

[`examples/basic-viewer`](./examples/basic-viewer) is a minimal, standalone project that installs `copcesium` from the npm registry (not from this repo's `src/`) — a URL input, `pixelSize`/`sseThreshold` sliders, a `colorMode` picker, per-class filter checkboxes, a "Remove & reload" button, and an on-screen error area. It loads a public sample dataset ([Autzen Stadium](https://github.com/PDAL/data/tree/main/autzen)) automatically.

[`examples/advanced-viewer`](./examples/advanced-viewer) is the fuller reference built on the same public API — a collapsible icon rail and tabbed sidebar, preset datasets, per-color-mode legends, terrain/imagery pickers, a camera/FPS HUD, and light/dark theming. **This is what [the live demo](https://copcesium.vercel.app/) runs.**

copcesium is framework-agnostic, but a large share of Cesium usage happens through React — two more examples show that integration:

- [`examples/react/react-viewer`](./examples/react/react-viewer) — the same minimal viewer, from a plain React component (`useRef`/`useEffect`, no wrapper library).
- [`examples/react/react-resium-viewer`](./examples/react/react-resium-viewer) — a styled sidebar viewer built on [resium](https://resium.reearth.io/), reaching `copcesium`'s imperative API via resium's `useCesium()` hook.

```bash
git clone https://github.com/Jangmyun/copcesium.git
cd copcesium/examples/basic-viewer
npm install
cp .env.example .env   # optionally set VITE_CESIUM_TOKEN for Cesium Ion imagery
npm run dev
```

Then open the printed local URL in a browser. Each example under `examples/` is run the same way — `npm install && npm run dev` from its own directory.

## Roadmap

Known limitation, not yet planned as a full feature:

- Exposing `workerPool` as a public parameter so a `WorkerPool` can be reused across multiple `CopcDataSource` instances ([issue #51](https://github.com/Jangmyun/copcesium/issues/51)). Currently each `load()` creates its own pool.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for how to build, test, and
submit a pull request. This project follows a [Code of Conduct](./.github/CODE_OF_CONDUCT.md). To report
a security vulnerability, see [SECURITY.md](./.github/SECURITY.md).

## Credits

- [`copc`](https://github.com/connormanning/copc.js) — COPC parsing (header/hierarchy/point data, over HTTP Range Requests)
- [`laz-perf`](https://github.com/hobuinc/laz-perf) — WASM LAZ decompression
- [`proj4`](https://github.com/proj4js/proj4js) — coordinate system transforms
- [CesiumJS](https://cesium.com/platform/cesiumjs/) — 3D globe rendering

## License

copcesium is [MIT licensed](./LICENSE). The distributed build bundles third-party open-source code whose licenses and notices are collected in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md). See [CHANGELOG.md](./CHANGELOG.md) for release history.
