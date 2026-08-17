// Advanced example: the same public API `examples/basic-viewer` exercises
// (`CopcDataSource.load()`, live setters, `destroy()`), driving a fuller
// viewer UI — sidebar tabs, preset datasets, per-color-mode legends, a
// classification filter panel, terrain/imagery pickers, and a camera/FPS
// HUD. See `examples/basic-viewer` for the minimal reference; this is the
// "what a real app looks like" companion (see issue for scope notes: no
// `onProgress` or per-node stats — neither exists on `CopcDataSource` today).
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { CopcDataSource } from 'copcesium';
import type { ColorMode, CopcDataSourceOptions } from 'copcesium';

Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN ?? '';

const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayerPicker: false,
  sceneModePicker: false,
  animation: false,
  timeline: false,
  geocoder: false,
  homeButton: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  // No Cesium Ion token required out of the box: the plain WGS84 ellipsoid
  // plus OpenStreetMap tiles. Cesium World Terrain and Ion Satellite stay
  // available from the Global tab as opt-in upgrades a token unlocks — the
  // same split react-resium-viewer uses.
  baseLayer: new Cesium.ImageryLayer(
    new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
  ),
  // Static point-cloud viewer with no animated entities — render only when
  // something actually changes (camera move, tile load, or CopcDataSource
  // touching the scene) instead of every frame.
  requestRenderMode: true,
});
(viewer.cesiumWidget.creditContainer as HTMLElement).style.display = 'none';

// ── Preset datasets ─────────────────────────────────────────
// Freely streamable public COPC files (HTTP range requests, no auth). `size`
// is the full file size (measured via HTTP HEAD), not what gets downloaded —
// copcesium only fetches the octree nodes needed for the current view. Autzen
// stays first as the project's default demo; the rest are sorted by size,
// ascending.
interface PresetConfig {
  label: string;
  url: string;
  size: string;
  options?: CopcDataSourceOptions;
}
const PRESETS: Record<string, PresetConfig> = {
  autzen: {
    label: 'Autzen Stadium',
    url: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
    size: '~81 MB',
    options: {
      // Oregon Lambert (feet) — supplied explicitly rather than relying on
      // CRS auto-detection.
      proj: 'EPSG:2992',
      projDef:
        '+proj=lcc +lat_1=43 +lat_2=45.5 +lat_0=41.75 +lon_0=-120.5' +
        ' +x_0=399999.9999999999 +y_0=0 +datum=NAD83 +units=ft +no_defs',
      geoidOffset: -20,
    },
  },
  redrocksLarge: {
    label: 'Red Rocks (Large)',
    url: 'https://s3.amazonaws.com/hobu-lidar/redrocks.large.copc.laz',
    size: '~13.2 MB',
  },
  kate: {
    label: 'Kate',
    url: 'https://s3.amazonaws.com/hobu-lidar/kate.copc.laz',
    size: '~71.9 MB',
  },
  niagara: {
    label: 'Niagara Region',
    url: 'https://canelevation-lidar-point-clouds.s3.ca-central-1.amazonaws.com/pointclouds_nuagespoints/NRCAN/Hamilton_Niagara_2021_2/ON_Niagara_20210525_NAD83CSRS_UTM17N_1km_E656_N4771_CLASS.copc.laz',
    size: '~140.3 MB',
  },
  trestle: {
    label: 'Trestle Bridge',
    url: 'https://s3.amazonaws.com/grid-public-ept/20210421-FLW-Trestle-low-attitude.copc.laz',
    size: '~324.8 MB',
  },
  millsite: {
    label: 'Millsite Reservoir',
    url: 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz',
    size: '~1.4 GB',
  },
  sofi: {
    label: 'SoFi Stadium',
    url: 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz',
    size: '~2.0 GB',
  },
  iowa3dep: {
    label: 'Iowa 3DEP (2019–2020)',
    url: 'https://s3.amazonaws.com/hobu-lidar/iowa-50m-3dep-2019-2020.copc.laz',
    size: '~3.6 GB',
  },
  nyc: {
    label: 'New York City',
    url: 'https://s3.amazonaws.com/hobu-lidar/nyc.copc.laz',
    size: '~26.5 GB',
  },
  montreal: {
    label: 'Montréal',
    url: 'https://s3.amazonaws.com/hobu-lidar/montreal-2015.copc.laz',
    size: '~51.9 GB',
  },
};

