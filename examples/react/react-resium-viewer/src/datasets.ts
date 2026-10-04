/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 추인규 (Jangmyun), 김선교 (seongyooo)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

import type { CopcDataSourceOptions } from 'copcesium';

export interface SampleDataset {
  label: string;
  url: string;
  options: CopcDataSourceOptions;
  // One-line attribution shown in the Info tab. Full writeup with
  // verification method: examples/DATA_SOURCES.md.
  credit: string;
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
    credit: 'Watershed Sciences, Inc. (2010), Eugene, OR — PDAL/data, CC-BY-4.0',
  },
  {
    label: 'Red Rocks (Large) — Colorado, USA (~13.2 MB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/redrocks.large.copc.laz',
    options: {},
    credit: 'Red Rocks Amphitheatre, Morrison, CO — original capture source unconfirmed',
  },
  {
    label: 'Kate (~71.9 MB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/kate.copc.laz',
    options: {},
    credit: 'VT/QC border area — original capture source unconfirmed',
  },
  {
    label: 'Niagara Region — Ontario, Canada (~140.3 MB)',
    url: 'https://canelevation-lidar-point-clouds.s3.ca-central-1.amazonaws.com/pointclouds_nuagespoints/NRCAN/Hamilton_Niagara_2021_2/ON_Niagara_20210525_NAD83CSRS_UTM17N_1km_E656_N4771_CLASS.copc.laz',
    options: {},
    credit: 'NRCan CanElevation Series — Hamilton–Niagara 2021 (Open Government Licence)',
  },
  {
    label: 'Trestle Bridge — Fort Leonard Wood, Missouri, USA (~324.8 MB)',
    url: 'https://s3.amazonaws.com/grid-public-ept/20210421-FLW-Trestle-low-attitude.copc.laz',
    options: {},
    credit: 'NGA / US Army TPO-GEO, Fort Leonard Wood, MO (2021-04)',
  },
  {
    label: 'Millsite Reservoir — Utah, USA (~1.4 GB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz',
    options: {},
    credit: 'USGS 3DEP — Millsite Reservoir, UT (2017)',
  },
  {
    label: 'SoFi Stadium — Inglewood, California, USA (~2.0 GB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/sofi.copc.laz',
    options: {},
    credit: 'SoFi Stadium, Inglewood, CA — original capture source unconfirmed',
  },
  {
    label: 'Iowa 3DEP (2019–2020) — Iowa, USA (~3.6 GB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/iowa-50m-3dep-2019-2020.copc.laz',
    options: {},
    credit: 'USGS 3DEP — Eastern Iowa (2019–2020), USDA-NRCS / Iowa DALS',
  },

  {
    label: 'New York City — New York, USA (~26.5 GB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/nyc.copc.laz',
    options: {},
    credit: 'USGS CMGP LiDAR: Post Sandy, NYC (2013–2014) — flown by Woolpert for NGA',
  },
  {
    label: 'Montréal — Québec, Canada (~51.9 GB)',
    url: 'https://s3.amazonaws.com/hobu-lidar/montreal-2015.copc.laz',
    options: {},
    credit: 'Ville de Montréal — LiDAR aérien 2015, XEOS Imaging',
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
