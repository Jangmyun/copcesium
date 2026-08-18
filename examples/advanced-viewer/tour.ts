import * as Cesium from 'cesium';
import type { CopcDataSource } from 'copcesium';

/**
 * A continuous camera move, for recording.
 *
 * Deliberately not the benchmark's walk: that one hops between waypoints with
 * `flyToBoundingSphere` and settles at each, which is what makes it
 * measurable and also what makes it look like a slideshow. Footage of a
 * streaming renderer needs the opposite — an unbroken descent so the octree
 * visibly refines under the camera as nodes arrive.
 *
 * So this drives the camera every frame from an interpolated
 * (heading, pitch, range) rather than chaining eased flights. Range is
 * interpolated geometrically: halving the distance takes the same time
 * whether it's the first halving or the last, which reads as constant speed
 * instead of a rush at the end.
 */

const DURATION_MS = 26_000;
/** Full turn plus a bit, so the start and end framings differ. */
const TOTAL_HEADING_DEG = 400;
const START = { pitchDeg: -75, rangeFactor: 3.2 };
const END = { pitchDeg: -22, rangeFactor: 0.18 };

/** Smoothstep, so the move eases in and out instead of starting at full speed. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Geometric interpolation — equal ratios per unit time, not equal distances. */
function geomLerp(a: number, b: number, t: number): number {
  return a * Math.pow(b / a, t);
}

export class CameraTour {
  private raf = 0;
  private startedAt = 0;
  private onEnd: (() => void) | null = null;

  constructor(private readonly viewer: Cesium.Viewer) {}

  get running(): boolean {
    return this.raf !== 0;
  }

  start(ds: CopcDataSource, onEnd?: () => void): void {
    if (this.running) return;
    const sphere = (ds as unknown as { _getSphere(key: string): Cesium.BoundingSphere })._getSphere('0-0-0-0');
    this.onEnd = onEnd ?? null;
    this.startedAt = performance.now();

    // Any interaction cancels: a tour that fights the mouse is worse than no
    // tour, and mid-recording you want to be able to take over.
    const cancel = (): void => this.stop();
    const canvas = this.viewer.scene.canvas;
    canvas.addEventListener('pointerdown', cancel, { once: true });
    canvas.addEventListener('wheel', cancel, { once: true });

    const step = (): void => {
      const t = Math.min(1, (performance.now() - this.startedAt) / DURATION_MS);
      const e = ease(t);
      const camera = this.viewer.scene.camera;
      camera.lookAt(
        sphere.center,
        new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(TOTAL_HEADING_DEG * e),
          Cesium.Math.toRadians(lerp(START.pitchDeg, END.pitchDeg, e)),
          sphere.radius * geomLerp(START.rangeFactor, END.rangeFactor, e),
        ),
      );
      // Required under `requestRenderMode`: moving the camera by transform
      // doesn't itself schedule a frame.
      this.viewer.scene.requestRender();

      if (t < 1) {
        this.raf = requestAnimationFrame(step);
      } else {
        this.stop();
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  stop(): void {
    if (!this.running) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    // `lookAt` leaves the camera parented to a reference frame; without this
    // the user's own drags would orbit that frozen frame instead of the globe.
    this.viewer.scene.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this.onEnd?.();
    this.onEnd = null;
  }
}