// ASPRS classification codes this example's filter panel and legend cover.
// Colors mirror `src/style/classificationColors.ts`'s palette so the legend
// matches what `colorMode: 'classification'` actually renders; codes 0/1
// (never classified / unclassified) fall back to that module's default gray.
const CLASSES: [number, string, string][] = [
  [0, 'Created, never classified', '#bebebe'],
  [1, 'Unclassified', '#bebebe'],
  [2, 'Ground', '#996f42'],
  [3, 'Low Vegetation', '#5a9c44'],
  [4, 'Medium Vegetation', '#468535'],
  [5, 'High Vegetation', '#326e26'],
  [6, 'Building', '#db8d33'],
  [9, 'Water', '#3b79bf'],
  [10, 'Rail', '#8c8c8c'],
  [11, 'Road Surface', '#646464'],
];

// ── UI element references ───────────────────────────────────
const app = document.getElementById('app')!;
const panel = document.getElementById('panel')!;
const collapseBtn = document.getElementById('collapseBtn')!;
const railLogo = document.getElementById('railLogo')!;
const panelTitle = document.getElementById('panelTitle')!;
const presetList = document.getElementById('presetList')!;
const presetCount = document.getElementById('presetCount')!;
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const loadBtn = document.getElementById('loadBtn') as HTMLButtonElement;
const reloadBtn = document.getElementById('reloadBtn') as HTMLButtonElement;

const sseSlider = document.getElementById('sseSlider') as HTMLInputElement;
const sseDisplay = document.getElementById('sseDisplay')!;
const terrainSelect = document.getElementById('terrainSelect') as HTMLSelectElement;
const imagerySelect = document.getElementById('imagerySelect') as HTMLSelectElement;

const colorModeGrid = document.getElementById('colorModeGrid')!;
const colorLegend = document.getElementById('colorLegend')!;

const filterAllRow = document.getElementById('filterAllRow')!;
const filterAllCheck = document.getElementById('filterAllCheck')!;
const classFilterList = document.getElementById('classFilterList')!;

const pixelSizeSlider = document.getElementById('pixelSizeSlider') as HTMLInputElement;
const opacitySlider = document.getElementById('opacitySlider') as HTMLInputElement;
const opacityDisplay = document.getElementById('opacityDisplay')!;
const heightOffsetSlider = document.getElementById('heightOffsetSlider') as HTMLInputElement;
const heightOffsetDisplay = document.getElementById('heightOffsetDisplay')!;
const pixelSizeDisplay = document.getElementById('pixelSizeDisplay')!;

const infoName = document.getElementById('infoName')!;
const infoMeta = document.getElementById('infoMeta')!;
const infoStatus = document.getElementById('infoStatus')!;

const chipDot = document.getElementById('chipDot')!;
const chipName = document.getElementById('chipName')!;
const chipPts = document.getElementById('chipPts')!;
const errorBanner = document.getElementById('errorBanner')!;
const themeBtn = document.getElementById('themeBtn')!;
const homeBtn = document.getElementById('homeBtn')!;
const zoomInBtn = document.getElementById('zoomInBtn')!;
const zoomOutBtn = document.getElementById('zoomOutBtn')!;

const ftLon = document.getElementById('ftLon')!;
const ftLat = document.getElementById('ftLat')!;
const ftElev = document.getElementById('ftElev')!;
const ftCam = document.getElementById('ftCam')!;
const ftProj = document.getElementById('ftProj')!;
const ftNodes = document.getElementById('ftNodes')!;
const ftFps = document.getElementById('ftFps')!;

// ── Panel tabs ───────────────────────────────────────────────
const PANEL_TITLES: Record<string, string> = {
  data: 'Data',
  global: 'Global',
  appearance: 'Appearance',
  filter: 'Filter',
  points: 'Points',
  info: 'Info',
  help: 'Help',
};

