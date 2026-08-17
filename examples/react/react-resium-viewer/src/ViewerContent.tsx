// Rendered as a child of resium's <Viewer>, so `useCesium()` here resolves
// to the real Cesium.Viewer instance from context — the idiomatic resium way
// to reach imperative Cesium/copcesium APIs, in contrast to the ref-based
// escape hatch shown in examples/react/react-viewer.
//
// The icon-rail/tabbed-panel/footer shell is ported from copcesium's earlier
// prototype UI, restyled but structurally the same. Only the design moved —
// every control below is wired to a feature the current `copcesium` library
// actually exposes (`pixelSize`, `opacity`, `colorMode`,
// `classificationFilter`, `sseThreshold`, `heightOffset`,
// `maxDepth`/`nodeCount`/`cacheSize`, `zoomTo()`). The prototype's per-node
// progress readout and per-dataset CRS override sliders relied on an older
// library API this version doesn't have, so they aren't reproduced here.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useCesium } from 'resium';
import type { ColorMode } from 'copcesium';
import { CLASS_COLORS, CLASSES, SAMPLE_DATASETS } from './datasets';
import { useCopcDataSource } from './useCopcDataSource';
import { useViewerChrome, type Imagery, type Terrain } from './useViewerChrome';

const TABS = ['data', 'global', 'appearance', 'filter', 'points', 'info', 'help'] as const;
type Tab = (typeof TABS)[number];
const TAB_TITLES: Record<Tab, string> = {
  data: 'Data',
  global: 'Global',
  appearance: 'Appearance',
  filter: 'Filter',
  points: 'Points',
  info: 'Info',
  help: 'Help',
};

const COLOR_MODES: [label: string, mode: ColorMode][] = [
  ['Classification', 'classification'],
  ['Elevation', 'elevation'],
  ['Intensity', 'intensity'],
  ['RGB', 'rgb'],
];

const RAIL_ICONS: Record<Tab, ReactElement> = {
  data: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" />
      <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" />
    </svg>
  ),
  global: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
    </svg>
  ),
  appearance: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="13.5" cy="6.5" r="2" />
      <circle cx="17.5" cy="11" r="2" />
      <circle cx="8.5" cy="7" r="2" />
      <circle cx="6.5" cy="12.5" r="2" />
      <path d="M12 22a10 10 0 1 1 0-20 8 8 0 0 1 8 8 4 4 0 0 1-4 4h-2a2 2 0 0 0-1 3.7A1.3 1.3 0 0 1 12 22z" />
    </svg>
  ),
  filter: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 4h16l-6 8v6l-4 2v-8z" />
    </svg>
  ),
  points: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="7" r="2.4" />
      <circle cx="17" cy="6" r="2.4" />
      <circle cx="12" cy="15" r="2.4" />
      <circle cx="18" cy="16" r="2.4" />
    </svg>
  ),
  info: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
  help: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" />
    </svg>
  ),
};

const SUN_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
  </svg>
);
const MOON_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
  >
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

interface Props {
  terrain: Terrain;
  onTerrainChange: (t: Terrain) => void;
  imagery: Imagery;
  onImageryChange: (i: Imagery) => void;
}

