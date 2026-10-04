/*
 * Copyright 2026 copcesium contributors. All Rights Reserved.
 * Author 2026 김선교 (seongyooo), 추인규 (Jangmyun)
 *
 * Licensed under the MIT License.
 * See the LICENSE file in the project root for details.
 * SPDX-License-Identifier: MIT
 */

/**
 * Local EPSG -> proj4 definition table.
 * Supports offline coordinate conversion without epsg.io network requests.
 */
export const EPSG_TABLE: Record<number, string> = {
  // ── Geographic CRS ──────────────────────────────────────────────────────────
  4326: '+proj=longlat +datum=WGS84 +no_defs',
  4269: '+proj=longlat +ellps=GRS80 +datum=NAD83 +no_defs',
  4617: '+proj=longlat +ellps=GRS80 +no_defs',
  4737: '+proj=longlat +ellps=GRS80 +no_defs',

  // ── Web Mercator ────────────────────────────────────────────────────────────
  3857: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',

  // ── Korean CRS ──────────────────────────────────────────────────────────────
  // Korea 2000 / Unified CS
  5179: '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs',
  // Korea 2000 / West Belt 2010
  5185: '+proj=tmerc +lat_0=38 +lon_0=125 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
  // Korea 2000 / Central Belt 2010
  5186: '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
  // Korea 2000 / East Belt 2010
  5187: '+proj=tmerc +lat_0=38 +lon_0=129 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
  // Korea 2000 / East Sea Belt 2010
  5188: '+proj=tmerc +lat_0=38 +lon_0=131 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs',
  // Korea 1985 / Central Belt (Bessel)
  5174: '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43',
  // Korea 1985 / East Belt (Bessel)
  5175: '+proj=tmerc +lat_0=38 +lon_0=129.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43',
  // Korea 1985 / West Belt (Bessel)
  5176: '+proj=tmerc +lat_0=38 +lon_0=125.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43',
  // Korea 1985 / East Sea Belt (Bessel)
  5177: '+proj=tmerc +lat_0=38 +lon_0=131.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43',

  // ── US State Plane NAD83 (units: us-ft) ─────────────────────────────────────
  // California
  2226: '+proj=lcc +lat_1=40.33333333333334 +lat_2=41.66666666666666 +lat_0=39.33333333333334 +lon_0=-122 +x_0=2000000.0001016 +y_0=500000.0001016001 +datum=NAD83 +units=us-ft +no_defs',
  2227: '+proj=lcc +lat_1=37.06666666666667 +lat_2=38.43333333333333 +lat_0=36.5 +lon_0=-120.5 +x_0=2000000.0001016 +y_0=500000.0001016001 +datum=NAD83 +units=us-ft +no_defs',
  2228: '+proj=lcc +lat_1=36 +lat_2=37.25 +lat_0=35.33333333333334 +lon_0=-119 +x_0=2000000.0001016 +y_0=500000.0001016001 +datum=NAD83 +units=us-ft +no_defs',
  2229: '+proj=lcc +lat_1=34.03333333333333 +lat_2=35.46666666666667 +lat_0=33.5 +lon_0=-118 +x_0=2000000.0001016 +y_0=500000.0001016001 +datum=NAD83 +units=us-ft +no_defs',
  2230: '+proj=lcc +lat_1=32.78333333333333 +lat_2=33.88333333333333 +lat_0=32.16666666666666 +lon_0=-116.25 +x_0=2000000.0001016 +y_0=500000.0001016001 +datum=NAD83 +units=us-ft +no_defs',
  // Oregon
  2992: '+proj=lcc +lat_1=43 +lat_2=45.5 +lat_0=41.75 +lon_0=-120.5 +x_0=399999.9999999999 +y_0=0 +datum=NAD83 +units=ft +no_defs',
  2993: '+proj=lcc +lat_1=42.33333333333334 +lat_2=44 +lat_0=41.66666666666666 +lon_0=-120.5 +x_0=1500000 +y_0=0 +datum=NAD83 +units=ft +no_defs',
  // Washington
  2285: '+proj=lcc +lat_1=47.5 +lat_2=48.73333333333333 +lat_0=47 +lon_0=-120.8333333333333 +x_0=500000.0001016001 +y_0=0 +datum=NAD83 +units=us-ft +no_defs',
  2286: '+proj=lcc +lat_1=45.83333333333334 +lat_2=47.33333333333334 +lat_0=45.33333333333334 +lon_0=-120.5 +x_0=500000.0001016001 +y_0=0 +datum=NAD83 +units=us-ft +no_defs',
  // Colorado
  2231: '+proj=lcc +lat_1=39.71666666666667 +lat_2=40.78333333333333 +lat_0=39.33333333333334 +lon_0=-105.5 +x_0=914401.8289 +y_0=304800.6096 +datum=NAD83 +units=us-ft +no_defs',
  2232: '+proj=lcc +lat_1=38.45 +lat_2=39.75 +lat_0=37.83333333333334 +lon_0=-105.5 +x_0=914401.8289 +y_0=304800.6096 +datum=NAD83 +units=us-ft +no_defs',
  2233: '+proj=lcc +lat_1=37.23333333333333 +lat_2=38.43333333333333 +lat_0=36.66666666666666 +lon_0=-105.5 +x_0=914401.8289 +y_0=304800.6096 +datum=NAD83 +units=us-ft +no_defs',
  // Texas
  2275: '+proj=lcc +lat_1=34.65 +lat_2=36.18333333333333 +lat_0=34 +lon_0=-101.5 +x_0=200000 +y_0=1000000 +datum=NAD83 +units=us-ft +no_defs',
  2276: '+proj=lcc +lat_1=32.13333333333333 +lat_2=33.96666666666667 +lat_0=31.66666666666667 +lon_0=-98.5 +x_0=600000 +y_0=2000000 +datum=NAD83 +units=us-ft +no_defs',
  2277: '+proj=lcc +lat_1=30.11666666666667 +lat_2=31.88333333333333 +lat_0=29.66666666666667 +lon_0=-100.3333333333333 +x_0=700000 +y_0=3000000 +datum=NAD83 +units=us-ft +no_defs',
  2278: '+proj=lcc +lat_1=28.38333333333333 +lat_2=30.28333333333333 +lat_0=27.83333333333333 +lon_0=-99 +x_0=600000 +y_0=4000000 +datum=NAD83 +units=us-ft +no_defs',
  2279: '+proj=lcc +lat_1=26.16666666666667 +lat_2=27.83333333333333 +lat_0=25.66666666666667 +lon_0=-98.5 +x_0=300000 +y_0=5000000 +datum=NAD83 +units=us-ft +no_defs',
  // Florida
  2236: '+proj=tmerc +lat_0=24.33333333333333 +lon_0=-81 +k=0.999941177 +x_0=200000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs',
  2237: '+proj=tmerc +lat_0=24.33333333333333 +lon_0=-82 +k=0.999941177 +x_0=200000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs',
  // New York
  2260: '+proj=tmerc +lat_0=38.83333333333334 +lon_0=-74.5 +k=0.9999 +x_0=150000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs',
  2261: '+proj=tmerc +lat_0=40 +lon_0=-76.58333333333333 +k=0.9999375 +x_0=250000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs',
  2262: '+proj=tmerc +lat_0=40 +lon_0=-78.58333333333333 +k=0.9999375 +x_0=350000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs',
  2263: '+proj=lcc +lat_1=40.66666666666666 +lat_2=41.03333333333333 +lat_0=40.16666666666666 +lon_0=-74 +x_0=300000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs',
  // Illinois
  3435: '+proj=tmerc +lat_0=36.66666666666666 +lon_0=-88.33333333333333 +k=0.9999749999999999 +x_0=300000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs',
  3436: '+proj=tmerc +lat_0=36.66666666666666 +lon_0=-90.16666666666667 +k=0.999941177 +x_0=700000 +y_0=0 +datum=NAD83 +units=us-ft +no_defs',

  // ── NAD83 UTM North (EPSG:26901–26923) ─────────────────────────────────────
  26901: '+proj=utm +zone=1 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26902: '+proj=utm +zone=2 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26903: '+proj=utm +zone=3 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26904: '+proj=utm +zone=4 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26905: '+proj=utm +zone=5 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26906: '+proj=utm +zone=6 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26907: '+proj=utm +zone=7 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26908: '+proj=utm +zone=8 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26909: '+proj=utm +zone=9 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26910: '+proj=utm +zone=10 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26911: '+proj=utm +zone=11 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26912: '+proj=utm +zone=12 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26913: '+proj=utm +zone=13 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26914: '+proj=utm +zone=14 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26915: '+proj=utm +zone=15 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26916: '+proj=utm +zone=16 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26917: '+proj=utm +zone=17 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26918: '+proj=utm +zone=18 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26919: '+proj=utm +zone=19 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26920: '+proj=utm +zone=20 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26921: '+proj=utm +zone=21 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26922: '+proj=utm +zone=22 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',
  26923: '+proj=utm +zone=23 +ellps=GRS80 +datum=NAD83 +units=m +no_defs',

  // ── US State Plane NAD83 (units: m) ─────────────────────────────────────────
  // Alaska
  26931: '+proj=tmerc +lat_0=57 +lon_0=-133 +k=0.9999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26932: '+proj=tmerc +lat_0=54 +lon_0=-142 +k=0.9999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26933: '+proj=tmerc +lat_0=54 +lon_0=-146 +k=0.9999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26934: '+proj=tmerc +lat_0=54 +lon_0=-150 +k=0.9999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26935: '+proj=tmerc +lat_0=54 +lon_0=-154 +k=0.9999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26936: '+proj=tmerc +lat_0=54 +lon_0=-158 +k=0.9999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26937: '+proj=tmerc +lat_0=54 +lon_0=-162 +k=0.9999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26938: '+proj=tmerc +lat_0=54 +lon_0=-166 +k=0.9999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26939: '+proj=tmerc +lat_0=54 +lon_0=-170 +k=0.9999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26940: '+proj=lcc +lat_1=53.83333333333334 +lat_2=51.83333333333334 +lat_0=51 +lon_0=-176 +x_0=1000000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Arizona
  26948: '+proj=tmerc +lat_0=31 +lon_0=-110.1666666666667 +k=0.9999 +x_0=213360 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26949: '+proj=tmerc +lat_0=31 +lon_0=-111.9166666666667 +k=0.9999 +x_0=213360 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26950: '+proj=tmerc +lat_0=31 +lon_0=-113.75 +k=0.999933333 +x_0=213360 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Arkansas
  26951: '+proj=lcc +lat_1=34.93333333333333 +lat_2=36.23333333333333 +lat_0=34.33333333333334 +lon_0=-92 +x_0=400000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26952: '+proj=lcc +lat_1=33.3 +lat_2=34.76666666666667 +lat_0=32.66666666666666 +lon_0=-92 +x_0=400000 +y_0=400000 +datum=NAD83 +units=m +no_defs',
  // Connecticut
  32118: '+proj=lcc +lat_1=41.86666666666667 +lat_2=41.2 +lat_0=40.83333333333334 +lon_0=-72.75 +x_0=304800.6096 +y_0=152400.3048 +datum=NAD83 +units=m +no_defs',
  // Delaware
  32112: '+proj=tmerc +lat_0=38 +lon_0=-75.41666666666667 +k=0.999995 +x_0=200000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Georgia
  26966: '+proj=tmerc +lat_0=30 +lon_0=-82.16666666666667 +k=0.9999 +x_0=200000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26967: '+proj=tmerc +lat_0=30 +lon_0=-84.16666666666667 +k=0.9999 +x_0=700000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Hawaii
  26961: '+proj=tmerc +lat_0=18.83333333333333 +lon_0=-155.5 +k=0.999967 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26962: '+proj=tmerc +lat_0=20.33333333333334 +lon_0=-156.6666666666667 +k=0.999967 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26963: '+proj=tmerc +lat_0=21.16666666666667 +lon_0=-158 +k=0.99999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26964: '+proj=tmerc +lat_0=21.83333333333333 +lon_0=-159.5 +k=0.99999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26965: '+proj=tmerc +lat_0=21.66666666666667 +lon_0=-160.1666666666667 +k=1 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Idaho
  26968: '+proj=tmerc +lat_0=41.66666666666666 +lon_0=-112.1666666666667 +k=0.9999473679 +x_0=200000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26969: '+proj=tmerc +lat_0=41.66666666666666 +lon_0=-114 +k=0.9999473679 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26970: '+proj=tmerc +lat_0=41.66666666666666 +lon_0=-115.75 +k=0.999933333 +x_0=800000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Indiana
  26971: '+proj=tmerc +lat_0=37.5 +lon_0=-85.66666666666667 +k=0.999966667 +x_0=100000 +y_0=250000 +datum=NAD83 +units=m +no_defs',
  26972: '+proj=tmerc +lat_0=37.5 +lon_0=-87.08333333333333 +k=0.999966667 +x_0=900000 +y_0=250000 +datum=NAD83 +units=m +no_defs',
  // Iowa
  26975: '+proj=lcc +lat_1=43.26666666666667 +lat_2=42.06666666666667 +lat_0=41.5 +lon_0=-93.5 +x_0=1500000 +y_0=1000000 +datum=NAD83 +units=m +no_defs',
  26976: '+proj=lcc +lat_1=41.78333333333333 +lat_2=40.61666666666667 +lat_0=40 +lon_0=-93.5 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Kansas
  26977: '+proj=lcc +lat_1=39.78333333333333 +lat_2=38.71666666666667 +lat_0=38.33333333333334 +lon_0=-98 +x_0=400000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26978: '+proj=lcc +lat_1=38.56666666666667 +lat_2=37.26666666666667 +lat_0=36.66666666666666 +lon_0=-98.5 +x_0=400000 +y_0=400000 +datum=NAD83 +units=m +no_defs',
  // Kentucky
  2205: '+proj=lcc +lat_1=37.96666666666667 +lat_2=38.96666666666667 +lat_0=37.5 +lon_0=-84.25 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26979: '+proj=lcc +lat_1=37.08333333333334 +lat_2=36.73333333333333 +lat_0=36.33333333333334 +lon_0=-85.75 +x_0=500000 +y_0=500000 +datum=NAD83 +units=m +no_defs',
  // Louisiana
  26980: '+proj=lcc +lat_1=32.66666666666666 +lat_2=31.16666666666667 +lat_0=30.5 +lon_0=-92.5 +x_0=1000000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26981: '+proj=lcc +lat_1=30.7 +lat_2=29.3 +lat_0=28.5 +lon_0=-91.33333333333333 +x_0=1000000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Maine
  26982: '+proj=tmerc +lat_0=43.66666666666666 +lon_0=-68.5 +k=0.9999 +x_0=300000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26983: '+proj=tmerc +lat_0=42.83333333333334 +lon_0=-70.16666666666667 +k=0.999966667 +x_0=900000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Maryland
  26985: '+proj=lcc +lat_1=39.45 +lat_2=38.3 +lat_0=37.66666666666666 +lon_0=-77 +x_0=400000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Massachusetts
  26986: '+proj=lcc +lat_1=42.68333333333333 +lat_2=41.71666666666667 +lat_0=41 +lon_0=-71.5 +x_0=200000 +y_0=750000 +datum=NAD83 +units=m +no_defs',
  26987: '+proj=lcc +lat_1=41.48333333333333 +lat_2=41.28333333333333 +lat_0=41 +lon_0=-70.5 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Michigan
  26988: '+proj=lcc +lat_1=45.7 +lat_2=44.18333333333333 +lat_0=43.31666666666667 +lon_0=-84.36666666666666 +x_0=6000000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26989: '+proj=lcc +lat_1=44.18333333333333 +lat_2=42.1 +lat_0=41.5 +lon_0=-84.36666666666666 +x_0=4000000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26990: '+proj=lcc +lat_1=43.66666666666666 +lat_2=42.1 +lat_0=41.5 +lon_0=-84.36666666666666 +x_0=4000000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Minnesota
  26991: '+proj=lcc +lat_1=48.63333333333333 +lat_2=47.03333333333333 +lat_0=46.5 +lon_0=-93.1 +x_0=800000 +y_0=100000 +datum=NAD83 +units=m +no_defs',
  26992: '+proj=lcc +lat_1=47.05 +lat_2=45.61666666666667 +lat_0=45 +lon_0=-94.25 +x_0=800000 +y_0=100000 +datum=NAD83 +units=m +no_defs',
  26993: '+proj=lcc +lat_1=45.21666666666667 +lat_2=43.78333333333333 +lat_0=43 +lon_0=-94 +x_0=800000 +y_0=100000 +datum=NAD83 +units=m +no_defs',
  // Mississippi
  26994: '+proj=tmerc +lat_0=29.5 +lon_0=-88.83333333333333 +k=0.99995 +x_0=300000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26995: '+proj=tmerc +lat_0=29.5 +lon_0=-90.33333333333333 +k=0.99995 +x_0=700000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Missouri
  26996: '+proj=tmerc +lat_0=35.83333333333334 +lon_0=-90.5 +k=0.999933333 +x_0=250000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26997: '+proj=tmerc +lat_0=35.83333333333334 +lon_0=-92.5 +k=0.999933333 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  26998: '+proj=tmerc +lat_0=36.16666666666666 +lon_0=-94.5 +k=0.999941177 +x_0=850000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Montana
  32100: '+proj=lcc +lat_1=49 +lat_2=45 +lat_0=44.25 +lon_0=-109.5 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Nebraska
  32104: '+proj=lcc +lat_1=43 +lat_2=40 +lat_0=39.83333333333334 +lon_0=-100 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Nevada
  32107: '+proj=tmerc +lat_0=34.75 +lon_0=-115.5833333333333 +k=0.9999 +x_0=200000 +y_0=8000000 +datum=NAD83 +units=m +no_defs',
  32108: '+proj=tmerc +lat_0=34.75 +lon_0=-116.6666666666667 +k=0.9999 +x_0=500000 +y_0=6000000 +datum=NAD83 +units=m +no_defs',
  32109: '+proj=tmerc +lat_0=34.75 +lon_0=-118.5833333333333 +k=0.9999 +x_0=800000 +y_0=4000000 +datum=NAD83 +units=m +no_defs',
  // New Hampshire
  32110: '+proj=tmerc +lat_0=42.5 +lon_0=-71.66666666666667 +k=0.999966667 +x_0=300000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // New Jersey
  32111: '+proj=tmerc +lat_0=38.83333333333334 +lon_0=-74.5 +k=0.9999 +x_0=150000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // New Mexico
  32113: '+proj=tmerc +lat_0=31 +lon_0=-106.25 +k=0.9999 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  32114: '+proj=tmerc +lat_0=31 +lon_0=-107.8333333333333 +k=0.999916667 +x_0=830000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // North Carolina
  32119: '+proj=lcc +lat_1=36.16666666666666 +lat_2=34.33333333333334 +lat_0=33.75 +lon_0=-79 +x_0=609601.22 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // North Dakota
  32120: '+proj=lcc +lat_1=48.73333333333333 +lat_2=47.43333333333333 +lat_0=47 +lon_0=-100.5 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  32121: '+proj=lcc +lat_1=47.48333333333333 +lat_2=46.18333333333333 +lat_0=45.66666666666666 +lon_0=-100.5 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Ohio
  32122: '+proj=lcc +lat_1=41.7 +lat_2=40.43333333333333 +lat_0=39.66666666666666 +lon_0=-82.5 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  32123: '+proj=lcc +lat_1=40.03333333333333 +lat_2=38.73333333333333 +lat_0=38 +lon_0=-82.5 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Oklahoma
  32124: '+proj=lcc +lat_1=36.76666666666667 +lat_2=35.56666666666667 +lat_0=35 +lon_0=-98 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  32125: '+proj=lcc +lat_1=35.23333333333333 +lat_2=33.93333333333333 +lat_0=33.33333333333334 +lon_0=-98 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Pennsylvania
  32128: '+proj=lcc +lat_1=41.95 +lat_2=40.88333333333333 +lat_0=40.16666666666666 +lon_0=-77.75 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  32129: '+proj=lcc +lat_1=40.96666666666667 +lat_2=39.93333333333333 +lat_0=39.33333333333334 +lon_0=-77.75 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Rhode Island
  32130: '+proj=tmerc +lat_0=41.08333333333334 +lon_0=-71.5 +k=0.99999375 +x_0=100000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // South Carolina
  32133: '+proj=lcc +lat_1=34.83333333333334 +lat_2=32.5 +lat_0=31.83333333333333 +lon_0=-81 +x_0=609600 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // South Dakota
  32134: '+proj=lcc +lat_1=45.68333333333333 +lat_2=44.41666666666666 +lat_0=43.83333333333334 +lon_0=-100 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  32135: '+proj=lcc +lat_1=44.4 +lat_2=42.83333333333334 +lat_0=42.33333333333334 +lon_0=-100.3333333333333 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Tennessee
  32136: '+proj=lcc +lat_1=36.41666666666666 +lat_2=35.25 +lat_0=34.33333333333334 +lon_0=-86 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Utah
  32137: '+proj=lcc +lat_1=41.78333333333333 +lat_2=40.71666666666667 +lat_0=40.33333333333334 +lon_0=-111.5 +x_0=500000 +y_0=1000000 +datum=NAD83 +units=m +no_defs',
  32138: '+proj=lcc +lat_1=40.65 +lat_2=39.01666666666667 +lat_0=38.33333333333334 +lon_0=-111.5 +x_0=500000 +y_0=2000000 +datum=NAD83 +units=m +no_defs',
  32139: '+proj=lcc +lat_1=38.35 +lat_2=37.21666666666667 +lat_0=36.66666666666666 +lon_0=-111.5 +x_0=500000 +y_0=3000000 +datum=NAD83 +units=m +no_defs',
  // Vermont
  32145: '+proj=tmerc +lat_0=42.5 +lon_0=-72.5 +k=0.999964286 +x_0=500000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Virginia
  32146: '+proj=lcc +lat_1=39.2 +lat_2=38.03333333333333 +lat_0=37.66666666666666 +lon_0=-78.5 +x_0=3500000 +y_0=2000000 +datum=NAD83 +units=m +no_defs',
  32147: '+proj=lcc +lat_1=37.96666666666667 +lat_2=36.76666666666667 +lat_0=36.33333333333334 +lon_0=-78.5 +x_0=3500000 +y_0=1000000 +datum=NAD83 +units=m +no_defs',
  // West Virginia
  32150: '+proj=lcc +lat_1=40.25 +lat_2=39 +lat_0=38.5 +lon_0=-79.5 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  32151: '+proj=lcc +lat_1=38.88333333333333 +lat_2=37.48333333333333 +lat_0=37 +lon_0=-81 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Wisconsin
  32153: '+proj=lcc +lat_1=46.76666666666667 +lat_2=45.56666666666667 +lat_0=45.16666666666666 +lon_0=-90 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  32154: '+proj=lcc +lat_1=45.5 +lat_2=44.25 +lat_0=43.83333333333334 +lon_0=-90 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  32155: '+proj=lcc +lat_1=44.06666666666667 +lat_2=42.73333333333333 +lat_0=42 +lon_0=-90 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  // Wyoming
  32158: '+proj=tmerc +lat_0=40.5 +lon_0=-105.1666666666667 +k=0.9999375 +x_0=200000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  32159: '+proj=tmerc +lat_0=40.5 +lon_0=-107.3333333333333 +k=0.9999375 +x_0=400000 +y_0=100000 +datum=NAD83 +units=m +no_defs',
  32160: '+proj=tmerc +lat_0=40.5 +lon_0=-108.75 +k=0.9999375 +x_0=600000 +y_0=0 +datum=NAD83 +units=m +no_defs',
  32161: '+proj=tmerc +lat_0=40.5 +lon_0=-110.0833333333333 +k=0.9999375 +x_0=800000 +y_0=100000 +datum=NAD83 +units=m +no_defs',

  // ── European CRS ────────────────────────────────────────────────────────────
  // British National Grid (OSGB36)
  27700: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +datum=OSGB36 +units=m +no_defs',
  // Netherlands RD New
  28992: '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38720621111111 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs',
  // Belgium Lambert 2008
  3812: '+proj=lcc +lat_1=49.83333333333334 +lat_2=51.16666666666666 +lat_0=50.797815 +lon_0=4.359215833333333 +x_0=649328 +y_0=665262 +ellps=GRS80 +units=m +no_defs',
  // Switzerland LV95
  2056: '+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs',
  // France Lambert-93
  2154: '+proj=lcc +lat_1=44 +lat_2=49 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  // Germany Gauss-Krüger (Potsdam)
  31466: '+proj=tmerc +lat_0=0 +lon_0=6 +k=1 +x_0=2500000 +y_0=0 +ellps=bessel +datum=potsdam +units=m +no_defs',
  31467: '+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=3500000 +y_0=0 +ellps=bessel +datum=potsdam +units=m +no_defs',
  31468: '+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 +ellps=bessel +datum=potsdam +units=m +no_defs',
  31469: '+proj=tmerc +lat_0=0 +lon_0=15 +k=1 +x_0=5500000 +y_0=0 +ellps=bessel +datum=potsdam +units=m +no_defs',
  // Austria MGI Gauss-Krüger
  31254: '+proj=tmerc +lat_0=0 +lon_0=10.33333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel +datum=hermannskogel +units=m +no_defs',
  31255: '+proj=tmerc +lat_0=0 +lon_0=13.33333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel +datum=hermannskogel +units=m +no_defs',
  31256: '+proj=tmerc +lat_0=0 +lon_0=16.33333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel +datum=hermannskogel +units=m +no_defs',
  // Sweden SWEREF99 TM
  3006: '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  // Finland ETRS-TM35FIN
  3067: '+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  // Portugal / TM06
  3763: '+proj=tmerc +lat_0=39.66825833333333 +lon_0=-8.133108333333334 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  // Spain / ETRS89 UTM zone 30N
  25830: '+proj=utm +zone=30 +ellps=GRS80 +units=m +no_defs',

  // ── Japanese CRS ────────────────────────────────────────────────────────────
  // JGD2000 (EPSG:4612) - geographic
  4612: '+proj=longlat +ellps=GRS80 +no_defs',
  // JGD2011 (EPSG:6668) - geographic
  6668: '+proj=longlat +ellps=GRS80 +no_defs',
  // JGD2011 plane rectangular CRS I~XIX (6669-6687)
  6669: '+proj=tmerc +lat_0=33 +lon_0=129.5 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6670: '+proj=tmerc +lat_0=33 +lon_0=131 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6671: '+proj=tmerc +lat_0=36 +lon_0=132.1666666666667 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6672: '+proj=tmerc +lat_0=33 +lon_0=133.5 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6673: '+proj=tmerc +lat_0=36 +lon_0=134.3333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6674: '+proj=tmerc +lat_0=36 +lon_0=136 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6675: '+proj=tmerc +lat_0=36 +lon_0=137.1666666666667 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6676: '+proj=tmerc +lat_0=36 +lon_0=138.5 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6677: '+proj=tmerc +lat_0=36 +lon_0=139.8333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6678: '+proj=tmerc +lat_0=40 +lon_0=140.8333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6679: '+proj=tmerc +lat_0=44 +lon_0=140.25 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6680: '+proj=tmerc +lat_0=44 +lon_0=142.25 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6681: '+proj=tmerc +lat_0=44 +lon_0=144.25 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6682: '+proj=tmerc +lat_0=26 +lon_0=142 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6683: '+proj=tmerc +lat_0=26 +lon_0=127.5 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6684: '+proj=tmerc +lat_0=26 +lon_0=124 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6685: '+proj=tmerc +lat_0=26 +lon_0=131 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6686: '+proj=tmerc +lat_0=20 +lon_0=136 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  6687: '+proj=tmerc +lat_0=26 +lon_0=154 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
  // JGD2011 UTM (6688–6696, zone 51–59N)
  6688: '+proj=utm +zone=51 +ellps=GRS80 +units=m +no_defs',
  6689: '+proj=utm +zone=52 +ellps=GRS80 +units=m +no_defs',
  6690: '+proj=utm +zone=53 +ellps=GRS80 +units=m +no_defs',
  6691: '+proj=utm +zone=54 +ellps=GRS80 +units=m +no_defs',
  6692: '+proj=utm +zone=55 +ellps=GRS80 +units=m +no_defs',
  6693: '+proj=utm +zone=56 +ellps=GRS80 +units=m +no_defs',
  6694: '+proj=utm +zone=57 +ellps=GRS80 +units=m +no_defs',
  6695: '+proj=utm +zone=58 +ellps=GRS80 +units=m +no_defs',
  6696: '+proj=utm +zone=59 +ellps=GRS80 +units=m +no_defs',

  // ── Australian CRS ──────────────────────────────────────────────────────────
  // GDA94 geographic
  4283: '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',
  // GDA94 / MGA zone 48–58 (28348–28358)
  28348: '+proj=utm +zone=48 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  28349: '+proj=utm +zone=49 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  28350: '+proj=utm +zone=50 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  28351: '+proj=utm +zone=51 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  28352: '+proj=utm +zone=52 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  28353: '+proj=utm +zone=53 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  28354: '+proj=utm +zone=54 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  28355: '+proj=utm +zone=55 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  28356: '+proj=utm +zone=56 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  28357: '+proj=utm +zone=57 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  28358: '+proj=utm +zone=58 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  // GDA2020 geographic
  7844: '+proj=longlat +ellps=GRS80 +no_defs',
  // GDA2020 / MGA zone 49–58 (7849–7858)
  7849: '+proj=utm +zone=49 +south +ellps=GRS80 +units=m +no_defs',
  7850: '+proj=utm +zone=50 +south +ellps=GRS80 +units=m +no_defs',
  7851: '+proj=utm +zone=51 +south +ellps=GRS80 +units=m +no_defs',
  7852: '+proj=utm +zone=52 +south +ellps=GRS80 +units=m +no_defs',
  7853: '+proj=utm +zone=53 +south +ellps=GRS80 +units=m +no_defs',
  7854: '+proj=utm +zone=54 +south +ellps=GRS80 +units=m +no_defs',
  7855: '+proj=utm +zone=55 +south +ellps=GRS80 +units=m +no_defs',
  7856: '+proj=utm +zone=56 +south +ellps=GRS80 +units=m +no_defs',
  7857: '+proj=utm +zone=57 +south +ellps=GRS80 +units=m +no_defs',
  7858: '+proj=utm +zone=58 +south +ellps=GRS80 +units=m +no_defs',
};

// WGS84 UTM North (EPSG:32601–32660)
for (let z = 1; z <= 60; z++) {
  EPSG_TABLE[32600 + z] = `+proj=utm +zone=${z} +datum=WGS84 +units=m +no_defs`;
}
// WGS84 UTM South (EPSG:32701–32760)
for (let z = 1; z <= 60; z++) {
  EPSG_TABLE[32700 + z] = `+proj=utm +zone=${z} +south +datum=WGS84 +units=m +no_defs`;
}
// ETRS89 UTM North (EPSG:25828-25838, European zones 28-38)
for (let z = 28; z <= 38; z++) {
  EPSG_TABLE[25800 + z] = `+proj=utm +zone=${z} +ellps=GRS80 +units=m +no_defs`;
}
// NAD83 UTM North (EPSG:26901-26923, North America coverage zones only)
for (let z = 1; z <= 23; z++) {
  if (!EPSG_TABLE[26900 + z]) {
    EPSG_TABLE[26900 + z] = `+proj=utm +zone=${z} +ellps=GRS80 +datum=NAD83 +units=m +no_defs`;
  }
}