function switchTab(tab: string): void {
  document.querySelectorAll('.rail-btn[data-tab]').forEach((btn) => {
    const el = btn as HTMLElement;
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.panel-section').forEach((sec) => {
    const el = sec as HTMLElement;
    el.classList.toggle('active', el.id === `sec-${tab}`);
  });
  panelTitle.textContent = PANEL_TITLES[tab] ?? tab;
  if (panel.classList.contains('collapsed')) toggleCollapse(false);
}
document.querySelectorAll('.rail-btn[data-tab]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const el = btn as HTMLElement;
    // Re-clicking the tab that's already showing collapses the panel, so the
    // rail button doubles as its own toggle. Any other tab keeps the old
    // behaviour: switch to it, expanding first if collapsed.
    if (el.classList.contains('active') && !panel.classList.contains('collapsed')) {
      toggleCollapse(true);
      return;
    }
    switchTab(el.dataset.tab ?? '');
  }),
);

// ── Panel collapse ───────────────────────────────────────────
function toggleCollapse(forceCollapsed?: boolean): void {
  const collapsed =
    forceCollapsed !== undefined ? forceCollapsed : !panel.classList.contains('collapsed');
  panel.classList.toggle('collapsed', collapsed);
  collapseBtn.classList.toggle('collapsed', collapsed);
}
collapseBtn.addEventListener('click', () => toggleCollapse());
railLogo.addEventListener('click', () => toggleCollapse());

// ── Theme ────────────────────────────────────────────────────
let theme = 'dark';
const SUN_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/></svg>`;
const MOON_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
function applyTheme(t: string): void {
  theme = t;
  app.setAttribute('data-theme', t);
  themeBtn.innerHTML = t === 'dark' ? SUN_ICON : MOON_ICON;
}
applyTheme('dark');
themeBtn.addEventListener('click', () => applyTheme(theme === 'dark' ? 'light' : 'dark'));

// ── Zoom / home controls ─────────────────────────────────────
// Home reframes the loaded dataset via the public `zoomTo()` when one is
// present, falling back to the globe-wide default view otherwise.
homeBtn.addEventListener('click', () => {
  if (currentDs) void currentDs.zoomTo();
  else viewer.camera.flyHome();
});
zoomInBtn.addEventListener('click', () => {
  const h = viewer.camera.positionCartographic.height;
  viewer.camera.zoomIn(h * 0.35);
});
zoomOutBtn.addEventListener('click', () => {
  const h = viewer.camera.positionCartographic.height;
  viewer.camera.zoomOut(h * 0.6);
});

// ── Terrain / imagery ────────────────────────────────────────
// A generation counter guards against a stale async response (Ion token
// issue, network error) overwriting a later selection made before it settles.
let _terrainGen = 0;
terrainSelect.addEventListener('change', async () => {
  const gen = ++_terrainGen;
  try {
    const provider =
      terrainSelect.value === 'world'
        ? await Cesium.createWorldTerrainAsync()
        : new Cesium.EllipsoidTerrainProvider();
    if (gen !== _terrainGen) return;
    viewer.terrainProvider = provider;
    viewer.scene.requestRender();
  } catch (err) {
    if (gen !== _terrainGen) return;
    console.error('[main] Terrain load failed:', err);
  }
});

let _imageryGen = 0;
imagerySelect.addEventListener('change', async () => {
  const gen = ++_imageryGen;
  try {
    const v = imagerySelect.value;
    const provider =
      v === 'satellite'
        ? await Cesium.IonImageryProvider.fromAssetId(2)
        : v === 'osm'
          ? new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
          : null;
    if (gen !== _imageryGen) return;
    viewer.imageryLayers.removeAll();
    if (provider) viewer.imageryLayers.addImageryProvider(provider);
    viewer.scene.requestRender();
  } catch (err) {
    if (gen !== _imageryGen) return;
    console.error('[main] Imagery load failed:', err);
  }
});

// ── SSE threshold / point size sliders ──────────────────────
sseSlider.addEventListener('input', () => {
  const v = parseInt(sseSlider.value, 10);
  sseDisplay.textContent = `${v} px`;
  if (currentDs) currentDs.sseThreshold = v;
});
pixelSizeSlider.addEventListener('input', () => {
  const v = parseFloat(pixelSizeSlider.value);
  pixelSizeDisplay.textContent = v.toFixed(1);
  if (currentDs) currentDs.pixelSize = v;
});
opacitySlider.addEventListener('input', () => {
  const v = parseFloat(opacitySlider.value);
  opacityDisplay.textContent = v.toFixed(2);
  if (currentDs) currentDs.opacity = v;
});
// Corrects a geoid/vertical-datum mismatch that leaves the cloud floating
// above or buried under the globe surface. A model-matrix shift per node, so
// dragging this costs nothing beyond a re-render.
heightOffsetSlider.addEventListener('input', () => {
  const v = parseFloat(heightOffsetSlider.value);
  heightOffsetDisplay.textContent = `${v.toFixed(1)} m`;
  if (currentDs) currentDs.heightOffset = v;
});

// ── Appearance: color mode ──────────────────────────────────
// Matches renderer/shaders.ts's `elevationColor()` ramp stops exactly, so
// the legend reflects what's actually drawn.
const ELEVATION_RAMP_CSS =
  'linear-gradient(to top, #0000ff 0%, #00ffff 25%, #00ff00 50%, #ffff00 75%, #ff0000 100%)';
const INTENSITY_RAMP_CSS = 'linear-gradient(to top, #000 0%, #fff 100%)';

function updateColorLegend(mode: ColorMode): void {
  if (mode === 'elevation') {
    colorLegend.innerHTML = `
      <div style="display:flex;gap:10px;align-items:stretch">
        <div style="width:14px;border-radius:3px;background:${ELEVATION_RAMP_CSS}"></div>
        <div style="display:flex;flex-direction:column;justify-content:space-between;font-size:11px;color:var(--dim)">
          <span>High</span>
          <span>Low</span>
        </div>
      </div>`;
    return;
  }
  if (mode === 'intensity') {
    colorLegend.innerHTML = `
      <div style="display:flex;gap:10px;align-items:stretch">
        <div style="width:14px;border-radius:3px;background:${INTENSITY_RAMP_CSS}"></div>
        <div style="display:flex;flex-direction:column;justify-content:space-between;font-size:11px;color:var(--dim)">
          <span>High</span>
          <span>Low</span>
        </div>
      </div>`;
    return;
  }
  if (mode === 'classification') {
    colorLegend.innerHTML = `<div style="display:flex;flex-direction:column;gap:7px">${CLASSES.map(
      ([, name, color]) =>
        `<div class="cls-stop"><span class="cls-stop-swatch" style="background:${color}"></span><span class="cls-stop-label">${name}</span></div>`,
    ).join('')}</div>`;
    return;
  }
  colorLegend.innerHTML = `<div style="font-size:11.5px;color:var(--dim)">Uses the file's own RGB, falling back to the classification palette, then flat gray.</div>`;
}

