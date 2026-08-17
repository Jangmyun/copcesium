import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { CopcDataSource } from 'copcesium';
import type { CopcDataSourceOptions } from 'copcesium';

export interface CopcStats {
  maxDepth: number;
  nodeCount: number;
  cacheSize: number;
}

// `CopcDataSource` isn't a Cesium.Entity/DataSource/Primitive, so resium has
// no component for it — it's a mutable imperative object, created once via
// `CopcDataSource.load()` and mutated directly through `dataSourceRef`, not
// through React state or props. This hook only wraps its lifecycle (create,
// destroy-on-reload, destroy-on-unmount) and polls its read-only stats into
// state so a stats panel can re-render.
export function useCopcDataSource(viewer: Cesium.Viewer | undefined) {
  const dataSourceRef = useRef<CopcDataSource | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<CopcStats | null>(null);

  const load = useCallback(
    async (url: string, options: CopcDataSourceOptions = {}) => {
      if (!viewer) return;

      dataSourceRef.current?.destroy();
      dataSourceRef.current = null;
      setStats(null);
      setError('');
      setStatus('Loading…');
      setLoading(true);

      try {
        const ds = await CopcDataSource.load(url, viewer, options);
        // The viewer (and this component) may have unmounted while the
        // await above was in flight — React StrictMode's dev-mode
        // mount/unmount/remount cycle exercises exactly this race.
        if (viewer.isDestroyed()) {
          ds.destroy();
          return;
        }
        dataSourceRef.current = ds;
        setStatus('Loaded');
      } catch (err) {
        setStatus('');
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [viewer],
  );

  useEffect(() => {
    return () => {
      dataSourceRef.current?.destroy();
      dataSourceRef.current = null;
    };
  }, [viewer]);

  useEffect(() => {
    const id = setInterval(() => {
      const ds = dataSourceRef.current;
      if (ds) {
        setStats({ maxDepth: ds.maxDepth, nodeCount: ds.nodeCount, cacheSize: ds.cacheSize });
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  return { dataSourceRef, load, status, error, loading, stats };
}
