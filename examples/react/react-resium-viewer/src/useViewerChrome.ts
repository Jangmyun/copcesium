import { useEffect, useState } from 'react';
import * as Cesium from 'cesium';

export type Theme = 'dark' | 'light';
export type Terrain = 'world' | 'ellipsoid';
export type Imagery = 'satellite' | 'osm' | 'none';

export interface CameraStats {
  lon: number;
  lat: number;
  elevM: number;
}

// Everything here is plain Cesium viewer chrome — camera readout, FPS, zoom —
// with no dependency on copcesium's API, unlike useCopcDataSource.
export function useViewerChrome(viewer: Cesium.Viewer | undefined) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [camera, setCamera] = useState<CameraStats | null>(null);
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    if (!viewer) return;

    const updateCamera = () => {
      const cpos = viewer.camera.positionCartographic;
      if (!cpos) return;
      setCamera({
        lon: Cesium.Math.toDegrees(cpos.longitude),
        lat: Cesium.Math.toDegrees(cpos.latitude),
        elevM: cpos.height,
      });
    };
    updateCamera();
    viewer.camera.changed.addEventListener(updateCamera);
    viewer.camera.moveEnd.addEventListener(updateCamera);

    let frames = 0;
    let lastFpsTime = performance.now();
    const onPostRender = () => {
      frames++;
      const now = performance.now();
      if (now - lastFpsTime >= 1000) {
        setFps(frames);
        frames = 0;
        lastFpsTime = now;
      }
    };
    viewer.scene.postRender.addEventListener(onPostRender);

    return () => {
      viewer.camera.changed.removeEventListener(updateCamera);
      viewer.camera.moveEnd.removeEventListener(updateCamera);
      viewer.scene.postRender.removeEventListener(onPostRender);
    };
  }, [viewer]);

  function zoomHome() {
    viewer?.camera.flyHome();
  }
  function zoomIn() {
    if (!viewer) return;
    viewer.camera.zoomIn(viewer.camera.positionCartographic.height * 0.35);
  }
  function zoomOut() {
    if (!viewer) return;
    viewer.camera.zoomOut(viewer.camera.positionCartographic.height * 0.6);
  }

  return { theme, setTheme, camera, fps, zoomHome, zoomIn, zoomOut };
}
