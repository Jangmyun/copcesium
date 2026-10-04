/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from 'vitest';
import { WorkerPool, type WorkerRequest, type WorkerResponse } from './WorkerPool';

/** Minimal stand-in for a real Worker; the test drives replies/errors manually. */
class FakeWorker {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  received: WorkerRequest[] = [];
  terminated = false;

  postMessage(data: WorkerRequest): void {
    this.received.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: Omit<WorkerResponse, 'id'>): void {
    const id = this.received[this.received.length - 1].id;
    this.onmessage?.({ data: { id, ...response } } as MessageEvent<WorkerResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function makeFactory() {
  const fakeWorkers: FakeWorker[] = [];
  const factory = (): Worker => {
    const w = new FakeWorker();
    fakeWorkers.push(w);
    return w as unknown as Worker;
  };
  return { factory, fakeWorkers };
}

describe('WorkerPool', () => {
  it('dispatches a task to a worker and resolves with its result', async () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);

    const promise = pool.run<string>('hello');
    expect(fakeWorkers[0].received).toEqual([{ id: 0, payload: 'hello' }]);

    fakeWorkers[0].reply({ result: 'world' });
    await expect(promise).resolves.toBe('world');
  });

  it('runs at most `concurrency` tasks at once and queues the rest', () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 2);

    void pool.run('a');
    void pool.run('b');
    void pool.run('c');

    expect(fakeWorkers).toHaveLength(2);
    expect(fakeWorkers[0].received).toHaveLength(1);
    expect(fakeWorkers[1].received).toHaveLength(1);
  });

  it('reuses an idle worker for a queued task instead of spawning a new one', async () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);

    const first = pool.run<string>('a');
    void pool.run<string>('b');
    expect(fakeWorkers).toHaveLength(1);
    expect(fakeWorkers[0].received).toEqual([{ id: 0, payload: 'a' }]);

    fakeWorkers[0].reply({ result: 'a-done' });
    await expect(first).resolves.toBe('a-done');

