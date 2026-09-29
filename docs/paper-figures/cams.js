// Grayscale camera shapes (webcam / box camera) as editable PPT shapes.
// Solids are projected orthographically and shaded per face (painter's order).
const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.title = "카메라 도형";
const K = "000000", G1 = "404040", WH = "FFFFFF", KO = "Malgun Gothic";

const hex = (g) => Math.max(0, Math.min(255, Math.round(g))).toString(16).padStart(2, "0").toUpperCase().repeat(3);

function scene(s, ox, oy, sc, { yaw = 155, pitch = -18, lw = 1 } = {}) {
  const ya = (yaw * Math.PI) / 180, pa = (pitch * Math.PI) / 180;
  const rot = ([x, y, z]) => {
    const x1 = x * Math.cos(ya) + z * Math.sin(ya), z1 = -x * Math.sin(ya) + z * Math.cos(ya);
    return [x1, y * Math.cos(pa) - z1 * Math.sin(pa), y * Math.sin(pa) + z1 * Math.cos(pa)];
  };
  const scr = (p) => { const r = rot(p); return [ox + sc * r[0], oy - sc * r[1]]; };
  const L = [-0.45, 0.7, -0.55], Ln = Math.hypot(...L);
  const lit = (n) => { const r = rot(n); return Math.max(0, (r[0] * L[0] + r[1] * L[1] + r[2] * L[2]) / Ln); };
  const facing = (n) => rot(n)[2] < -1e-6;

  function poly(pts, o = {}) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    s.addShape(pres.shapes.CUSTOM_GEOMETRY, {
      x: x0, y: y0, w: Math.max(...xs) - x0 || 0.01, h: Math.max(...ys) - y0 || 0.01,
      points: [...pts.map((p) => ({ x: p[0] - x0, y: p[1] - y0 })), { close: true }],
      fill: o.fill ? { color: o.fill } : { type: "none" },
      line: o.noLine ? { type: "none" } : { color: o.color || K, width: o.width || lw },
    });
  }
  function hull(pts) {
    const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return [...lo.slice(0, -1), ...up.slice(0, -1)];
  }
  const shade = (n, base, span) => hex(base + span * (0.3 + 0.7 * lit(n)));
  const parts = [];

  // convex polyhedron: vertices + faces (index lists); normals oriented outward automatically
  function solid(V, F, base = 60, span = 150, capFill = null) {
    const c = V.reduce((a, v) => [a[0] + v[0] / V.length, a[1] + v[1] / V.length, a[2] + v[2] / V.length], [0, 0, 0]);
    parts.push({ c, draw: () => F.forEach((f, fi) => {
      const P = f.map((i) => V[i]);
      let n = [0, 0, 0];
      P.forEach((a, i) => { const b = P[(i + 1) % P.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); });
      const fc = P.reduce((a, v) => [a[0] + v[0] / P.length, a[1] + v[1] / P.length, a[2] + v[2] / P.length], [0, 0, 0]);
      if ((fc[0] - c[0]) * n[0] + (fc[1] - c[1]) * n[1] + (fc[2] - c[2]) * n[2] < 0) n = n.map((v) => -v);
      if (!facing(n)) return;
      poly(P.map(scr), { fill: capFill && capFill[fi] ? capFill[fi] : shade(n, base, span) });
    }) });
    return c;
  }
  function box(x0, x1, y0, y1, z0, z1, base, span, bias = 0) {
    const V = []; for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) V.push([x, y, z]);
    solid(V, [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]], base, span);
    parts[parts.length - 1].bias = bias;
  }
  // cylinder along axis 'x' | 'y' | 'z'; (u,v) = centre in the other two coords
  function cyl(axis, u, v, r, a0, a1, base, span, { glass = false, bias = 0, N = 36 } = {}) {
    const pt = (t, a) => axis === "z" ? [u + r * Math.cos(t), v + r * Math.sin(t), a] : axis === "y" ? [u + r * Math.cos(t), a, v + r * Math.sin(t)] : [a, u + r * Math.cos(t), v + r * Math.sin(t)];
    const nr = (t) => axis === "z" ? [Math.cos(t), Math.sin(t), 0] : axis === "y" ? [Math.cos(t), 0, Math.sin(t)] : [0, Math.cos(t), Math.sin(t)];
    const ax = axis === "z" ? [0, 0, 1] : axis === "y" ? [0, 1, 0] : [1, 0, 0];
    const ring = (a, rr = r) => Array.from({ length: N }, (_, k) => { const t = (2 * Math.PI * k) / N; return axis === "z" ? [u + rr * Math.cos(t), v + rr * Math.sin(t), a] : axis === "y" ? [u + rr * Math.cos(t), a, v + rr * Math.sin(t)] : [a, u + rr * Math.cos(t), v + rr * Math.sin(t)]; });
    const cc = axis === "z" ? [u, v, (a0 + a1) / 2] : axis === "y" ? [u, (a0 + a1) / 2, v] : [(a0 + a1) / 2, u, v];
    parts.push({ c: cc, bias, draw: () => {
      for (let k = 0; k < N; k++) {
        const t0 = (2 * Math.PI * k) / N, t1 = (2 * Math.PI * (k + 1)) / N, n = nr((t0 + t1) / 2);
        if (!facing(n)) continue;
        const f = shade(n, base, span);
        poly([pt(t0, a0), pt(t1, a0), pt(t1, a1), pt(t0, a1)].map(scr), { fill: f, color: f, width: 0.5 });
      }
      poly(hull([...ring(a0), ...ring(a1)].map(scr)), {});
      [[a0, ax.map((x) => -x)], [a1, ax]].forEach(([a, n]) => {
        if (!facing(n)) return;
        poly(ring(a).map(scr), { fill: shade(n, base, span) });
        if (glass) {
          poly(ring(a, r * 0.8).map(scr), { fill: "1A1A1A" });
          poly(ring(a, r * 0.52).map(scr), { fill: "4A4A4A", noLine: true });
          poly(ring(a, r * 0.25).map(scr), { fill: "262626", noLine: true });
          const hl = Array.from({ length: 12 }, (_, k) => { const t = Math.PI * 0.55 + (k / 11) * Math.PI * 0.5; const q = axis === "z" ? [u + r * 0.64 * Math.cos(t), v + r * 0.64 * Math.sin(t), a] : pt(t, a); return scr(q); });
          poly(hl, { fill: "E0E0E0", noLine: true });
        }
      });
    } });
  }
  // sphere: silhouette is a circle; fake smooth shading with offset concentric discs toward the light
  function sphere(c, r, base, span, bias = 0) {
    parts.push({ c, bias, draw: () => {
      const [cx, cy] = scr(c), R = r * sc, N = 48;
      const circ = (x, y, rr) => Array.from({ length: N }, (_, k) => [x + rr * Math.cos((2 * Math.PI * k) / N), y + rr * Math.sin((2 * Math.PI * k) / N)]);
      const steps = 18, lx = -0.5, ly = -0.62;
      for (let i = 0; i < steps; i++) {
        const f = i / (steps - 1), rr = R * (1 - 0.82 * f);
        poly(circ(cx + lx * R * 0.42 * f, cy + ly * R * 0.42 * f, rr), { fill: hex(base + span * (0.25 + 0.75 * f)), noLine: true });
      }
      poly(circ(cx, cy, R), {});
    } });
  }
  function render() { parts.sort((a, b) => (rot(b.c)[2] + (b.bias || 0)) - (rot(a.c)[2] + (a.bias || 0))).forEach((p) => p.draw()); }
  return { box, cyl, sphere, solid, render, scr };
}

