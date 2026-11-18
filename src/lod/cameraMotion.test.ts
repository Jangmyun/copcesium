/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun), 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from 'vitest';
import { angleBetween, CameraMotionTracker, type MotionSample, type Vec3 } from './cameraMotion';

const R = 6_400_000;
const UP: Vec3 = [0, 0, 1];

function sample(t: number, position: Vec3, direction: Vec3 = [1, 0, 0]): MotionSample {
  return { timeMs: t, position, direction, up: UP };
}

function feed(
  tracker: CameraMotionTracker,
  seconds: number,
  at: (t: number) => MotionSample,
  stepMs = 16,
): void {
  for (let t = 0; t <= seconds * 1000; t += stepMs) tracker.update(at(t));
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

describe('CameraMotionTracker', () => {
  it('predicts no motion when stationary', () => {
    const t2 = new CameraMotionTracker();
    feed(t2, 2, (t) => sample(t, [R, 0, 100]));
    const p = t2.predict(1000, 'cv')!;
    expect(p.position[0]).toBeCloseTo(R, 6);
    expect(p.position[2]).toBeCloseTo(100, 6);
    expect(angleBetween(p.direction, [1, 0, 0])).toBeLessThan(1e-9);
    expect(t2.predict(1000)).toBeDefined();
  });

  it('extrapolates constant translation', () => {
    const tr = new CameraMotionTracker();
    const v = 50; // m/s along y
    feed(tr, 2, (t) => sample(t, [R, (v * t) / 1000, 0]));
    expect(tr.velocityPerSecond[1]).toBeCloseTo(v, 3);
    const last = tr.lastSample!;
    const p = tr.predict(1000, 'cv')!;
    expect(p.position[1]).toBeCloseTo(last.position[1] + v, 3);
    const stay = tr.predict(1000, 'persistence')!;
    expect(stay.position[1]).toBe(last.position[1]);
  });

  it('extrapolates constant rotation', () => {
    const tr = new CameraMotionTracker();
    const w = 0.5; // rad/s about z
    const dir = (t: number): Vec3 => [Math.cos((w * t) / 1000), Math.sin((w * t) / 1000), 0];
    feed(tr, 2, (t) => sample(t, [R, 0, 0], dir(t)));
    const last = tr.lastSample!;
    const p = tr.predict(1000, 'cv')!;
    expect(angleBetween(p.direction, dir(last.timeMs + 1000))).toBeLessThan(1e-3);
    expect(angleBetween(p.up, UP)).toBeLessThan(1e-9);
  });

  it('resets on a teleport and on a long gap', () => {
    const tr = new CameraMotionTracker();
    feed(tr, 1, (t) => sample(t, [R, 50 * (t / 1000), 0]));
    const t0 = tr.lastSample!.timeMs;
    expect(tr.update(sample(t0 + 16, [0, R, 0]))).toBe(true);
    expect(norm(tr.velocityPerSecond)).toBe(0);
    expect(tr.lastSample!.position[1]).toBe(R);

    tr.update(sample(t0 + 32, [0, R, 0]));
    expect(tr.update(sample(t0 + 32 + 5000, [0, R, 0]))).toBe(true);
    expect(tr.update(sample(t0 + 32 + 5016, [0, R, 0]))).toBe(false);
  });

  it('shifts blend weight toward the better hypothesis', () => {
    // Steady motion: CV wins.
    const steady = new CameraMotionTracker();
    feed(steady, 6, (t) => sample(t, [R, 80 * (t / 1000), 0]));
    expect(steady.weights(1000).cv).toBeGreaterThan(0.9);

    // Back-and-forth jitter: CV overshoots, persistence wins.
    const jitter = new CameraMotionTracker();
    feed(jitter, 6, (t) => sample(t, [R, 30 * Math.sin((2 * Math.PI * t) / 600), 0]));
    const wj = jitter.weights(500);
    expect(wj.persistence).toBeGreaterThan(wj.cv);
    expect(wj.persistence + wj.cv).toBeCloseTo(1, 12);
  });
  describe('extrapolation modes', () => {
    const moving = (t: number) => sample(t, [R, t * 0.01, 100]); // 10 m/s along y
    const trained = (opts: ConstructorParameters<typeof CameraMotionTracker>[0]) => {
      const tr = new CameraMotionTracker(opts);
      feed(tr, 2, moving);
      return tr;
    };

    it('damped saturates at v * tau', () => {
      const tr = trained({ dampTauMs: 300 });
      const last = tr.lastSample!.position[1];
      const far = tr.predict(10_000, 'damped')!.position[1] - last;
      expect(far).toBeCloseTo(0.01 * 300, 1);
      const near = tr.predict(10, 'damped')!.position[1] - last;
      expect(near).toBeCloseTo(0.1, 1);
      const mid = tr.predict(600, 'damped')!.position[1] - last;
      expect(mid).toBeLessThan(0.01 * 600);
      expect(mid).toBeGreaterThan(near);
    });

    it('capped holds after capMs', () => {
      const tr = trained({ capMs: 250 });
      const last = tr.lastSample!.position[1];
      expect(tr.predict(100, 'capped')!.position[1] - last).toBeCloseTo(1, 1);
      expect(tr.predict(250, 'capped')!.position[1] - last).toBeCloseTo(2.5, 1);
      expect(tr.predict(2000, 'capped')!.position[1] - last).toBeCloseTo(2.5, 1);
    });

    it('rotDamped keeps linear position and saturates rotation', () => {
      const tr = new CameraMotionTracker({ dampTauMs: 300 });
      const dir = (t: number): Vec3 => [Math.cos(t * 0.0005), Math.sin(t * 0.0005), 0];
      feed(tr, 2, (t) => sample(t, [R, t * 0.01, 100], dir(t)));
      const last = tr.lastSample!;
      const p = tr.predict(2000, 'rotDamped')!;
      expect(p.position[1] - last.position[1]).toBeCloseTo(20, 0);
      expect(angleBetween(p.direction, last.direction)).toBeCloseTo(0.0005 * 300, 2);
    });

    it('blend can use a damped hypothesis', () => {
      const tr = trained({ blendMode: 'damped', dampTauMs: 300 });
      const last = tr.lastSample!.position[1];
      const p = tr.predict(10_000, 'blend')!.position[1] - last;
      expect(p).toBeLessThanOrEqual(0.01 * 300 + 1e-6);
    });
  });
});
