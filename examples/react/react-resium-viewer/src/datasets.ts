import type { CopcDataSourceOptions } from 'copcesium';

export interface SampleDataset {
  label: string;
  url: string;
  options: CopcDataSourceOptions;
}

// Freely streamable public COPC files (HTTP range requests, no auth). Sizes
// are the full file size (measured via HTTP HEAD), not what gets downloaded —
// copcesium only fetches the octree nodes needed for the current view. Autzen
// stays first as the project's default demo; the rest are sorted by size,
// ascending. A curated subset of examples/basic-viewer/main.ts's fuller
// SAMPLE_DATASETS list.
export const SAMPLE_DATASETS: SampleDataset[] = [
  {
    // https://github.com/PDAL/data/tree/main/autzen — Oregon Lambert (feet),
    // so proj/projDef/geoidOffset are supplied explicitly instead of relying
    // on CRS auto-detection.
    label: 'Autzen Stadium — Eugene, Oregon, USA (~81 MB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
    options: {
      proj: 'EPSG:2992',
      projDef:
        '+proj=lcc +lat_1=43 +lat_2=45.5 +lat_0=41.75 +lon_0=-120.5' +
        ' +x_0=399999.9999999999 +y_0=0 +datum=NAD83 +units=ft +no_defs',
      geoidOffset: -20,
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

// ASPRS codes the classification palette covers, plus 1 (Unclassified), which
// most of this sample's points carry.
export const CLASSES: [code: number, name: string][] = [
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

/** Swatch color per `CLASSES` code, purely a filter-list affordance — not tied to `colorMode: 'classification'`'s own palette. */
export const CLASS_COLORS: Record<number, string> = {
  1: '#909090',
  2: '#8d6e4f',
  3: '#78c86e',
  4: '#4caf6a',
  5: '#2d8a4e',
  6: '#d98b3a',
  9: '#3a86c9',
  10: '#a0522d',
  11: '#c8b400',
};