// ---------- camera models (local: X right, Y up, Z = optical axis toward the viewer side) ----------
function webcamClip(s, x, y, sc, view) { // monitor-top webcam with folding clip
  const S = scene(s, x, y, sc, view);
  const r = 0.3;
  S.cyl("x", 0, 0, r, -0.62, 0.62, 45, 150);
  S.sphere([-0.62, 0, 0], r, 45, 150);
  S.sphere([0.62, 0, 0], r, 45, 150);
  S.cyl("z", 0, 0, 0.19, 0.18, 0.345, 25, 120, { glass: true, bias: -0.2 });
  S.cyl("z", -0.46, 0.02, 0.035, 0.18, 0.3, 150, 90, { bias: -0.2, N: 16 });
  S.cyl("z", 0.46, 0.02, 0.035, 0.18, 0.3, 150, 90, { bias: -0.2, N: 16 });
  // hinge + clip (front plate, top bridge, rear leg)
  S.box(-0.2, 0.2, -0.42, -0.26, -0.12, 0.12, 50, 140, 0.3);
  S.box(-0.28, 0.28, -0.95, -0.42, 0.06, 0.14, 50, 140, 0.2);
  S.box(-0.28, 0.28, -0.5, -0.42, -0.62, 0.14, 50, 140, 0.25);
  S.box(-0.28, 0.28, -1.15, -0.5, -0.62, -0.54, 50, 140, 0.3);
  S.render();
}
function webcamBall(s, x, y, sc, view) { // ball webcam on a desk stand
  const S = scene(s, x, y, sc, view);
  S.cyl("y", 0, 0, 0.6, -1.05, -0.95, 50, 150, { bias: 0.4 });
  S.cyl("y", 0, 0, 0.08, -0.95, -0.4, 60, 140, { bias: 0.3 });
  S.box(-0.14, 0.14, -0.5, -0.36, -0.12, 0.12, 50, 140, 0.35);
  S.sphere([0, 0, 0], 0.5, 55, 160);
  S.cyl("z", 0, 0, 0.24, 0.32, 0.56, 25, 120, { glass: true, bias: -0.3 });
  S.render();
}
function boxCam(s, x, y, sc, view) { // box camera: cuboid body + frustum lens hood (3D version of the flat icon)
  const S = scene(s, x, y, sc, view);
  S.box(-0.42, 0.42, -0.32, 0.32, -1.1, 0, 55, 150);
  const b = 0.17, f = 0.32, z0 = 0, z1 = 0.45;
  S.solid([[-b, -b, z0], [b, -b, z0], [b, b, z0], [-b, b, z0], [-f, -f, z1], [f, -f, z1], [f, f, z1], [-f, f, z1]],
    [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], 45, 150, [null, "262626"]);
  S.cyl("z", 0, 0, 0.2, z1, z1 + 0.02, 25, 120, { glass: true, bias: -0.5 });
  S.render();
}
// flat 2D icons (like the reference image, left)
function flatCamcorder(s, x, y, sc) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x - 0.75 * sc, y: y - 0.4 * sc, w: 1.1 * sc, h: 0.8 * sc, rectRadius: 0.12 * sc, fill: { color: G1 }, line: { color: K, width: 1.25 } });
  s.addShape(pres.shapes.CUSTOM_GEOMETRY, { x: x + 0.35 * sc, y: y - 0.4 * sc, w: 0.45 * sc, h: 0.8 * sc,
    points: [{ x: 0, y: 0.22 * sc }, { x: 0.45 * sc, y: 0 }, { x: 0.45 * sc, y: 0.8 * sc }, { x: 0, y: 0.58 * sc }, { close: true }], fill: { color: G1 }, line: { color: K, width: 1.25 } });
}
function flatWebcam(s, x, y, sc) {
  const O = (cx, cy, r, fill) => s.addShape(pres.shapes.OVAL, { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: { color: fill }, line: { color: K, width: 1.25 } });
  s.addShape(pres.shapes.RECTANGLE, { x: x - 0.07 * sc, y: y + 0.45 * sc, w: 0.14 * sc, h: 0.35 * sc, fill: { color: G1 }, line: { color: K, width: 1.25 } });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x - 0.5 * sc, y: y + 0.78 * sc, w: 1.0 * sc, h: 0.16 * sc, rectRadius: 0.06 * sc, fill: { color: G1 }, line: { color: K, width: 1.25 } });
  O(x, y, 0.55 * sc, "595959");
  O(x, y, 0.3 * sc, "1A1A1A");
  O(x, y, 0.15 * sc, "4A4A4A");
  O(x - 0.09 * sc, y - 0.09 * sc, 0.05 * sc, "E0E0E0");
}
function flatWebcamBar(s, x, y, sc) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x - 0.9 * sc, y: y - 0.3 * sc, w: 1.8 * sc, h: 0.6 * sc, rectRadius: 0.3 * sc, fill: { color: "595959" }, line: { color: K, width: 1.25 } });
  const O = (cx, cy, r, fill) => s.addShape(pres.shapes.OVAL, { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: { color: fill }, line: { color: K, width: 1 } });
  O(x, y, 0.2 * sc, "1A1A1A"); O(x, y, 0.1 * sc, "4A4A4A"); O(x - 0.06 * sc, y - 0.06 * sc, 0.035 * sc, "E0E0E0");
  O(x - 0.5 * sc, y, 0.03 * sc, "BFBFBF"); O(x + 0.5 * sc, y, 0.03 * sc, "BFBFBF");
  s.addShape(pres.shapes.RECTANGLE, { x: x - 0.25 * sc, y: y + 0.3 * sc, w: 0.5 * sc, h: 0.22 * sc, fill: { color: G1 }, line: { color: K, width: 1.25 } });
}

