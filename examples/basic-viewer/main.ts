// Minimal example of copcesium's public API — everything a consumer needs is
// `CopcDataSource.load()`, a handful of live properties on the returned
// instance (`pixelSize`, `sseThreshold`, ...), and `destroy()`. COPC (Cloud
// Optimized Point Cloud) files stream in over HTTP range requests; load()
// resolves once the initial hierarchy is fetched and the camera has finished
// flying to the dataset (`autoFrame`, default true — see CopcDataSourceOptions
// for this and every other option, only a few of which are used below).
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { CopcDataSource } from 'copcesium';
import type { ColorMode, CopcDataSourceOptions } from 'copcesium';

Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN ?? '';

const viewer = new Cesium.Viewer('cesiumContainer');

interface SampleDataset {
  label: string;
  url: string;
  options: CopcDataSourceOptions;
}

// Freely streamable public COPC files (HTTP range requests, no auth). Sizes
// are the full file size (measured via HTTP HEAD), not what gets downloaded —
// copcesium only fetches the octree nodes needed for the current view. Autzen
// stays first as the project's default demo; the rest are sorted by size,
// ascending.
const SAMPLE_DATASETS: SampleDataset[] = [
  {
    // https://github.com/PDAL/data/tree/main/autzen — Oregon Lambert (feet),
    // so proj/projDef/geoidOffset are supplied explicitly instead of relying
    // on CRS auto-detection.
    label: 'Autzen Stadium — Eugene, Oregon, USA (~81 MB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
    options: {
      proj: 'EPSG:2992', // EPSG code of the point cloud's source CRS
      // proj4 definition string for that CRS (only needed if proj4 doesn't already know it)
      projDef:
        '+proj=lcc +lat_1=43 +lat_2=45.5 +lat_0=41.75 +lon_0=-120.5' +
        ' +x_0=399999.9999999999 +y_0=0 +datum=NAD83 +units=ft +no_defs',
      geoidOffset: -20, // meters, geoid (this file's vertical datum) minus WGS84 ellipsoid, at this site
    },
  },
  {
    label: 'Red Rocks (Large) — Colorado, USA (~13.2 MB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/redrocks.large.copc.laz',
    options: {},
  },
  {
    label: 'Kate (~71.9 MB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/kate.copc.laz',
    options: {},
  },
  {
    label: 'Niagara Region — Ontario, Canada (~140.3 MB)',
    url: 'https://canelevation-lidar-point-clouds.s3.ca-central-1.amazonaws.com/pointclouds_nuagespoints/NRCAN/Hamilton_Niagara_2021_2/ON_Niagara_20210525_NAD83CSRS_UTM17N_1km_E656_N4771_CLASS.copc.laz',
    options: {},
  },
  {
    label: 'Trestle Bridge — Fort Leonard Wood, Missouri, USA (~324.8 MB)',
    url: 'https://s3.amazonaws.com/grid-public-ept/20210421-FLW-Trestle-low-attitude.copc.laz',
    options: {},
  },
  {
    label: 'Millsite Reservoir — Utah, USA (~1.4 GB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz',
    options: {},
  },
  {
    label: 'SoFi Stadium — Inglewood, California, USA (~2.0 GB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/sofi.copc.laz',
    options: {},
  },
  {
    label: 'Iowa 3DEP (2019–2020) — Iowa, USA (~3.6 GB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/iowa-50m-3dep-2019-2020.copc.laz',
    options: {},
  },
];

const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const datasetSelect = document.getElementById('datasetSelect') as HTMLSelectElement;
const loadBtn = document.getElementById('loadBtn') as HTMLButtonElement;
const reloadBtn = document.getElementById('reloadBtn') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;
const errorEl = document.getElementById('error')!;
const pixelSizeSlider = document.getElementById('pixelSize') as HTMLInputElement;
const pixelSizeValue = document.getElementById('pixelSizeValue')!;
const sseThresholdSlider = document.getElementById('sseThreshold') as HTMLInputElement;
const sseThresholdValue = document.getElementById('sseThresholdValue')!;
const colorModeSelect = document.getElementById('colorMode') as HTMLSelectElement;
const classChecksEl = document.getElementById('classChecks')!;

