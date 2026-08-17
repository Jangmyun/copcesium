// Minimal example of copcesium's public API from a plain React component —
// no wrapper library, just useRef/useEffect. Everything a consumer needs is
// `CopcDataSource.load()`, a handful of live properties on the returned
// instance (`pixelSize`, `sseThreshold`, ...), and `destroy()`. COPC (Cloud
// Optimized Point Cloud) files stream in over HTTP range requests; load()
// resolves once the initial hierarchy is fetched and the camera has finished
// flying to the dataset (`autoFrame`, default true — see CopcDataSourceOptions
// for this and every other option, only a few of which are used below).
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { CopcDataSource } from 'copcesium';
import type { ColorMode, CopcDataSourceOptions } from 'copcesium';
import { CLASSES, SAMPLE_DATASETS } from './datasets';
import './App.css';

Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN ?? '';

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const dsRef = useRef<CopcDataSource | null>(null);

  const [datasetIndex, setDatasetIndex] = useState(0);
  const [url, setUrl] = useState(SAMPLE_DATASETS[0].url);
  const [pixelSize, setPixelSize] = useState(2);
  const [sseThreshold, setSseThreshold] = useState(250);
  const [colorMode, setColorMode] = useState<ColorMode>('intensity');
  const [checkedClasses, setCheckedClasses] = useState<Set<number>>(
    () => new Set(CLASSES.map(([code]) => code)),
  );
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // All boxes ticked means "no filter" rather than "these nine codes" — a
  // file may carry codes this panel doesn't list, and they shouldn't vanish
  // just because nothing was unticked.
  const classificationFilter =
    checkedClasses.size === CLASSES.length ? undefined : [...checkedClasses];

  const load = useCallback(
    async (loadUrl: string, options: CopcDataSourceOptions = {}) => {
      const viewer = viewerRef.current;
      if (!viewer) return;

      dsRef.current?.destroy();
      dsRef.current = null;

      setError('');
      setStatus('Loading…');
      setLoading(true);

      try {
        const ds = await CopcDataSource.load(loadUrl, viewer, {
          ...options,
          pixelSize,
          sseThreshold,
          colorMode,
          classificationFilter,
        });
        // The viewer (and this component) may have unmounted while the
        // await above was in flight — React StrictMode's dev-mode
        // mount/unmount/remount cycle exercises exactly this race.
        if (viewer.isDestroyed()) {
          ds.destroy();
          return;
        }
        dsRef.current = ds;
        setStatus('Loaded');
      } catch (err) {
        setStatus('');
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pixelSize, sseThreshold, colorMode, classificationFilter],
  );

  // Runs once: create the viewer and load the initial dataset. Live property
  // changes below go straight to `dsRef.current`, not through this effect.
  useEffect(() => {
    if (!containerRef.current) return;

    const viewer = new Cesium.Viewer(containerRef.current);
    viewerRef.current = viewer;
    void load(SAMPLE_DATASETS[0].url, SAMPLE_DATASETS[0].options);

    return () => {
      dsRef.current?.destroy();
      dsRef.current = null;
      viewer.destroy();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleDatasetChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const index = Number(e.target.value);
    const dataset = SAMPLE_DATASETS[index];
    setDatasetIndex(index);
    setUrl(dataset.url);
    void load(dataset.url, dataset.options);
  }

  function handleLoadClick() {
    void load(url.trim());
  }

  function handlePixelSizeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = Number(e.target.value);
    setPixelSize(value);
    if (dsRef.current) dsRef.current.pixelSize = value;
  }

  function handleSseThresholdChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = Number(e.target.value);
    setSseThreshold(value);
    if (dsRef.current) dsRef.current.sseThreshold = value;
  }

  function handleColorModeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value as ColorMode;
    setColorMode(value);
    if (dsRef.current) dsRef.current.colorMode = value;
  }

  function handleClassToggle(code: number) {
    setCheckedClasses((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      if (dsRef.current) {
        dsRef.current.classificationFilter = next.size === CLASSES.length ? undefined : [...next];
      }
      return next;
    });
  }

  return (
    <>
      <div ref={containerRef} className="cesiumContainer" />

      <div className="panel">
        <label className="datasetLabel">
          sample data:
          <select value={datasetIndex} onChange={handleDatasetChange}>
            {SAMPLE_DATASETS.map((dataset, i) => (
              <option key={dataset.url} value={i}>
                {dataset.label}
              </option>
            ))}
          </select>
        </label>
        <input
          className="urlInput"
          type="text"
          placeholder="COPC URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div>
          <button disabled={loading} onClick={handleLoadClick}>
            Load
          </button>
          <button disabled={loading || !dsRef.current} onClick={handleLoadClick}>
            Remove &amp; reload
          </button>
        </div>
        <label>
          pixelSize: <span>{pixelSize}</span>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={pixelSize}
            onChange={handlePixelSizeChange}
          />
        </label>
        <label>
          sseThreshold: <span>{sseThreshold}</span>
          <input
            type="range"
            min={50}
            max={1000}
            step={10}
            value={sseThreshold}
            onChange={handleSseThresholdChange}
          />
        </label>
        <hr />
        <label>
          colorMode:
          <select value={colorMode} onChange={handleColorModeChange}>
            <option value="rgb">rgb</option>
            <option value="intensity">intensity</option>
            <option value="classification">classification</option>
            <option value="elevation">elevation</option>
          </select>
        </label>
        <div>classificationFilter:</div>
        <div className="classChecks">
          {CLASSES.map(([code, name]) => (
            <label key={code}>
              <input
                type="checkbox"
                checked={checkedClasses.has(code)}
                onChange={() => handleClassToggle(code)}
              />
              {code} {name}
            </label>
          ))}
        </div>
        <hr />
        <div className="status">{status}</div>
        <div className="error">{error}</div>
      </div>
    </>
  );
}