const label = (s, t, x, y, w = 3.6) => s.addText(t, { x: x - w / 2, y, w, h: 0.35, margin: 0, isTextBox: true, fontFace: KO, fontSize: 13, color: K, align: "center", valign: "middle" });
const title = (s, t) => s.addText(t, { x: 0.6, y: 0.3, w: 12, h: 0.45, margin: 0, isTextBox: true, fontFace: KO, bold: true, fontSize: 20, color: K, valign: "middle" });

// Slide 1: overview
{
  const s = pres.addSlide(); s.background = { color: WH };
  title(s, "카메라 도형 (흑백 · 편집 가능한 도형)");
  webcamClip(s, 2.3, 3.1, 1.75, { yaw: 155, pitch: -15 });
  webcamBall(s, 6.65, 3.0, 1.6, { yaw: 150, pitch: -12 });
  boxCam(s, 10.9, 3.2, 1.6, { yaw: 140, pitch: -20 });
  label(s, "(a) 모니터 거치형 웹캠", 2.3, 5.4);
  label(s, "(b) 스탠드형 웹캠", 6.65, 5.4);
  label(s, "(c) 박스형 카메라", 10.9, 5.4);
}
// Slides 2-4: each model large, three viewing angles
const models = [
  ["(a) 모니터 거치형 웹캠", webcamClip, 1.7],
  ["(b) 스탠드형 웹캠", webcamBall, 1.6],
  ["(c) 박스형 카메라", boxCam, 1.6],
];
models.forEach(([name, fn, sc]) => {
  const s = pres.addSlide(); s.background = { color: WH };
  title(s, name);
  [["정면 사선", { yaw: 155, pitch: -15 }], ["측면", { yaw: 110, pitch: -12 }], ["후면 사선 (광축이 안쪽)", { yaw: 40, pitch: -22 }]].forEach(([vn, v], i) => {
    fn(s, 2.3 + i * 4.35, 3.0, sc, v);
    label(s, vn, 2.3 + i * 4.35, 5.6);
  });
});
// Slide 5: flat icons
{
  const s = pres.addSlide(); s.background = { color: WH };
  title(s, "2D 아이콘형 카메라");
  flatCamcorder(s, 2.4, 3.3, 1.6);
  flatWebcam(s, 6.65, 3.0, 1.6);
  flatWebcamBar(s, 10.9, 3.3, 1.5);
  label(s, "(d) 캠코더 아이콘", 2.4, 5.4);
  label(s, "(e) 스탠드형 웹캠 아이콘", 6.65, 5.4);
  label(s, "(f) 모니터 거치형 웹캠 아이콘", 10.9, 5.4);
}
pres.writeFile({ fileName: "camera_shapes.pptx" }).then(() => console.log("written"));
