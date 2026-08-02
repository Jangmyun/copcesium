# dev-viewer

The viewer used while working on this repository. Imports `src/` directly, so a
source change is visible in the browser immediately via Vite HMR — no build, no
`npm pack`, no publish.

```bash
# from the repository root
cp examples/dev-viewer/.env.example examples/dev-viewer/.env   # add a Cesium ion token
npm run dev
```

Unlike `basic-viewer`, this is not a standalone npm project: it belongs to the
root project and uses its `node_modules`, so there is no separate
`package.json`, `package-lock.json`, or install step. It is served by
`vite.dev.config.ts` at the repository root.

## dev-viewer vs. basic-viewer

The two examples verify different things and neither replaces the other.

| | verifies | when to use |
| --- | --- | --- |
| `dev-viewer` | a source change behaves correctly | constantly, while developing |
| `basic-viewer` | the published package works for a consumer | after a release |

`dev-viewer` bundles `src/` directly and never touches `dist/`, so it cannot
catch build or packaging defects. Those are real: the worker-404 bug (#54) that
made 1.0.0 unusable looked fine at source level and only appeared in the built
output, which is exactly why `basic-viewer` installs `copcesium` from the npm
registry instead of reaching into this repository.

## Checking the built artifact before a release

Neither example covers "does the thing I am about to publish work". For that,
pack the build and install it into `basic-viewer` **with `--no-save`**:

```bash
npm run build && npm pack
cd examples/basic-viewer
npm install ../../copcesium-<version>.tgz --no-save   # --no-save is required
npm run dev
```

`--no-save` keeps `package.json` and `package-lock.json` untouched. Without it,
npm rewrites both to point at `file:../../copcesium-<version>.tgz`, a path that
does not exist for anyone else — committing that is what broke clean installs
in #69. Afterwards, restore with `npm ci` and delete the `.tgz`.
