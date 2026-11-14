/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Decode stage, main-thread side. Owns a pool of reused Web Workers (running
 * `worker.ts`) and routes conversion requests to an idle one, so LAZ
 * decompression and coordinate transforms never block the UI thread. Also
 * defines the postMessage wire protocol both sides speak.
 */

/**
 * Wire protocol between WorkerPool and any worker script used with it. A worker
 * must echo back the same `id` it received so WorkerPool can match the reply to
 * the task that produced it.
 */
export interface WorkerRequest {
  id: number;
  payload: unknown;
}

/**
 * Errors cross the postMessage boundary as plain data (not Error instances,
 * which do not structured-clone reliably across all targets), so a worker
 * catches its own exceptions and reports `name`/`message` instead of throwing.
 */
export interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: { name: string; message: string };
}

/** Sent to a worker to abort the in-flight task with the matching `id`. */
export interface WorkerCancelRequest {
  id: number;
  cancel: true;
}

/** A `run()` result whose underlying task can be abandoned early. */
export type CancellablePromise<T> = Promise<T> & { cancel: () => void };

interface Task {
  id: number;
  message: unknown;
  transfer: Transferable[];
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Higher runs first among queued tasks; equal priorities keep FIFO order. */
  priority: number;
  queuedAt: number;
  /** Set when the task reaches a worker. */
  startedAt: number | null;
}

/** Recent queue and run times, so a caller can tell a CPU-bound pipeline
 *  (tasks wait for a worker) from a network-bound one (workers wait for tasks). */
export interface WorkerPoolTiming {
  /** Tasks waiting for a worker right now. */
  waiting: number;
  /** Tasks running on a worker right now. */
  running: number;
  /** Median ms from `run()` to reaching a worker, over recent tasks. NaN before any. */
  waitP50: number;
  /** Median ms a worker spent on a task, over recent completed tasks. NaN before any. */
  runP50: number;
}

// Enough to smooth over one slow node, short enough to follow a change of
// view from sparse to dense data within a few seconds of decoding.
const TIMING_WINDOW = 32;

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function pushWindow(window: number[], value: number): void {
  window.push(value);
  if (window.length > TIMING_WINDOW) window.shift();
}

/**
 * Runs work across a fixed number of reused Workers instead of spawning one
 * per task — spawning a new Worker per COPC node would force laz-perf to
 * recompile its WASM every time.
 */
export class WorkerPool {
  private static readonly MAX_WORKER_REPLACEMENTS = 10;

  private readonly workers: Worker[];
  private readonly idleWorkers: Worker[] = [];
  private readonly queue: Task[] = [];
  private readonly pending = new Map<Worker, Task>();
  private nextId = 0;
  private destroyed = false;
  private workerReplacementCount = 0;
  private readonly waitTimes: number[] = [];
  private readonly runTimes: number[] = [];

  constructor(
    private readonly workerFactory: () => Worker,
    concurrency: number,
    /** Clock for the timing window, for tests. */
    private readonly now: () => number = () => performance.now(),
  ) {
    this.workers = [];
    for (let i = 0; i < concurrency; i++) {
      const worker = this.workerFactory();
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => this._handleMessage(worker, e);
      worker.onerror = (e: ErrorEvent) => this._handleError(worker, e);
      this.workers.push(worker);
      this.idleWorkers.push(worker);
    }
  }

  /** How many tasks this pool can run at once — the number of workers it was built with. */
  get concurrency(): number {
    return this.workers.length;
  }

  /** Tasks waiting for a worker. */
  get backlog(): number {
    return this.queue.length;
  }

  /** A snapshot of how busy the pool is and how long tasks have been taking. */
  get timing(): WorkerPoolTiming {
    return {
      waiting: this.queue.length,
      running: this.pending.size,
      waitP50: median(this.waitTimes),
      runP50: median(this.runTimes),
    };
  }