colorModeGrid.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.color-btn') as HTMLElement | null;
  if (!btn) return;
  colorModeGrid.querySelectorAll('.color-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  const mode = (btn.dataset.mode ?? 'rgb') as ColorMode;
  if (currentDs) currentDs.colorMode = mode;
  updateColorLegend(mode);
});

// ── Classification filter ───────────────────────────────────
const _classOn: Record<number, boolean> = {};
for (const [code] of CLASSES) _classOn[code] = true;

function updateClassFilter(): void {
  if (!currentDs) return;
  const allOn = Object.values(_classOn).every((v) => v);
  currentDs.classificationFilter = allOn
    ? undefined
    : Object.entries(_classOn)
        .filter(([, on]) => on)
        .map(([code]) => Number(code));
}

function syncAllCheck(): void {
  filterAllCheck.classList.toggle(
    'on',
    Object.values(_classOn).every((v) => v),
  );
}

function rebuildClassList(): void {
  classFilterList.innerHTML = '';
  for (const [code, name, color] of CLASSES) {
    const on = _classOn[code];
    const row = document.createElement('button');
    row.className = `cls-row${on ? '' : ' off'}`;
    row.innerHTML =
      `<span class="cls-swatch" style="background:${color}"></span>` +
      `<span class="cls-name">${name} (${code})</span>` +
      `<span class="cls-check${on ? ' on' : ''}">` +
      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 12 4 4 9-10"/></svg>` +
      `</span>`;
    row.addEventListener('click', () => {
      _classOn[code] = !_classOn[code];
      rebuildClassList();
      syncAllCheck();
      updateClassFilter();
    });
    classFilterList.appendChild(row);
  }
}
rebuildClassList();