// ASPRS codes the classification palette covers, plus 1 (Unclassified), which
// most of this sample's points carry.
const CLASSES: [number, string][] = [
  [1, 'Unclassified'],
  [2, 'Ground'],
  [3, 'Low Veg'],
  [4, 'Med Veg'],
  [5, 'High Veg'],
  [6, 'Building'],
  [9, 'Water'],
  [10, 'Rail'],
  [11, 'Road'],
];

let currentDs: CopcDataSource | null = null;

async function load(url: string, options: CopcDataSourceOptions = {}): Promise<void> {
  if (currentDs) {
    currentDs.destroy();
    currentDs = null;
  }

  errorEl.textContent = '';
  statusEl.textContent = 'Loading…';
  loadBtn.disabled = true;
  reloadBtn.disabled = true;

  try {
    currentDs = await CopcDataSource.load(url, viewer, {
      ...options,
      pixelSize: parseFloat(pixelSizeSlider.value),
      sseThreshold: parseFloat(sseThresholdSlider.value),
      colorMode: colorModeSelect.value as ColorMode,
      classificationFilter: readClassFilter(),
    });
    statusEl.textContent = 'Loaded';
  } catch (err) {
    statusEl.textContent = '';
    errorEl.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    loadBtn.disabled = false;
    reloadBtn.disabled = !currentDs;
  }
}

for (const [i, dataset] of SAMPLE_DATASETS.entries()) {
  const option = document.createElement('option');
  option.value = String(i);
  option.textContent = dataset.label;
  datasetSelect.append(option);
}

datasetSelect.addEventListener('change', () => {
  const dataset = SAMPLE_DATASETS[Number(datasetSelect.value)];
  urlInput.value = dataset.url;
  void load(dataset.url, dataset.options);
});

loadBtn.addEventListener('click', () => void load(urlInput.value.trim()));

// destroy() + load() the same URL again, to manually confirm no leaked
// Workers/primitives across repeated cycles.
reloadBtn.addEventListener('click', () => void load(urlInput.value.trim()));

pixelSizeValue.textContent = pixelSizeSlider.value;
pixelSizeSlider.addEventListener('input', () => {
  pixelSizeValue.textContent = pixelSizeSlider.value;
  if (currentDs) currentDs.pixelSize = parseFloat(pixelSizeSlider.value);
});

sseThresholdValue.textContent = sseThresholdSlider.value;
sseThresholdSlider.addEventListener('input', () => {
  sseThresholdValue.textContent = sseThresholdSlider.value;
  if (currentDs) currentDs.sseThreshold = parseFloat(sseThresholdSlider.value);
});

colorModeSelect.addEventListener('change', () => {
  if (currentDs) currentDs.colorMode = colorModeSelect.value as ColorMode;
});

// All boxes ticked means "no filter" rather than "these nine codes" — a file
// may carry codes this panel doesn't list, and they shouldn't vanish just
// because nothing was unticked.
function readClassFilter(): number[] | undefined {
  const boxes = [...classChecksEl.querySelectorAll<HTMLInputElement>('input')];
  if (boxes.every((box) => box.checked)) return undefined;
  return boxes.filter((box) => box.checked).map((box) => Number(box.value));
}

for (const [code, name] of CLASSES) {
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = String(code);
  box.checked = true;
  box.addEventListener('change', () => {
    if (currentDs) currentDs.classificationFilter = readClassFilter();
  });
  label.append(box, `${code} ${name}`);
  classChecksEl.append(label);
}

datasetSelect.value = '0';
urlInput.value = SAMPLE_DATASETS[0].url;
// CopcDataSource.load() flies the camera to the dataset itself (autoFrame,
// default true) — no manual camera positioning needed here.
void load(SAMPLE_DATASETS[0].url, SAMPLE_DATASETS[0].options);
