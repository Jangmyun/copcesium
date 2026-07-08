import type { Viewer } from 'cesium';

export interface CopcDataSourceOptions {
  proj?: string;
  projDef?: string | null;
  geoidOffset?: number;
  concurrency?: number;
  debounceMs?: number;
  maxCacheNodes?: number;
  maxVisibleNodes?: number;
  pixelSize?: number;
  sseThreshold?: number;
}

export class CopcDataSource {
  static async load(
    url: string,
    viewer: Viewer,
    options?: CopcDataSourceOptions,
  ): Promise<CopcDataSource> {
    throw new Error('Not implemented yet');
  }

  destroy(): void {
    throw new Error('Not implemented yet');
  }
}