  /**
   * @param timeoutMs Rejects (and frees up the worker/queue slot) if no
   *   response arrives in time — a hung Range Request or a wasm decode that
   *   never returns would otherwise wedge that node forever, since nothing
   *   else would ever remove it from `pending`.
   * @param priority Among tasks waiting for a worker, higher goes first;
   *   equal priorities run in the order they were submitted. Default `0`, so
   *   callers that never pass it get plain FIFO.
   */
  run<T>(message: unknown, transfer: Transferable[] = [], timeoutMs = 30_000, priority = 0): CancellablePromise<T> {
    if (this.destroyed) {
      const rejected = Promise.reject(new Error('WorkerPool: run() called after destroy()')) as CancellablePromise<T>;
      rejected.cancel = () => {};
      return rejected;
    }
    let task!: Task;
    const promise = new Promise<T>((resolve, reject) => {
      task = {
        id: this.nextId++,
        message,
        transfer,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => this._handleTimeout(task), timeoutMs),
        priority,
        queuedAt: this.now(),
        startedAt: null,
      };
      this._dispatch(task);
    }) as CancellablePromise<T>;
    promise.cancel = () => this._cancel(task);
    return promise;
  }

  destroy(): void {
    this.destroyed = true;
    for (const worker of this.workers) worker.terminate();
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error('WorkerPool: destroyed while task was running'));
    }
    for (const task of this.queue) {
      clearTimeout(task.timer);
      task.reject(new Error('WorkerPool: destroyed before task could run'));
    }
    this.pending.clear();
    this.queue.length = 0;
    this.idleWorkers.length = 0;
  }

  private _dispatch(task: Task): void {
    const worker = this.idleWorkers.pop();
    if (!worker) {
      // After every task of equal or higher priority, so equal priorities
      // stay FIFO and an all-default pool behaves exactly as before.
      const at = this.queue.findIndex((queued) => queued.priority < task.priority);
      if (at === -1) this.queue.push(task);
      else this.queue.splice(at, 0, task);
      return;
    }
    this._start(worker, task);
  }

  private _start(worker: Worker, task: Task): void {
    task.startedAt = this.now();
    pushWindow(this.waitTimes, task.startedAt - task.queuedAt);
    this.pending.set(worker, task);
    worker.postMessage({ id: task.id, payload: task.message } satisfies WorkerRequest, task.transfer);
  }

  /** Records how long a task held its worker, for `timing.runP50`. */
  private _finished(task: Task): void {
    if (task.startedAt !== null) pushWindow(this.runTimes, this.now() - task.startedAt);
  }

  private _handleMessage(worker: Worker, e: MessageEvent<WorkerResponse>): void {
    const task = this.pending.get(worker);
    // Ignore replies that don't match the task we think is running on this
    // worker (e.g. a stray or late-arriving message for an already-timed-out
    // task) rather than resolving the wrong promise.
    if (!task || e.data.id !== task.id) return;
    this.pending.delete(worker);
    clearTimeout(task.timer);
    // A cancelled task's reply comes back early and would read as a fast
    // decode; only completed work describes what the CPU can do.
    if (!e.data.error) this._finished(task);

    if (e.data.error) {
      const err = new Error(e.data.error.message);
      err.name = e.data.error.name;
      task.reject(err);
    } else {
      task.resolve(e.data.result);
    }
    this._release(worker);
  }

  private _handleError(worker: Worker, e: ErrorEvent): void {
    const task = this.pending.get(worker);
    this.pending.delete(worker);
    if (task) {
      clearTimeout(task.timer);
      task.reject(new Error(`WorkerPool: worker error: ${e.message}`));
    }
    this._replaceWorker(worker);
  }

  private _handleTimeout(task: Task): void {
    for (const [worker, pending] of this.pending) {
      if (pending !== task) continue;
      this.pending.delete(worker);
      task.reject(new Error('WorkerPool: task timed out waiting for a worker response'));
      this._release(worker);
      return;
    }
    const queueIndex = this.queue.indexOf(task);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
      task.reject(new Error('WorkerPool: task timed out waiting for an idle worker'));
    }
  }

  /**
   * A task still in `queue` never reached a worker, so it can be rejected
   * immediately. One already `pending` on a worker needs that worker to stop
   * — cross-thread `AbortSignal`s don't propagate on their own, so a `cancel`
   * message is sent instead, and the task settles normally once the worker's
   * own abort turns into a WorkerResponse (`_handleMessage`/`_handleTimeout`
   * remain the only things that resolve/reject it or free its worker slot).
   */
  private _cancel(task: Task): void {
    const queueIndex = this.queue.indexOf(task);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
      clearTimeout(task.timer);
      const err = new Error('WorkerPool: task cancelled before it reached a worker');
      err.name = 'AbortError';
      task.reject(err);
      return;
    }
    for (const [worker, pending] of this.pending) {
      if (pending !== task) continue;
      worker.postMessage({ id: task.id, cancel: true } satisfies WorkerCancelRequest);
      return;
    }
  }

  private _release(worker: Worker): void {
    const next = this.queue.shift();
    if (!next) {
      this.idleWorkers.push(worker);
      return;
    }
    this._start(worker, next);
  }

  /** Removes a crashed worker from rotation and spins up a replacement, so a
   *  single bad worker doesn't permanently fail every task routed to it. */
  private _replaceWorker(worker: Worker): void {
    worker.terminate();
    const workerIndex = this.workers.indexOf(worker);
    if (workerIndex !== -1) this.workers.splice(workerIndex, 1);
    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex !== -1) this.idleWorkers.splice(idleIndex, 1);

    if (this.destroyed) return;

    if (this.workerReplacementCount >= WorkerPool.MAX_WORKER_REPLACEMENTS) {
      console.error('[WorkerPool] Worker replacement limit exceeded; continuing with a reduced pool.');
      return;
    }
    this.workerReplacementCount++;

    const replacement = this.workerFactory();
    replacement.onmessage = (e: MessageEvent<WorkerResponse>) => this._handleMessage(replacement, e);
    replacement.onerror = (e: ErrorEvent) => this._handleError(replacement, e);
    this.workers.push(replacement);
    this._release(replacement); // picks up queued work if any, else goes idle
  }
}