filterAllRow.addEventListener('click', () => {
  const newVal = !Object.values(_classOn).every((v) => v);
  for (const [code] of CLASSES) _classOn[code] = newVal;
  rebuildClassList();
  syncAllCheck();
  updateClassFilter();
});

// ── Preset list ──────────────────────────────────────────────
const PRESET_KEYS = Object.keys(PRESETS);
presetCount.textContent = String(PRESET_KEYS.length);

function renderPresetList(activeKey: string | null): void {
  presetList.innerHTML = '';
  for (const key of PRESET_KEYS) {
    const p = PRESETS[key];
    const btn = document.createElement('button');
    btn.className = `dataset-row${activeKey === key ? ' active' : ''}`;
    btn.innerHTML =
      `<span class="dataset-dot"></span>` +
      `<span class="dataset-name">${p.label}</span>` +
      `<span class="dataset-pts">${p.size}</span>`;
    btn.addEventListener('click', () => {
      setActivePreset(key);
      urlInput.value = p.url;
      void loadCopc(p.url, p.options ?? {}, p.label);
    });
    presetList.appendChild(btn);
  }
}

// ── Current load state ──────────────────────────────────────
let currentDs: CopcDataSource | null = null;
let currentUrl: string | null = null;
let currentOptions: CopcDataSourceOptions = {};
let activeLabel: string | null = null;

function setActivePreset(key: string | null): void {
  activeLabel = key ? PRESETS[key].label : null;
  renderPresetList(key);
}

function setChipState(state: 'idle' | 'loading' | 'active', label?: string): void {
  chipDot.className =
    'chip-dot' + (state === 'active' ? ' active' : state === 'loading' ? ' loading' : '');
  chipName.textContent = label || 'No data loaded';
  chipPts.style.display = 'none';
}

