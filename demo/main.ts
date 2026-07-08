import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { CopcDataSource } from "../src/index";

Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN ?? "";

const viewer = new Cesium.Viewer("cesiumContainer");

console.log("CopcDataSource:", CopcDataSource);
