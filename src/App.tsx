import React, { useEffect, useRef, useState } from "react";
import * as satellite from "satellite.js";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

// Set Cesium static assets base URL for dev
(window as any).CESIUM_BASE_URL = "/node_modules/cesium/Build/Cesium/";

export default function TLECesiumTracker() {
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const cesiumContainerRef = useRef<HTMLDivElement | null>(null);
  const [tle1, setTle1] = useState("1 25544U 98067A   24235.53307911  .00018417  00000+0  33452-3 0  9991");
  const [tle2, setTle2] = useState("2 25544  51.6443  40.1893 0005352  58.1370  58.2267 15.50206503447343");
  const [tracking, setTracking] = useState(false);
  const [speed, setSpeed] = useState(1);
  const satEntityRef = useRef<Cesium.Entity | null>(null);
  const pathEntityRef = useRef<Cesium.Entity | null>(null);
  const satrecRef = useRef<any>(null);
  const startTimeRef = useRef<Date | null>(null);

  useEffect(() => {
    if (!cesiumContainerRef.current) return;

    const viewer = new Cesium.Viewer(cesiumContainerRef.current, {
      timeline: true,
      animation: true,
      shouldAnimate: true,
      sceneModePicker: true,
      baseLayerPicker: true,
      infoBox: false,
      selectionIndicator: false,
    });

    viewer.scene.globe.enableLighting = true;

    viewerRef.current = viewer;

    // Add preUpdate event listener ONCE
    const scene = viewer.scene;
    const preUpdateHandler = () => {
      try {
        if (!satEntityRef.current) return;
        const position = satEntityRef.current.position.getValue(Cesium.JulianDate.now());
        if (!position) return;
        const camPos = viewer.camera.position;
        const dist = Cesium.Cartesian3.distance(camPos, position);
        let pixel = 12 * (1000000 / (dist + 1000000));
        pixel = Math.max(6, Math.min(20, pixel));
        if (satEntityRef.current.point) {
          satEntityRef.current.point.pixelSize = pixel;
        }
      } catch (e) {
        // Ignore errors
      }
    };
    scene.preUpdate.addEventListener(preUpdateHandler);

    return () => {
      scene.preUpdate.removeEventListener(preUpdateHandler);
      if (!viewer.isDestroyed()) viewer.destroy();
    };
  }, []);

  function sampleOrbit(satrec: any, nowDate: Date, sampleSeconds = 60, durationSeconds = 5400) {
    const positions = [];
    for (let dt = 0; dt <= durationSeconds; dt += sampleSeconds) {
      const t = new Date(nowDate.getTime() + dt * 1000);
      const pv = satellite.propagate(satrec, t);
      if (!pv.position) continue;
      const gmst = satellite.gstime(t);
      const geo = satellite.eciToGeodetic(pv.position, gmst);
      const lon = satellite.degreesLong(geo.longitude);
      const lat = satellite.degreesLat(geo.latitude);
      const h = geo.height;
      positions.push([lon, lat, h * 1000]);
    }
    return positions;
  }

  function computeOrbitalPeriodMinutes(satrec: any) {
    try {
      const radPerMin = satrec.no;
      const revsPerMin = radPerMin / (2 * Math.PI);
      const periodMin = 1 / revsPerMin;
      if (isFinite(periodMin) && periodMin > 0) return periodMin;
    } catch (e) {}
    return 90;
  }

  function startTracking() {
    if (!viewerRef.current) return;

    try {
      const satrec = satellite.twoline2satrec(tle1.trim(), tle2.trim());
      satrecRef.current = satrec;
    } catch (e: any) {
      alert("Invalid TLE lines: " + e.message);
      return;
    }

    const viewer = viewerRef.current;
    const now = new Date();
    startTimeRef.current = now;

    // Set Cesium clock to now and enable animation
    const startJulian = Cesium.JulianDate.fromDate(now);
    viewer.clock.currentTime = startJulian.clone();
    viewer.clock.shouldAnimate = true;
    viewer.clock.multiplier = speed;
    viewer.clock.clockRange = Cesium.ClockRange.UNBOUNDED;

    const periodMin = computeOrbitalPeriodMinutes(satrecRef.current);
    const durationSeconds = Math.max(600, Math.round(periodMin * 60));
    const sampleSeconds = Math.max(5, Math.round(durationSeconds / 240));

    const pathPositions = sampleOrbit(satrecRef.current, now, sampleSeconds, durationSeconds);
    const cesiumPositions = pathPositions.map(([lon, lat, h]) => Cesium.Cartesian3.fromDegrees(lon, lat, h));

    if (pathEntityRef.current) {
      viewer.entities.remove(pathEntityRef.current);
      pathEntityRef.current = null;
    }
    if (satEntityRef.current) {
      viewer.entities.remove(satEntityRef.current);
      satEntityRef.current = null;
    }

    pathEntityRef.current = viewer.entities.add({
      name: "sat-path",
      polyline: {
        positions: cesiumPositions,
        width: 2,
        clampToGround: false,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.2,
          color: Cesium.Color.YELLOW,
        }),
      },
    });

    // Use Cesium clock for animation, and convert ECI to ECEF for Cesium
    const positionProperty = new Cesium.CallbackProperty((time, result) => {
      try {
        if (!satrecRef.current || !viewer.clock) return null;
        const jsDate = Cesium.JulianDate.toDate(viewer.clock.currentTime);
        const pv = satellite.propagate(satrecRef.current, jsDate);
        if (!pv.position) return null;
        const gmst = satellite.gstime(jsDate);
        const ecef = satellite.eciToEcf(pv.position, gmst);
        return Cesium.Cartesian3.fromElements(
          ecef.x * 1000,
          ecef.y * 1000,
          ecef.z * 1000,
          result
        );
      } catch (e) {
        return null;
      }
    }, false);

    satEntityRef.current = viewer.entities.add({
      name: "satellite",
      position: positionProperty,
      point: {
        pixelSize: 12,
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.NONE,
      },
      label: {
        text: "SAT",
        font: "12px sans-serif",
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 2,
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        pixelOffset: new Cesium.Cartesian2(10, 0),
        showBackground: true,
        backgroundColor: Cesium.Color.fromAlpha(Cesium.Color.BLACK, 0.5),
      },
    });

    if (cesiumPositions.length) {
      try {
        const boundingSphere = Cesium.BoundingSphere.fromPoints(cesiumPositions);
        if (boundingSphere && Cesium.BoundingSphere.isBoundingSphere(boundingSphere)) {
          viewer.camera.flyTo({ destination: boundingSphere });
        }
      } catch (e) {}
    }

    setTracking(true);
  }

  function stopTracking() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (pathEntityRef.current) viewer.entities.remove(pathEntityRef.current);
    if (satEntityRef.current) viewer.entities.remove(satEntityRef.current);
    pathEntityRef.current = null;
    satEntityRef.current = null;
    satrecRef.current = null;
    setTracking(false);
  }

  // Update Cesium clock multiplier when speed changes
  useEffect(() => {
    if (viewerRef.current) {
      viewerRef.current.clock.multiplier = speed;
    }
  }, [speed]);

  return (
    <div className="w-full h-full min-h-screen flex flex-col">
      <div className="p-4 bg-slate-800 text-white flex gap-4 items-start">
        <div className="flex-1">
          <h2 className="text-xl font-semibold">TLE Satellite Tracker (Cesium + satellite.js)</h2>
          <p className="text-sm text-slate-300">Paste TLE lines and click <strong>Track</strong>. Shows live satellite marker + orbit path.</p>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
            <textarea value={tle1} onChange={(e) => setTle1(e.target.value)} className="w-full p-2 h-16 rounded bg-slate-700 text-white" />
            <textarea value={tle2} onChange={(e) => setTle2(e.target.value)} className="w-full p-2 h-16 rounded bg-slate-700 text-white" />
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={() => startTracking()} className="px-3 py-1 rounded bg-yellow-500 text-black">Track</button>
            <button onClick={() => stopTracking()} className="px-3 py-1 rounded bg-slate-600">Stop</button>
            <label className="flex items-center gap-2 ml-4">
              Speed
              <input type="range" min="0.1" max="10" step="0.1" value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))} />
              <span className="w-12 text-right">{speed.toFixed(1)}x</span>
            </label>
          </div>
        </div>
        <div className="w-48 text-sm">
          <h3 className="font-medium">Notes</h3>
          <ul className="text-slate-300 mt-2 list-disc list-inside">
            <li>Uses satellite.js for SGP4 propagation.</li>
            <li>Polyline shows predicted path for ~1 orbit (sampled).</li>
            <li>Point size auto-adjusts with camera distance for consistent visibility.</li>
          </ul>
        </div>
      </div>
      <div ref={cesiumContainerRef} style={{ flex: 1, minHeight: "500px" }} />
    </div>
  );
}