function updateInfoPanel(name: string, rows: [string, string][]): void {
  infoName.textContent = name || '—';
  infoMeta.innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="meta-row"><span class="meta-key">${k}</span><span class="meta-val">${v}</span></div>`,
    )
    .join('');
}

// ── Footer: camera position ─────────────────────────────────
function updateFooter(): void {
  const cpos = viewer.camera.positionCartographic;
  if (!cpos) return;
  const lon = Cesium.Math.toDegrees(cpos.longitude);
  const lat = Cesium.Math.toDegrees(cpos.latitude);
  const elev = cpos.height;
  ftLon.textContent = lon.toFixed(4);
  ftLat.textContent = lat.toFixed(4);
  ftElev.textContent = `${Math.round(elev)} m`;
  ftCam.textContent = elev >= 1000 ? `${(elev / 1000).toFixed(1)} km` : `${Math.round(elev)} m`;
}
viewer.camera.changed.addEventListener(updateFooter);
viewer.camera.moveEnd.addEventListener(updateFooter);
updateFooter();

// ── FPS counter ──────────────────────────────────────────────
let _frames = 0;
let _lastFpsTime = performance.now();
viewer.scene.postRender.addEventListener(() => {
  _frames++;
  const now = performance.now();
  if (now - _lastFpsTime >= 1000) {
    ftFps.textContent = String(_frames);
    _frames = 0;
    _lastFpsTime = now;
  }
});

// ── Node/cache stats poll ────────────────────────────────────
// `CopcDataSource` has no progress callback, so the footer/info panel's node
// counts are sampled on an interval instead of pushed per-frame.
let _statsInterval: ReturnType<typeof setInterval> | null = null;
function startStatsPolling(label: string, epsg: string): void {
  stopStatsPolling();
  _statsInterval = setInterval(() => {
    if (!currentDs) return;
    const ds = currentDs;
    ftNodes.textContent = `${ds.cacheSize}/${ds.nodeCount}`;
    updateInfoPanel(label, [
      ['Format', 'COPC 1.0'],
      ['CRS', epsg],
      ['Max depth', String(ds.maxDepth)],
      ['Nodes (total)', ds.nodeCount.toLocaleString()],
      ['Nodes (cached)', ds.cacheSize.toLocaleString()],
    ]);
  }, 500);
}
function stopStatsPolling(): void {
  if (_statsInterval !== null) clearInterval(_statsInterval);
  _statsInterval = null;
}

// ── Load ─────────────────────────────────────────────────────
async function loadCopc(
  url: string,
  options: CopcDataSourceOptions,
  label?: string,
): Promise<void> {
  if (!url.trim()) return;

  if (currentDs) {
    stopStatsPolling();
    currentDs.destroy();
    currentDs = null;
  }

  const resolvedLabel =
    label ??
    url
      .split('/')
      .pop()!
      .replace(/\.copc\.laz$/, '');
  errorBanner.classList.remove('show');
  errorBanner.textContent = '';
  setChipState('loading', resolvedLabel);
  infoStatus.textContent = 'Loading…';
  loadBtn.disabled = true;
  reloadBtn.disabled = true;

  try {
    const activeMode = ((colorModeGrid.querySelector('.color-btn.active') as HTMLElement | null)
      ?.dataset.mode ?? 'rgb') as ColorMode;
    const ds = await CopcDataSource.load(url, viewer, {
      ...options,
      pixelSize: parseFloat(pixelSizeSlider.value),
      sseThreshold: parseInt(sseSlider.value, 10),
      colorMode: activeMode,
      opacity: parseFloat(opacitySlider.value),
      classificationFilter: Object.values(_classOn).every((v) => v)
        ? undefined
        : Object.entries(_classOn)
            .filter(([, on]) => on)
            .map(([code]) => Number(code)),
    });

    // heightOffset is a live property only — it isn't part of
    // CopcDataSourceOptions, so it's applied after load rather than passed in.
    ds.heightOffset = parseFloat(heightOffsetSlider.value);

    currentDs = ds;
    currentUrl = url;
    currentOptions = options;
    activeLabel = resolvedLabel;
    setChipState('active', resolvedLabel);

    const epsg = options.proj ?? 'EPSG:4326';
    ftProj.textContent = epsg;
    updateColorLegend(activeMode);
    updateInfoPanel(resolvedLabel, [
      ['Format', 'COPC 1.0'],
      ['CRS', epsg],
      ['Max depth', String(ds.maxDepth)],
      ['Nodes (total)', ds.nodeCount.toLocaleString()],
    ]);
    infoStatus.textContent = '';
    startStatsPolling(resolvedLabel, epsg);
  } catch (err) {
    setChipState('idle', 'Load failed');
    infoStatus.textContent = '';
    const message = err instanceof Error ? err.message : String(err);
    errorBanner.textContent = message;
    errorBanner.classList.add('show');
    console.error(err);
  } finally {
    loadBtn.disabled = false;
    reloadBtn.disabled = !currentDs;
  }
}

// ── URL input ────────────────────────────────────────────────
loadBtn.addEventListener('click', () => {
  setActivePreset(null);
  const url = urlInput.value.trim();
  void loadCopc(
    url,
    {},
    url
      .split('/')
      .pop()!
      .replace(/\.copc\.laz$/, ''),
  );
});
urlInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') loadBtn.click();
});
urlInput.addEventListener('input', () => setActivePreset(null));

// `destroy()` + re-`load()` the same URL, to manually confirm no leaked
// Workers/primitives across repeated cycles.
reloadBtn.addEventListener('click', () => {
  if (!currentUrl) return;
  void loadCopc(currentUrl, currentOptions, activeLabel ?? undefined);
});

// ── Initial load ─────────────────────────────────────────────
// The legend is otherwise only drawn on click, leaving the box empty next to
// an already-active mode button until the user picks a different one.
updateColorLegend(
  ((colorModeGrid.querySelector('.color-btn.active') as HTMLElement | null)?.dataset.mode ??
    'intensity') as ColorMode,
);
renderPresetList(null);
setActivePreset('autzen');
urlInput.value = PRESETS.autzen.url;
void loadCopc(PRESETS.autzen.url, PRESETS.autzen.options ?? {}, PRESETS.autzen.label);
