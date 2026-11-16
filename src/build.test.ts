/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/// <reference types="node" />
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

// Regression guard for issue #37: WorkerPool creates its Worker via
// `new URL('./worker/worker.ts', import.meta.url)`, which has no CJS
// equivalent — Rollup's CJS output silently rewrites `import.meta.url` to
// `undefined`, so `new URL(...)` throws for any CJS consumer the moment
// `CopcDataSource.load()` runs. Until the Worker is constructed some other
// way, this package must not ship a `require` entry point or a CJS build.
describe('package.json module format', () => {
  it('does not expose a CJS "require" export condition', () => {
    expect(pkg.exports['.']).not.toHaveProperty('require');
  });

  it('"main" resolves to an ESM (.mjs) file, not a CJS (.cjs) file', () => {
    expect(pkg.main).toMatch(/\.mjs$/);
  });
});

// Regression guard for the worker-404 bug: the built bundle used to
// reference a separately emitted worker chunk and laz-perf.wasm via a
// root-absolute `new URL("/assets/...", import.meta.url)`. That string
// survives into consumer bundles but the files it points at never do — a
// consumer's bundler has no static import to trace, so it doesn't know to
// copy them, and even if it did, the leading `/` assumes the app is deployed
// at the site root. The fix embeds the worker (and, inside it, the wasm) as
// a Blob at our own build time, so the published package has no separate
// runtime-fetched asset at all. This only runs once `dist/` exists (`npm run
// build`); it's a no-op, not a false pass, when it doesn't.
describe('dist output has no separate worker/wasm asset', () => {
  const distDir = resolve(import.meta.dirname, '../dist');
  const mjsPath = resolve(distDir, 'copc-cesium.mjs');

  it.runIf(existsSync(mjsPath))('emits no dist/assets directory', () => {
    expect(existsSync(resolve(distDir, 'assets'))).toBe(false);
  });

  it.runIf(existsSync(mjsPath))('contains no root-absolute /assets/ URL reference', () => {
    const built = readFileSync(mjsPath, 'utf-8');
    expect(built).not.toContain('/assets/');
  });
});
