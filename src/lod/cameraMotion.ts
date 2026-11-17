/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun), 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Camera motion tracking and short-horizon pose prediction.
 *
 * Pure module: no Cesium imports. Positions are ECEF metres, `direction` and
 * `up` are unit vectors, time is in milliseconds.
 *
 * Estimator choice: an exponential moving average of the finite-difference
 * velocity with time constant `tauMs`. Unlike a fixed-window regression it
 * needs O(1) state, copes with irregular frame times (alpha follows dt), and
 * its lag is a single tunable number. Angular velocity is the EMA of the
 * rotation vector (axis * angle / dt) taking the previous direction to the
 * current one; roll about the view axis is not tracked, `up` is rotated with
 * the same rotation.
 *
 * Hypotheses: `persistence` (stay put) and `cv` (constant velocity, first
 * order extrapolation of position, constant angular velocity for direction).
 * `blend` weights the two by the inverse square of each one's recent error at
 * the requested horizon, measured online against the poses that later arrived.
 */

export type Vec3 = readonly [number, number, number];

export interface MotionSample {
  timeMs: number;
  position: Vec3;
  direction: Vec3;
  up: Vec3;
}

export interface Pose {
  position: Vec3;
  direction: Vec3;
  up: Vec3;
}

/**
 * `cv` extrapolates linearly for the whole horizon. `damped` integrates
 * v * exp(-t / dampTauMs), saturating at v * dampTauMs (position and
 * rotation). `capped` extrapolates at most `capMs`, then holds.
 * `rotDamped` is `cv` for position and `damped` for rotation.
 */
export type CvMode = 'cv' | 'damped' | 'capped' | 'rotDamped';
export type Hypothesis = 'persistence' | 'blend' | CvMode;

export interface CameraMotionOptions {
  /** EMA time constant for velocities, ms. Default 150. */
  tauMs?: number;
  /** A gap longer than this between samples resets the tracker, ms. Default 1500. */
  maxGapMs?: number;
  /** Jump if position residual exceeds `jumpMinMeters + jumpSpeedFactor * |v| * dt`. Default 200 m. */
  jumpMinMeters?: number;
  /** See `jumpMinMeters`. Default 5. */
  jumpSpeedFactor?: number;
  /** Jump if the direction turns more than this in one step, radians. Default 1.0. */
  jumpAngleRad?: number;
  /** Time constant of the damped modes, ms. Default 300. */
  dampTauMs?: number;
  /** Extrapolation cap of the `capped` mode, ms. Default 250. */
  capMs?: number;
  /** Which extrapolation the blend uses as its motion hypothesis. Default 'cv'. */
  blendMode?: CvMode;
  /** Horizons the blend tracks errors for, ms. Default [250, 500, 1000, 2000]. */
  horizonsMs?: readonly number[];
  /** Converts radians of direction error to metres in the blend error. Default 1000. */
  metresPerRadian?: number;
  /** EMA factor for the per-horizon error, applied per matured prediction. Default 0.05. */
  errorAlpha?: number;
}

interface Pending {
  targetMs: number;
  persistence: Pose;
  cv: Pose;
}

interface HorizonState {
  horizonMs: number;
  pending: Pending[];
  errPersistence: number;
  errCv: number;
  count: number;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const ZERO: Vec3 = [0, 0, 0];

function normalize(a: Vec3, fallback: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : fallback;
}

/** Angle between two unit vectors, radians. */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.atan2(length(cross(a, b)), dot(a, b));
}

