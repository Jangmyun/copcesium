# copcesium example: react-viewer

Minimal, unstyled example that loads a COPC point cloud into a CesiumJS
viewer from a **plain React component** — no wrapper library, just
`useRef`/`useEffect`/`useCallback` around the same imperative `copcesium` API
used in [`examples/basic-viewer`](../../basic-viewer). This is a standalone
project — it installs `copcesium` from the npm registry, not from this
repo's `src/`.

`copcesium`'s `CopcDataSource` is not a `Cesium.DataSource`/`Entity`/
`Primitive`, so it has no declarative React representation — it's created
once with `CopcDataSource.load(url, viewer, options)` inside a one-time
`useEffect`, held in a `useRef` (not state, since it's a mutable imperative
object, not render data), and mutated directly (`ds.pixelSize = ...`) from
UI event handlers. See `src/App.tsx` for the full pattern, including the
`viewer.isDestroyed()` guard needed to survive React StrictMode's dev-mode
mount/unmount/remount cycle.

The "sample data" dropdown switches between a few freely streamable public
COPC files (see `src/datasets.ts`), or paste any COPC URL into the text
field and click Load.

## Run

```bash
npm install
cp .env.example .env   # optionally set VITE_CESIUM_TOKEN for Cesium Ion imagery
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
