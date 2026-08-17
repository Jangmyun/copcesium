# copcesium example: react-resium-viewer

A tabbed, icon-rail COPC viewer built on [resium](https://resium.reearth.io/)
(the React bindings for CesiumJS) and `copcesium`. This is a standalone
project — it installs `copcesium` from the npm registry, not from this
repo's `src/`.

`copcesium`'s `CopcDataSource` isn't a `Cesium.DataSource`/`Entity`/
`Primitive`, so resium has no built-in component for it. This example uses
resium's `<Viewer>` for viewer setup/lifecycle (terrain, disabled default
widgets) and reaches the underlying `Cesium.Viewer` from a child component
via resium's `useCesium()` hook — the idiomatic resium pattern for dropping
into imperative Cesium/copcesium APIs, in contrast to the `ref`-based escape
hatch shown in [`examples/react/react-viewer`](../react-viewer) (which has no
resium `<Viewer>` context to read from). See `src/ViewerContent.tsx` and
`src/useCopcDataSource.ts` for the full pattern.

The panel's Data tab switches between a few freely streamable public COPC
files (see `src/datasets.ts`), or paste any COPC URL into the text field and
click Load. Appearance/Filter/Points drive `colorMode`, `classificationFilter`,
and `pixelSize` live; Info polls `CopcDataSource`'s read-only stats
(`maxDepth`, `nodeCount`, `cacheSize`) into React state. The Global tab's
terrain/imagery pickers and the footer's camera/FPS readout are plain Cesium
viewer chrome with no `copcesium` dependency — see `src/useViewerChrome.ts`.
The rail/panel/footer shell itself is ported from an earlier prototype UI of
this project; only the design moved, wired here to what this library's
current API actually exposes.

## Run

```bash
npm install
cp .env.example .env   # optionally set VITE_CESIUM_TOKEN for Cesium Ion imagery/terrain
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Developing against this repo's `src/` instead

`npm run dev:src` runs the same example but aliases the `copcesium` import to
`../../../src`, so a change to this repo's source is visible in the browser
immediately via Vite HMR — no build, `npm pack`, or publish step. The app
code is unchanged either way; only where `copcesium` resolves to differs.

`npm run dev` (no `:src`) remains the way to verify the *published* package,
since it installs `copcesium` from the npm registry like a real consumer.
