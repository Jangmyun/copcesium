import { useMemo, useState } from 'react';
import * as Cesium from 'cesium';
import { ImageryLayer, Viewer } from 'resium';
import ViewerContent from './ViewerContent';
import type { Imagery, Terrain } from './useViewerChrome';
import './App.css';

Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN ?? '';

export default function App() {
  // Defaults need no Cesium Ion token — `VITE_CESIUM_TOKEN` is optional (see
  // .env.example). World Terrain / Satellite imagery are opt-in upgrades a
  // token unlocks from the Global tab, not what loads out of the box.
  const [terrain, setTerrain] = useState<Terrain>('ellipsoid');
  const [imagery, setImagery] = useState<Imagery>('osm');

  // `Cesium.createWorldTerrainAsync()` (Promise) and `EllipsoidTerrainProvider`
  // (sync) both satisfy resium's `terrainProvider` prop, which — unlike the
  // readonly `terrain` prop — reactively re-applies to the viewer on change.
  // World Terrain's promise is caught so a missing/invalid Ion token falls
  // back to the ellipsoid instead of leaving `terrainProvider` on a rejected
  // promise resium never recovers from.
  const terrainProvider = useMemo(
    () =>
      terrain === 'world'
        ? Cesium.createWorldTerrainAsync().catch(() => new Cesium.EllipsoidTerrainProvider())
        : new Cesium.EllipsoidTerrainProvider(),
    [terrain],
  );

  // Same reasoning as terrainProvider above: fall back instead of leaving an
  // unhandled rejection when Ion Satellite imagery is picked without a token.
  const satelliteImageryProvider = useMemo(
    () =>
      Cesium.IonImageryProvider.fromAssetId(2).catch(
        () => new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
      ),
    [],
  );

  return (
    <Viewer
      full
      baseLayer={false}
      terrainProvider={terrainProvider}
      requestRenderMode
      baseLayerPicker={false}
      sceneModePicker={false}
      animation={false}
      timeline={false}
      geocoder={false}
      homeButton={false}
      navigationHelpButton={false}
      fullscreenButton={false}
    >
      {/* `imageryProvider` isn't reactive on its own (resium treats it as a
          readonly Cesium constructor prop) — keying by selection forces a
          clean remount instead of a stale layer lingering underneath. */}
      {imagery === 'satellite' && (
        <ImageryLayer key="satellite" imageryProvider={satelliteImageryProvider} />
      )}
      {imagery === 'osm' && (
        <ImageryLayer
          key="osm"
          imageryProvider={
            new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
          }
        />
      )}
      <ViewerContent
        terrain={terrain}
        onTerrainChange={setTerrain}
        imagery={imagery}
        onImageryChange={setImagery}
      />
    </Viewer>
  );
}
