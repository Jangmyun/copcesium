/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import { usedLayerRanges, type Range } from '../copc/lazLayers';

interface Entry {
  /** Kept bytes: the whole chunk, or its used layers back to back. */
  data: Uint8Array;
  /** Chunk length. */
  length: number;
  /** Where each kept range sits in the chunk; null when kept whole. */
  ranges: Range[] | null;
}

/**
 * LRU cache of nodes' compressed point data, bounded by bytes.
 *
 * `NodeCache` drops a node's GPU resources on eviction, and its bytes went to
 * a worker long before that, so revisiting an evicted node meant requesting
 * it again. Keeping the compressed data turns that revisit into a decode.
 *
 * For point formats 6 and 7 only the LAZ layers copcesium decodes are kept
 * (see copc/lazLayers.ts), and `get` rebuilds the chunk at full length with
 * zeros in the rest. Without that, GPS time, scan angle and the other unread
 * layers can take 40% of a chunk, and the cache holds too few nodes to pay
 * off. The budget counts what is kept.
 *
 * Both directions copy: a caller transfers the buffer it holds to a worker,
 * which would otherwise detach the cached one.
 */
export class CompressedBytesCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly pointFormat = 0,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** Bytes held, which `maxBytes` bounds. */
  get totalBytes(): number {
    return this.bytes;
  }

  get(key: string): Uint8Array | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (entry.ranges === null) return entry.data.slice();
    const out = new Uint8Array(entry.length);
    let at = 0;
    for (const r of entry.ranges) {
      out.set(entry.data.subarray(at, at + r.end - r.begin), r.begin);
      at += r.end - r.begin;
    }
    return out;
  }

  set(key: string, chunk: Uint8Array): void {
    const entry = this.pack(chunk);
    // Also covers `maxBytes` of 0, which turns the cache off.
    if (entry.data.byteLength > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.bytes -= previous.data.byteLength;
    }
    this.entries.set(key, entry);
    this.bytes += entry.data.byteLength;

    for (const [oldestKey, oldest] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldestKey);
      this.bytes -= oldest.data.byteLength;
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private pack(chunk: Uint8Array): Entry {
    const ranges = this.maxBytes > 0 ? usedLayerRanges(chunk, this.pointFormat) : null;
    const kept = ranges?.reduce((sum, r) => sum + r.end - r.begin, 0) ?? chunk.byteLength;
    if (ranges === null || kept >= chunk.byteLength) {
      return { data: chunk.slice(), length: chunk.byteLength, ranges: null };
    }
    const data = new Uint8Array(kept);
    let at = 0;
    for (const r of ranges) {
      data.set(chunk.subarray(r.begin, r.end), at);
      at += r.end - r.begin;
    }
    return { data, length: chunk.byteLength, ranges };
  }
}