export default function ViewerContent({
  terrain,
  onTerrainChange,
  imagery,
  onImageryChange,
}: Props) {
  const { viewer } = useCesium();
  const { dataSourceRef, load, status, error, loading, stats } = useCopcDataSource(viewer);
  const { theme, setTheme, camera, fps, zoomHome, zoomIn, zoomOut } = useViewerChrome(viewer);

  const [tab, setTab] = useState<Tab>('data');
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  const [datasetIndex, setDatasetIndex] = useState<number | null>(0);
  const [url, setUrl] = useState(SAMPLE_DATASETS[0].url);
  const [proj, setProj] = useState(SAMPLE_DATASETS[0].options.proj ?? 'EPSG:4326');
  const [pixelSize, setPixelSize] = useState(2);
  const [opacity, setOpacity] = useState(1);
  const [sseThreshold, setSseThreshold] = useState(250);
  const [colorMode, setColorMode] = useState<ColorMode>('intensity');
  const [checkedClasses, setCheckedClasses] = useState<Set<number>>(
    () => new Set(CLASSES.map(([code]) => code)),
  );
  // Manual correction for a geoid/vertical-datum mismatch between the point
  // cloud and the globe surface — not part of CopcDataSourceOptions, so it
  // resets to 0 (CopcDataSource's own default) on every new load rather than
  // carrying over between datasets. `heightOffsetText` is the input's own
  // display string, tracked separately from the committed number: while
  // typing "-3", the intermediate "-" alone doesn't parse to a finite
  // number, and if the input's `value` were bound straight to `heightOffset`
  // it would snap back to the last committed value on every such keystroke,
  // making a negative number impossible to type.
  const [heightOffset, setHeightOffset] = useState(0);
  const [heightOffsetText, setHeightOffsetText] = useState('0');

  const initialLoadTriggered = useRef(false);
  useEffect(() => {
    if (!viewer || initialLoadTriggered.current) return;
    initialLoadTriggered.current = true;
    const dataset = SAMPLE_DATASETS[0];
    void load(dataset.url, { ...dataset.options, pixelSize, opacity, sseThreshold, colorMode });
    // Only the initial load reads the current slider/select state; every
    // later load or live edit goes through the handlers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, load]);

  function readClassFilter(classes: Set<number>): number[] | undefined {
    return classes.size === CLASSES.length ? undefined : [...classes];
  }

  function switchTab(t: Tab) {
    setTab(t);
    if (panelCollapsed) setPanelCollapsed(false);
  }

  function handleDatasetChange(index: number) {
    const dataset = SAMPLE_DATASETS[index];
    setDatasetIndex(index);
    setUrl(dataset.url);
    setProj(dataset.options.proj ?? 'EPSG:4326');
    setHeightOffset(0);
    setHeightOffsetText('0');
    void load(dataset.url, {
      ...dataset.options,
      pixelSize,
      opacity,
      sseThreshold,
      colorMode,
      classificationFilter: readClassFilter(checkedClasses),
    });
  }

  function handleLoadClick() {
    setDatasetIndex(null);
    setProj('EPSG:4326');
    setHeightOffset(0);
    setHeightOffsetText('0');
    void load(url.trim(), {
      pixelSize,
      opacity,
      sseThreshold,
      colorMode,
      classificationFilter: readClassFilter(checkedClasses),
    });
  }

  function handlePixelSizeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = Number(e.target.value);
    setPixelSize(value);
    if (dataSourceRef.current) dataSourceRef.current.pixelSize = value;
  }

  function handleOpacityChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = Number(e.target.value);
    setOpacity(value);
    if (dataSourceRef.current) dataSourceRef.current.opacity = value;
  }

  function handleSseThresholdChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = Number(e.target.value);
    setSseThreshold(value);
    if (dataSourceRef.current) dataSourceRef.current.sseThreshold = value;
  }

  function handleColorModeChange(mode: ColorMode) {
    setColorMode(mode);
    if (dataSourceRef.current) dataSourceRef.current.colorMode = mode;
  }

  function handleClassToggle(code: number) {
    setCheckedClasses((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      if (dataSourceRef.current) dataSourceRef.current.classificationFilter = readClassFilter(next);
      return next;
    });
  }

  function handleAllClassesToggle() {
    const allOn = checkedClasses.size === CLASSES.length;
    setCheckedClasses(allOn ? new Set() : new Set(CLASSES.map(([code]) => code)));
    if (dataSourceRef.current) {
      dataSourceRef.current.classificationFilter = allOn ? [] : undefined;
    }
  }

  function adjustHeightOffset(delta: number) {
    setHeightOffset((prev) => {
      const next = Math.round((prev + delta) * 10) / 10;
      setHeightOffsetText(String(next));
      if (dataSourceRef.current) dataSourceRef.current.heightOffset = next;
      return next;
    });
  }

  function handleHeightOffsetInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    // Always mirror exactly what was typed — including intermediate states
    // like "-" or "-3." that don't parse yet — so the field never snaps back
    // mid-keystroke. Only a value that *does* parse gets committed live.
    const text = e.target.value;
    setHeightOffsetText(text);
    const value = Number(text);
    if (text.trim() !== '' && Number.isFinite(value)) {
      setHeightOffset(value);
      if (dataSourceRef.current) dataSourceRef.current.heightOffset = value;
    }
  }

  function handleHeightOffsetInputBlur() {
    // Leaving the field on an incomplete/invalid string (empty, a lone "-")
    // snaps the display back to the last value that actually committed.
    setHeightOffsetText(String(heightOffset));
  }

  function handleHeightOffsetWheel(e: React.WheelEvent<HTMLDivElement>) {
    e.preventDefault();
    // A bigger step than the +/- buttons' 0.5 m — one-at-a-time clicking is
    // for precision, scrolling is for covering a wide gap quickly.
    adjustHeightOffset(e.deltaY < 0 ? 2 : -2);
  }

  // Holding a +/- button repeats its 0.5 m step instead of requiring a click
  // per 0.5 m. `holdTimeout` delays the first repeat so a normal click (whose
  // mouseup arrives well under that delay) never double-fires; `holdInterval`
  // is the actual repeat once holding is confirmed.
  const holdTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  // Whether the interval fired at least once this press — if so, the click
  // event mouseup also fires never gets its own adjustHeightOffset call, or
  // the release would apply one extra 0.5 m on top of what holding already did.
  const holdFired = useRef(false);

  function stopHeightOffsetHold() {
    if (holdTimeout.current) {
      clearTimeout(holdTimeout.current);
      holdTimeout.current = null;
    }
    if (holdInterval.current) {
      clearInterval(holdInterval.current);
      holdInterval.current = null;
    }
  }

  function startHeightOffsetHold(delta: number) {
    stopHeightOffsetHold();
    holdFired.current = false;
    holdTimeout.current = setTimeout(() => {
      holdInterval.current = setInterval(() => {
        holdFired.current = true;
        adjustHeightOffset(delta);
      }, 80);
    }, 350);
  }

  function handleHeightOffsetClick(delta: number) {
    if (holdFired.current) {
      holdFired.current = false;
      return;
    }
    adjustHeightOffset(delta);
  }

  useEffect(() => stopHeightOffsetHold, []);

  const allClassesOn = checkedClasses.size === CLASSES.length;
  const chipState = error
    ? 'error'
    : loading
      ? 'loading'
      : dataSourceRef.current
        ? 'active'
        : 'idle';
  const label =
    datasetIndex !== null
      ? SAMPLE_DATASETS[datasetIndex].label.split(' — ')[0]
      : (url.trim().split('/').pop() ?? url);

  return (
    <div
      className="shell"
      data-theme={theme}
      style={{ '--panel-w': panelCollapsed ? '0px' : '320px' } as React.CSSProperties}
    >
      {/* ── Icon rail ─────────────────────────────────────── */}
      <nav className="rail">
        <div className="railLogo">
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeLinejoin="round"
          >
            <path d="M12 2 3 7v10l9 5 9-5V7z" />
            <path d="M3 7l9 5 9-5M12 12v10" opacity=".65" />
          </svg>
        </div>
        {TABS.map((t) => (
          <button
            key={t}
            className={`railBtn${tab === t ? ' active' : ''}`}
            title={TAB_TITLES[t]}
            onClick={() => switchTab(t)}
          >
            {RAIL_ICONS[t]}
          </button>
        ))}
        <div className="railSpacer" />
        <button
          className={`railCollapse${panelCollapsed ? ' collapsed' : ''}`}
          title="Collapse panel"
          onClick={() => setPanelCollapsed((c) => !c)}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </nav>

      {/* ── Left panel ────────────────────────────────────── */}
      <aside className={`panel${panelCollapsed ? ' collapsed' : ''}`}>
        <div className="panelHeader">
          <div className="panelBrand">
            <span style={{ color: 'var(--text)' }}>copc</span>
            <span style={{ color: 'var(--accent)' }}>esium</span>
          </div>
          <span className="panelVersion">react-resium</span>
        </div>

        <div className="panelBody">
          <div className="panelTitle">{TAB_TITLES[tab]}</div>

          {tab === 'data' && (
            <>
              <div className="secLabel">URL</div>
              <div className="urlRow">
                <input
                  type="text"
                  placeholder="https://…copc.laz"
                  spellCheck={false}
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setDatasetIndex(null);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleLoadClick()}
                />
                <button disabled={loading} onClick={handleLoadClick}>
                  Load
                </button>
              </div>
              <div className="urlRow" style={{ marginTop: 7 }}>
                <button
                  style={{
                    flex: 1,
                    background: 'var(--panel2)',
                    color: 'var(--text)',
                    border: '1px solid var(--border)',
                  }}
                  disabled={loading || !dataSourceRef.current}
                  onClick={() => void dataSourceRef.current?.zoomTo()}
                >
                  Zoom to dataset
                </button>
              </div>

              <div className="secLabelRow" style={{ marginTop: 18 }}>
                <span className="label">Sample data</span>
                <span className="count">{SAMPLE_DATASETS.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {SAMPLE_DATASETS.map((dataset, i) => (
                  <button
                    key={dataset.url}
                    className={`datasetRow${datasetIndex === i ? ' active' : ''}`}
                    onClick={() => handleDatasetChange(i)}
                  >
                    <span className="datasetDot" />
                    <span className="datasetName">{dataset.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {tab === 'global' && (
            <>
              <div className="sliderRow">
                <div className="sliderHeader">
                  <span className="label">SSE threshold</span>
                  <span className="val">{sseThreshold} px</span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={3000}
                  step={50}
                  value={sseThreshold}
                  onChange={handleSseThresholdChange}
                />
              </div>
              <div className="divider" />
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12.5, marginBottom: 7 }}>Terrain</div>
                <select
                  value={terrain}
                  onChange={(e) => onTerrainChange(e.target.value as Terrain)}
                >
                  <option value="world">Cesium World Terrain</option>
                  <option value="ellipsoid">WGS84 ellipsoid</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize: 12.5, marginBottom: 7 }}>Imagery</div>
                <select
                  value={imagery}
                  onChange={(e) => onImageryChange(e.target.value as Imagery)}
                >
                  <option value="satellite">Satellite</option>
                  <option value="osm">OpenStreetMap</option>
                  <option value="none">None</option>
                </select>
              </div>
            </>
          )}

          {tab === 'appearance' && (
            <>
              <div className="secLabel">Color by</div>
              <div className="colorGrid">
                {COLOR_MODES.map(([label, mode]) => (
                  <button
                    key={mode}
                    className={`colorBtn${colorMode === mode ? ' active' : ''}`}
                    onClick={() => handleColorModeChange(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {colorMode === 'elevation' && (
                <div className="legendBox">
                  <div
                    className="legendBar"
                    style={{
                      background:
                        'linear-gradient(to top, #2952bf 0%, #33a673 25%, #d9cc40 50%, #e68033 75%, #cc3333 100%)',
                    }}
                  />
                  <div className="legendLabels">
                    <span>High</span>
                    <span>Low</span>
                  </div>
                </div>
              )}
              {colorMode === 'intensity' && (
                <div className="legendBox">
                  <div
                    className="legendBar"
                    style={{ background: 'linear-gradient(to top, #000 0%, #fff 100%)' }}
                  />
                  <div className="legendLabels">
                    <span>High</span>
                    <span>Low</span>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'filter' && (
            <>
              <div style={{ fontSize: 11.5, color: 'var(--dim)', marginBottom: 12 }}>
                Toggle classifications to include in the render.
              </div>
              <button className="clsRow" onClick={handleAllClassesToggle}>
                <span className="clsSwatch" style={{ background: 'var(--dim)' }} />
                <span className="clsName">All classes</span>
                <span className={`clsCheck${allClassesOn ? ' on' : ''}`}>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                  >
                    <path d="m5 12 4 4 9-10" />
                  </svg>
                </span>
              </button>
              {CLASSES.map(([code, name]) => {
                const on = checkedClasses.has(code);
                return (
                  <button
                    key={code}
                    className={`clsRow${on ? '' : ' off'}`}
                    style={{ borderTop: 'none' }}
                    onClick={() => handleClassToggle(code)}
                  >
                    <span
                      className="clsSwatch"
                      style={{ background: CLASS_COLORS[code] ?? '#888' }}
                    />
                    <span className="clsName">
                      {code} {name}
                    </span>
                    <span className={`clsCheck${on ? ' on' : ''}`}>
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                      >
                        <path d="m5 12 4 4 9-10" />
                      </svg>
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {tab === 'points' && (
            <>
              <div className="sliderRow">
                <div className="sliderHeader">
                  <span className="label">Point size</span>
                  <span className="val">{pixelSize.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={8}
                  step={0.1}
                  value={pixelSize}
                  onChange={handlePixelSizeChange}
                />
              </div>
              <div className="sliderRow">
                <div className="sliderHeader">
                  <span className="label">Opacity</span>
                  <span className="val">{opacity.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={opacity}
                  onChange={handleOpacityChange}
                />
              </div>
            </>
          )}

          {tab === 'info' && (
            <>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{label ?? '—'}</div>
              <div
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 10.5,
                  color: 'var(--faint)',
                  marginBottom: 16,
                }}
              >
                COPC · EPT hierarchy
              </div>
              <div className="metaRow">
                <span className="metaKey">Status</span>
                <span className="metaVal">{status || '—'}</span>
              </div>
              <div className="metaRow">
                <span className="metaKey">CRS</span>
                <span className="metaVal">{proj}</span>
              </div>
              <div className="metaRow">
                <span className="metaKey">maxDepth</span>
                <span className="metaVal">{stats?.maxDepth ?? '—'}</span>
              </div>
              <div className="metaRow">
                <span className="metaKey">nodeCount</span>
                <span className="metaVal">{stats?.nodeCount ?? '—'}</span>
              </div>
              <div className="metaRow">
                <span className="metaKey">cacheSize</span>
                <span className="metaVal">{stats?.cacheSize ?? '—'}</span>
              </div>
              {error && <div className="error">{error}</div>}
            </>
          )}

          {tab === 'help' && (
            <>
              <div className="secLabel" style={{ marginBottom: 10 }}>
                Navigation
              </div>
              <div className="shortcutRow">
                <span>Orbit</span>
                <kbd>drag</kbd>
              </div>
              <div className="shortcutRow">
                <span>Zoom</span>
                <kbd>scroll</kbd>
              </div>
              <div className="shortcutRow">
                <span>Pan</span>
                <kbd>shift + drag</kbd>
              </div>
              <div className="shortcutRow">
                <span>Reset view</span>
                <kbd>Home icon</kbd>
              </div>
              <div style={{ marginTop: 18, fontSize: 12, color: 'var(--dim)', lineHeight: 1.7 }}>
                Built with{' '}
                <a
                  href="https://cesium.com/"
                  style={{ color: 'var(--accent)', textDecoration: 'none' }}
                >
                  Cesium
                </a>{' '}
                +{' '}
                <a
                  href="https://copc.io/"
                  style={{ color: 'var(--accent)', textDecoration: 'none' }}
                >
                  COPC
                </a>
                , via{' '}
                <a
                  href="https://resium.reearth.io/"
                  style={{ color: 'var(--accent)', textDecoration: 'none' }}
                >
                  resium
                </a>
                .
                <br />
                HTTP range-request streaming with BFS LoD and frustum culling.
              </div>
            </>
          )}
        </div>
      </aside>

      {/* ── Viewport chrome ───────────────────────────────── */}
      <div className="chip">
        <div className={`chipDot${chipState === 'idle' ? '' : ` ${chipState}`}`} />
        <span className="chipName">{chipState === 'idle' ? 'No data loaded' : (label ?? url)}</span>
        {stats && <span className="chipMeta">{stats.nodeCount} nodes</span>}
      </div>

      <div className="vpControls">
        <button
          className="vpIconBtn"
          title="Toggle theme"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? SUN_ICON : MOON_ICON}
        </button>
        <div
          className="heightOffsetGroup"
          title="Manual height offset (m) — corrects a point cloud/globe elevation mismatch. Scroll, type, or use the +/- buttons."
          onWheel={handleHeightOffsetWheel}
        >
          <button
            className="vpZoomBtn"
            title="Raise 0.5 m (hold to repeat)"
            onClick={() => handleHeightOffsetClick(0.5)}
            onMouseDown={() => startHeightOffsetHold(0.5)}
            onMouseUp={stopHeightOffsetHold}
            onMouseLeave={stopHeightOffsetHold}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <input
            className="heightOffsetVal"
            type="number"
            step={0.5}
            value={heightOffsetText}
            onChange={handleHeightOffsetInputChange}
            onBlur={handleHeightOffsetInputBlur}
          />
          <button
            className="vpZoomBtn"
            title="Lower 0.5 m (hold to repeat)"
            onClick={() => handleHeightOffsetClick(-0.5)}
            onMouseDown={() => startHeightOffsetHold(-0.5)}
            onMouseUp={stopHeightOffsetHold}
            onMouseLeave={stopHeightOffsetHold}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M5 12h14" />
            </svg>
          </button>
        </div>
        <div className="vpZoomGroup">
          <button className="vpZoomBtn" title="Reset view" onClick={zoomHome}>
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </button>
          <button className="vpZoomBtn" title="Zoom in" onClick={zoomIn}>
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button className="vpZoomBtn" title="Zoom out" onClick={zoomOut}>
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M5 12h14" />
            </svg>
          </button>
        </div>
      </div>

      <div className="vpHint">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
        >
          <path d="M3 12a9 9 0 1 0 9-9" />
          <path d="M3 4v5h5" />
        </svg>
        drag orbit · scroll zoom · shift-drag pan
      </div>

      <footer className="footer">
        <span className="ftLbl">LON</span>&nbsp;<span>{camera ? camera.lon.toFixed(4) : '—'}</span>
        <div className="ftSep" />
        <span className="ftLbl">LAT</span>&nbsp;<span>{camera ? camera.lat.toFixed(4) : '—'}</span>
        <div className="ftSep" />
        <span className="ftLbl">ELEV</span>&nbsp;
        <span>{camera ? `${Math.round(camera.elevM)} m` : '—'}</span>
        <div className="ftSep" />
        <span className="ftLbl">EPSG</span>&nbsp;<span>{proj.replace('EPSG:', '')}</span>
        <div className="ftSpc" />
        <span className="ftLbl">NODES</span>&nbsp;<span>{stats?.nodeCount ?? '—'}</span>
        <div className="ftSep" />
        <div className="ftFps">
          <div className="ftFpsDot" />
          <span>{fps ?? '—'}</span>&nbsp;FPS
        </div>
      </footer>
    </div>
  );
}