/** Rodrigues rotation of `v` by rotation vector `w` (axis * angle). */
function rotate(v: Vec3, w: Vec3): Vec3 {
  const angle = length(w);
  if (angle < 1e-12) return v;
  const k = scale(w, 1 / angle);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

/** Rotation vector taking unit vector `a` to unit vector `b`. */
function rotationBetween(a: Vec3, b: Vec3): Vec3 {
  const c = cross(a, b);
  const s = length(c);
  if (s < 1e-12) return ZERO;
  return scale(c, Math.atan2(s, dot(a, b)) / s);
}

export class CameraMotionTracker {
  private readonly tauMs: number;
  private readonly maxGapMs: number;
  private readonly jumpMinMeters: number;
  private readonly jumpSpeedFactor: number;
  private readonly jumpAngleRad: number;
  private readonly metresPerRadian: number;
  private readonly errorAlpha: number;
  private readonly dampTauMs: number;
  private readonly capMs: number;
  private readonly blendMode: CvMode;
  private readonly horizons: HorizonState[];

  private last: MotionSample | undefined;
  private velocity: Vec3 = ZERO; // m / ms
  private angularVelocity: Vec3 = ZERO; // rad / ms
  private samplesSinceReset = 0;

  constructor(options: CameraMotionOptions = {}) {
    this.tauMs = options.tauMs ?? 150;
    this.maxGapMs = options.maxGapMs ?? 1500;
    this.jumpMinMeters = options.jumpMinMeters ?? 200;
    this.jumpSpeedFactor = options.jumpSpeedFactor ?? 5;
    this.jumpAngleRad = options.jumpAngleRad ?? 1.0;
    this.metresPerRadian = options.metresPerRadian ?? 1000;
    this.errorAlpha = options.errorAlpha ?? 0.05;
    this.dampTauMs = options.dampTauMs ?? 300;
    this.capMs = options.capMs ?? 250;
    this.blendMode = options.blendMode ?? 'cv';
    this.horizons = (options.horizonsMs ?? [250, 500, 1000, 2000]).map((horizonMs) => ({
      horizonMs,
      pending: [],
      errPersistence: 0,
      errCv: 0,
      count: 0,
    }));
  }

  /** Linear velocity in metres per second. */
  get velocityPerSecond(): Vec3 {
    return scale(this.velocity, 1000);
  }

  /** Angular velocity (rotation vector rate) in radians per second. */
  get angularVelocityPerSecond(): Vec3 {
    return scale(this.angularVelocity, 1000);
  }

  get lastSample(): MotionSample | undefined {
    return this.last;
  }

  reset(): void {
    this.last = undefined;
    this.velocity = ZERO;
    this.angularVelocity = ZERO;
    this.samplesSinceReset = 0;
    for (const h of this.horizons) {
      h.pending = [];
      h.errPersistence = 0;
      h.errCv = 0;
      h.count = 0;
    }
  }

  /**
   * Feeds one sample. Returns true when it was treated as a discontinuity
   * (teleport, flyTo jump, long gap) and the tracker restarted from it.
   */
  update(sample: MotionSample): boolean {
    const prev = this.last;
    if (!prev) {
      this.start(sample);
      return false;
    }
    const dt = sample.timeMs - prev.timeMs;
    if (dt <= 0) return false; // duplicate or out-of-order frame

    const step = sub(sample.position, prev.position);
    const expected = scale(this.velocity, dt);
    const residual = length(sub(step, expected));
    const turn = angleBetween(prev.direction, sample.direction);
    const speed = length(this.velocity);
    const jumped =
      dt > this.maxGapMs ||
      residual > this.jumpMinMeters + this.jumpSpeedFactor * speed * dt ||
      turn > this.jumpAngleRad;
    if (jumped) {
      this.reset();
      this.start(sample);
      return true;
    }

    this.settle(sample);

    const instV = scale(step, 1 / dt);
    const instW = scale(rotationBetween(prev.direction, sample.direction), 1 / dt);
    if (this.samplesSinceReset === 1) {
      this.velocity = instV;
      this.angularVelocity = instW;
    } else {
      const a = 1 - Math.exp(-dt / this.tauMs);
      this.velocity = add(scale(this.velocity, 1 - a), scale(instV, a));
      this.angularVelocity = add(scale(this.angularVelocity, 1 - a), scale(instW, a));
    }
    this.samplesSinceReset++;
    this.last = sample;
    this.enqueue(sample);
    return false;
  }

  /** Predicted pose at the last sample time plus `horizonMs`, or undefined before any sample. */
  predict(horizonMs: number, hypothesis: Hypothesis = 'blend'): Pose | undefined {
    const last = this.last;
    if (!last) return undefined;
    const stay = this.persistencePose(last);
    if (hypothesis === 'persistence') return stay;
    if (hypothesis !== 'blend') return this.cvPose(last, horizonMs, hypothesis);
    const cv = this.cvPose(last, horizonMs, this.blendMode);
    const w = this.weights(horizonMs);
    return {
      position: add(scale(stay.position, w.persistence), scale(cv.position, w.cv)),
      direction: normalize(
        add(scale(stay.direction, w.persistence), scale(cv.direction, w.cv)),
        stay.direction,
      ),
      up: normalize(add(scale(stay.up, w.persistence), scale(cv.up, w.cv)), stay.up),
    };
  }

  /**
   * Blend weights at a horizon: inverse-square of each hypothesis's recent
   * error at the nearest tracked horizon. Equal until predictions mature.
   */
  weights(horizonMs: number): { persistence: number; cv: number } {
    const h = this.nearestHorizon(horizonMs);
    if (!h || h.count === 0) return { persistence: 0.5, cv: 0.5 };
    const eps = 1e-3;
    const ip = 1 / ((h.errPersistence + eps) * (h.errPersistence + eps));
    const ic = 1 / ((h.errCv + eps) * (h.errCv + eps));
    const sum = ip + ic;
    return { persistence: ip / sum, cv: ic / sum };
  }

  private start(sample: MotionSample): void {
    this.last = sample;
    this.samplesSinceReset = 1;
    this.enqueue(sample);
  }

  private persistencePose(s: MotionSample): Pose {
    return { position: s.position, direction: s.direction, up: s.up };
  }

  /** Effective extrapolation time (ms of constant velocity) for a mode. */
  private effectiveMs(horizonMs: number, damped: boolean, capped: boolean): number {
    if (damped) return this.dampTauMs * (1 - Math.exp(-horizonMs / this.dampTauMs));
    if (capped) return Math.min(horizonMs, this.capMs);
    return horizonMs;
  }

  private cvPose(s: MotionSample, horizonMs: number, mode: CvMode): Pose {
    const damped = mode === 'damped';
    const capped = mode === 'capped';
    const rotDamped = damped || mode === 'rotDamped';
    const w = scale(this.angularVelocity, this.effectiveMs(horizonMs, rotDamped, capped));
    const pm = this.effectiveMs(horizonMs, damped, capped);
    return {
      position: add(s.position, scale(this.velocity, pm)),
      direction: normalize(rotate(s.direction, w), s.direction),
      up: normalize(rotate(s.up, w), s.up),
    };
  }

  private enqueue(sample: MotionSample): void {
    for (const h of this.horizons) {
      h.pending.push({
        targetMs: sample.timeMs + h.horizonMs,
        persistence: this.persistencePose(sample),
        cv: this.cvPose(sample, h.horizonMs, this.blendMode),
      });
    }
  }

  /** Scores pending predictions whose target time has been reached by `actual`. */
  private settle(actual: MotionSample): void {
    for (const h of this.horizons) {
      let n = 0;
      while (n < h.pending.length && h.pending[n].targetMs <= actual.timeMs) n++;
      if (n === 0) continue;
      // The newest matured prediction is the one closest to the horizon.
      const m = h.pending[n - 1];
      h.pending.splice(0, n);
      const ep = this.poseError(m.persistence, actual);
      const ec = this.poseError(m.cv, actual);
      if (h.count === 0) {
        h.errPersistence = ep;
        h.errCv = ec;
      } else {
        h.errPersistence += this.errorAlpha * (ep - h.errPersistence);
        h.errCv += this.errorAlpha * (ec - h.errCv);
      }
      h.count++;
    }
  }

  private poseError(p: Pose, actual: MotionSample): number {
    return (
      length(sub(p.position, actual.position)) +
      this.metresPerRadian * angleBetween(p.direction, actual.direction)
    );
  }

  private nearestHorizon(horizonMs: number): HorizonState | undefined {
    let best: HorizonState | undefined;
    let bestDist = Infinity;
    for (const h of this.horizons) {
      const d = Math.abs(Math.log(h.horizonMs / Math.max(horizonMs, 1)));
      if (d < bestDist) {
        bestDist = d;
        best = h;
      }
    }
    return best;
  }
}