    // the queued task should have been dispatched to the same (now idle) worker
    expect(fakeWorkers).toHaveLength(1);
    expect(fakeWorkers[0].received).toEqual([
      { id: 0, payload: 'a' },
      { id: 1, payload: 'b' },
    ]);
  });

  it('rejects the caller when the worker reports an error in its response', async () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);

    const promise = pool.run('a');
    fakeWorkers[0].reply({ error: { name: 'RangeError', message: 'boom' } });

    await expect(promise).rejects.toThrow('boom');
  });

  it('rejects the caller when the worker fires onerror', async () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);

    const promise = pool.run('a');
    fakeWorkers[0].fail('script crashed');

    await expect(promise).rejects.toThrow(/script crashed/);
  });

  it('replaces a crashed worker and lets the replacement pick up the next queued task', async () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);

    const first = pool.run('a').catch(() => 'caught');
    const second = pool.run<string>('b');

    fakeWorkers[0].fail('script crashed');
    await first;

    expect(fakeWorkers[0].terminated).toBe(true);
    // A crashed worker must not stay in rotation — a fresh one takes its place.
    expect(fakeWorkers).toHaveLength(2);
    expect(fakeWorkers[1].received).toEqual([{ id: 1, payload: 'b' }]);

    fakeWorkers[1].reply({ result: 'b-done' });
    await expect(second).resolves.toBe('b-done');
  });

  it('gives up replacing a worker once the replacement limit is exceeded, instead of retrying forever', () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let i = 0; i < 11; i++) {
      void pool.run('x').catch(() => {});
      fakeWorkers[fakeWorkers.length - 1].fail('boom');
    }

    // 1 initial worker + 10 replacements = 11 created; the 11th crash gives up
    // rather than spawning a 12th, leaving the pool permanently smaller.
    expect(fakeWorkers).toHaveLength(11);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('replacement limit'));

    errorSpy.mockRestore();
  });

  it('rejects a task that times out while a worker is processing it, and frees the worker without replacing it', async () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);

    const promise = pool.run('a', [], 10);
    await expect(promise).rejects.toThrow(/timed out/);

    expect(fakeWorkers[0].terminated).toBe(false); // a timeout is not a crash
    expect(fakeWorkers).toHaveLength(1); // no replacement was created

    // the worker is idle again and usable for a new task
    const second = pool.run<string>('b');
    expect(fakeWorkers[0].received).toEqual([
      { id: 0, payload: 'a' },
      { id: 1, payload: 'b' },
    ]);
    fakeWorkers[0].reply({ result: 'b-done' });
    await expect(second).resolves.toBe('b-done');
  });

  it('rejects a task that times out while still waiting in the queue, without dispatching it', async () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);

    void pool.run('a'); // occupies the only worker
    const queued = pool.run('b', [], 10);

    await expect(queued).rejects.toThrow(/timed out/);
    expect(fakeWorkers[0].received).toEqual([{ id: 0, payload: 'a' }]); // 'b' never reached a worker
  });

  it('ignores a late response for a task that already timed out', async () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);

    const promise = pool.run('a', [], 10);
    await expect(promise).rejects.toThrow(/timed out/);

    const second = pool.run<string>('b');
    // Stale reply for the already-timed-out task 'a' (id 0), arriving after
    // 'b' (id 1) was dispatched to the same (freed) worker.
    fakeWorkers[0].onmessage?.({ data: { id: 0, result: 'late-a' } } as MessageEvent<WorkerResponse>);

    fakeWorkers[0].reply({ result: 'b-done' });
    await expect(second).resolves.toBe('b-done');
  });

  it('ignores a stray message when no task is pending on that worker', () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);
    void pool;

    expect(() => {
      fakeWorkers[0].onmessage?.({ data: { id: 999, result: 'unexpected' } } as MessageEvent<WorkerResponse>);
    }).not.toThrow();
  });

  it('terminates all workers on destroy()', () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 3);

    pool.destroy();

    expect(fakeWorkers.every((w) => w.terminated)).toBe(true);
  });

  it('rejects in-flight and queued tasks on destroy()', async () => {
    const { factory } = makeFactory();
    const pool = new WorkerPool(factory, 1);

    const running = pool.run('a');
    const queued = pool.run('b');

    pool.destroy();

    await expect(running).rejects.toThrow(/destroyed/);
    await expect(queued).rejects.toThrow(/destroyed/);
  });

  it('rejects new run() calls after destroy() without touching any worker', async () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);
    pool.destroy();

    await expect(pool.run('a')).rejects.toThrow(/destroy/);
    expect(fakeWorkers[0].received).toHaveLength(0);
  });

  it('passes the transfer list through to postMessage', () => {
    const { factory, fakeWorkers } = makeFactory();
    const pool = new WorkerPool(factory, 1);
    const spy = vi.spyOn(fakeWorkers[0], 'postMessage');
    const buffer = new ArrayBuffer(8);

    void pool.run('a', [buffer]);

    expect(spy).toHaveBeenCalledWith({ id: 0, payload: 'a' }, [buffer]);
  });

  describe('cancel()', () => {
    it('rejects a still-queued task immediately, without sending anything to a worker', async () => {
      const { factory, fakeWorkers } = makeFactory();
      const pool = new WorkerPool(factory, 1);

      void pool.run('a'); // occupies the only worker
      const queued = pool.run('b');
      const caught = queued.catch((err) => err);

      queued.cancel();

      const err = await caught;
      expect(err.name).toBe('AbortError');
      expect(fakeWorkers[0].received).toEqual([{ id: 0, payload: 'a' }]); // 'b' never dispatched
    });

    it('sends a cancel message to the worker running a dispatched task, and settles once it responds', async () => {
      const { factory, fakeWorkers } = makeFactory();
      const pool = new WorkerPool(factory, 1);

      const promise = pool.run('a');
      promise.cancel();

      expect(fakeWorkers[0].received).toEqual([{ id: 0, payload: 'a' }, { id: 0, cancel: true }]);

      // the task isn't settled just because cancel() was called — only once
      // the worker actually responds, same as any other in-flight task
      const err = { name: 'AbortError', message: 'The operation was aborted.' };
      fakeWorkers[0].reply({ error: err });
      await expect(promise).rejects.toThrow(err.message);

      // the worker is freed and reusable afterwards
      const second = pool.run<string>('b');
      expect(fakeWorkers[0].received).toEqual([
        { id: 0, payload: 'a' },
        { id: 0, cancel: true },
        { id: 1, payload: 'b' },
      ]);
      fakeWorkers[0].reply({ result: 'b-done' });
      await expect(second).resolves.toBe('b-done');
    });

    it('is a no-op once the task has already settled', async () => {
      const { factory, fakeWorkers } = makeFactory();
      const pool = new WorkerPool(factory, 1);

      const promise = pool.run('a');
      fakeWorkers[0].reply({ result: 'done' });
      await promise;

      expect(() => promise.cancel()).not.toThrow();
    });
  });
});
