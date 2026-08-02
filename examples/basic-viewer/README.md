# copcesium example: basic-viewer

Minimal, unstyled example that loads a COPC point cloud into a CesiumJS
viewer using the published `copcesium` npm package. This is a standalone
project — it installs `copcesium` from the npm registry, not from this
repo's `src/`.

## Run

```bash
npm install
cp .env.example .env   # optionally set VITE_CESIUM_TOKEN for Cesium Ion imagery
npm run dev
```

## Run against this repo's `src/` (contributors)

```bash
npm run dev:src
```

Same app, but `copcesium` resolves to `../../src` instead of the installed
package, so a change under `src/` shows up here immediately — no `npm pack`, no
publish. Use this while working on the library.

It bundles `src/` directly and never goes through `dist/`, so it cannot catch
build or packaging defects — the worker-404 in #54 looked fine at source level
and only broke in the built output. Plain `npm run dev` is what covers that,
because it uses the package as installed from the registry.

To check the artifact you are about to publish (neither mode covers this), pack
the build and install it here **with `--no-save`**:

```bash
cd ../.. && npm run build && npm pack
cd examples/basic-viewer
npm install ../../copcesium-<version>.tgz --no-save
npm run dev
```

`--no-save` keeps `package.json` and `package-lock.json` untouched. Without it
npm rewrites both to `file:../../copcesium-<version>.tgz`, a path nobody else
has — committing that is what broke clean installs in #69. Restore with
`npm ci` and delete the `.tgz` afterwards.

## Build

```bash
npm run build
npm run preview
```
