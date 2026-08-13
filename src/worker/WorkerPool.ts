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

  constructor(
    private readonly workerFactory: () => Worker,
    concurrency: number,
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

  /**
   * @param timeoutMs Rejects (and frees up the worker/queue slot) if no
   *   response arrives in time — a hung Range Request or a wasm decode that
   *   never returns would otherwise wedge that node forever, since nothing
   *   else would ever remove it from `pending`.
   */
  run<T>(message: unknown, transfer: Transferable[] = [], timeoutMs = 30_000): CancellablePromise<T> {
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
      this.queue.push(task);
      return;
    }
    this.pending.set(worker, task);
    worker.postMessage({ id: task.id, payload: task.message } satisfies WorkerRequest, task.transfer);
  }

  private _handleMessage(worker: Worker, e: MessageEvent<WorkerResponse>): void {
    const task = this.pending.get(worker);
    // Ignore replies that don't match the task we think is running on this
    // worker (e.g. a stray or late-arriving message for an already-timed-out
    // task) rather than resolving the wrong promise.
    if (!task || e.data.id !== task.id) return;
    this.pending.delete(worker);
    clearTimeout(task.timer);

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
    this.pending.set(worker, next);
    worker.postMessage({ id: next.id, payload: next.message } satisfies WorkerRequest, next.transfer);
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
