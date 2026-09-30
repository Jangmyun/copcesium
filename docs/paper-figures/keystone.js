// Why the common plane is needed:
//  (a) tilted video wall -> the camera image shows the screens as trapezoids (keystone distortion)
//  (b) fit a common plane, bring every device onto it and express it in plane coordinates (u, v)
//      -> the wall is recovered as seen from the front (true rectangles, sizes and spacing)
// Camera convention follows the reference figure: x_c right, y_c up, z_c optical axis.
const L = require("./lib3d.js");
const { pres, T, Tc, line, arrow, poly, dot, makeView, cameraModel, add, sub, mul, dotp, cross, norm, K, G1, G2, G3, G4, G5, WH } = L;

const RED = "EE0000", GREEN = "00B800", BLUE = "0000EE";
const d2r = Math.PI / 180;
const rotY = (v, a) => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
const rotX = (v, a) => [v[0], v[1] * Math.cos(a) - v[2] * Math.sin(a), v[1] * Math.sin(a) + v[2] * Math.cos(a)];
const ex = [1, 0, 0], ey = [0, 1, 0], ez = [0, 0, 1];

// ---------------- true wall (plane) and devices ----------------
const P0 = [0.9, 0.2, 7.2];
const g = norm(rotX(rotY(ez, -30 * d2r), -10 * d2r));          // wall normal (away from camera), strongly tilted
const hvec = sub(ex, mul(g, dotp(ex, g)));
const ru = norm(hvec), rv = cross(g, ru);
const DEVS = [
  { id: 1, c: [-2.55, 0.75], w: 1.25, h: 2.2, th: 3, err: 0.28, tilt: [6, -4] },
  { id: 2, c: [-0.3, 0.95], w: 2.4, h: 1.5, th: -2, err: -0.22, tilt: [-5, 5] },
  { id: 3, c: [2.45, 0.7], w: 1.2, h: 2.1, th: 5, err: 0.2, tilt: [4, 6] },
  { id: 4, c: [-0.95, -1.4], w: 2.0, h: 1.2, th: 4, err: -0.18, tilt: [-6, -3] },
  { id: 5, c: [1.95, -1.3], w: 1.0, h: 1.7, th: -6, err: 0.24, tilt: [5, -5] },
];
DEVS.forEach((d) => {
  const t = d.th * d2r;
  const xd = add(mul(ru, Math.cos(t)), mul(rv, Math.sin(t))), yd = add(mul(ru, -Math.sin(t)), mul(rv, Math.cos(t)));
  const o = add(P0, add(mul(ru, d.c[0]), mul(rv, d.c[1])));
  const Q = (xa, ya, oo = o, X = xd, Y = yd) => add(oo, add(mul(X, xa), mul(Y, ya)));
  const sgn = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
  d.onPlane = sgn.map(([a, b]) => Q((a * d.w) / 2, (b * d.h) / 2));
  // estimated pose: offset along the normal + small tilt (independent marker estimation error)
  const oe = add(o, mul(g, d.err));
  const Xe = norm(add(xd, mul(g, Math.tan(d.tilt[0] * d2r)))), Ye = norm(add(yd, mul(g, Math.tan(d.tilt[1] * d2r))));
  d.est = sgn.map(([a, b]) => Q((a * d.w) / 2, (b * d.h) / 2, oe, Xe, Ye));
  d.estC = oe;
});
const allEst = DEVS.flatMap((d) => d.est);
const cpt = allEst.reduce((a, p) => add(a, mul(p, 1 / allEst.length)), [0, 0, 0]);
const uvOf = (p) => [dotp(sub(p, cpt), ru), dotp(sub(p, cpt), rv)];
const snap = (p) => sub(p, mul(g, dotp(sub(p, cpt), g)));     // bring a vertex onto the common plane
const Us = allEst.map((p) => uvOf(p)[0]), Vs = allEst.map((p) => uvOf(p)[1]);
const pl = { u0: Math.min(...Us) - 0.45, u1: Math.max(...Us) + 0.45, v0: Math.min(...Vs) - 0.45, v1: Math.max(...Vs) + 0.45 };
const onC = (u, v) => add(cpt, add(mul(ru, u), mul(rv, v)));
const plCorners = [[pl.u0, pl.v1], [pl.u1, pl.v1], [pl.u1, pl.v0], [pl.u0, pl.v0]].map(([u, v]) => onC(u, v));

// ---------------- 3D view (rear 3/4 with mild perspective), fitted to the left panel ----------------
const CAM = 1.2;
const view = makeView(46, -14);
const DPER = 24, zRef = view(cpt)[2];
const persp = (p) => { const r = view(p), k = DPER / (DPER + r[2] - zRef); return [r[0] * k, r[1] * k]; };
const body = []; for (const x of [-0.42, 0.42]) for (const y of [-0.32, 0.32]) for (const z of [-1.57, 0]) body.push([x * CAM, y * CAM, z * CAM]);
const S = (() => {
  const keys = [...body, [1.6, 0, 0], [0, 1.4, 0], ...plCorners, ...allEst, ...[[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => add(cpt, add(mul(ex, a * 3.6), mul(ey, b * 2.5))))];
  const raw = keys.map(persp), xs = raw.map((r) => r[0]), ys = raw.map((r) => r[1]);
  const box = { x: 0.3, y: 0.85, w: 6.7, h: 5.6 };
  const sc = Math.min(box.w / (Math.max(...xs) - Math.min(...xs)), box.h / (Math.max(...ys) - Math.min(...ys)));
  const ox = box.x + (box.w - sc * (Math.max(...xs) - Math.min(...xs))) / 2 - sc * Math.min(...xs);
  const oy = box.y + (box.h - sc * (Math.max(...ys) - Math.min(...ys))) / 2 + sc * Math.max(...ys);
  return (p) => { const r = persp(p); return [ox + sc * r[0], oy - sc * r[1]]; };
})();

// ---------------- helpers ----------------
const cent = (pts) => pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
function num(s, p, n, r = 0.14) {
  s.addShape(pres.shapes.OVAL, { x: p[0] - r, y: p[1] - r, w: 2 * r, h: 2 * r, fill: { color: WH }, line: { color: K, width: 0.75 } });
  s.addText(String(n), { x: p[0] - r, y: p[1] - r, w: 2 * r, h: 2 * r, margin: 0, isTextBox: true, fontFace: "Arial", bold: true, fontSize: 10, align: "center", valign: "middle" });
}
function device(s, pts, id, o = {}) {
  poly(s, pts, { fill: o.fill || WH, color: o.color || K, width: o.width || 1.25, dash: o.dash });
  if (o.dots !== false) pts.forEach((q) => dot(s, q, 0.035, G1));
  if (id) num(s, cent(pts), id);
}
function drawCamera(s) {
  const Oc = S([0, 0, 0]);
  cameraModel(s, Oc, 1, view, (p) => S(mul(p, CAM)));
  [[ex, 1.6, RED, "x_{\\r{c}}", [0.12, 0.26]], [ey, 1.4, GREEN, "y_{\\r{c}}", [-0.28, 0]], [ez, 1.8, BLUE, "z_{\\r{c}}", [0.12, -0.25]]].forEach(([v, len, col, name, o]) => {
    const b = S(mul(v, len));
    arrow(s, Oc, b, { color: col, width: 2.75 });
    Tc(s, name, b[0] + o[0], b[1] + o[1], 0.45, 0.3, { size: 16 });
  });
  dot(s, Oc, 0.045, WH);
  return Oc;
}
function head(s, t, x, y, w) { T(s, [{ s: t, size: 14, bold: true }], x, y, w, 0.36, { align: "left" }); }
function eqBox(s, lines, x, y, w, h) {
  s.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: { color: G5 }, line: { color: G3, width: 0.75 } });
  T(s, lines, x + 0.18, y + 0.12, w - 0.36, h - 0.24, { align: "left", valign: "middle", para: 4 });
}
// fit 2D point sets (y up) into a box, preserving aspect
function fit2D(ptsAll, box, pad = 0.1) {
  const xs = ptsAll.map((p) => p[0]), ys = ptsAll.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sc = Math.min((box.w * (1 - 2 * pad)) / (x1 - x0), (box.h * (1 - 2 * pad)) / (y1 - y0));
  const ox = box.x + (box.w - sc * (x1 - x0)) / 2, oy = box.y + (box.h + sc * (y1 - y0)) / 2;
  return (p) => [ox + sc * (p[0] - x0), oy - sc * (p[1] - y0)];
}
const bigArrow = (s, y, label) => {
  s.addShape(pres.shapes.RIGHT_ARROW, { x: 7.05, y: y - 0.2, w: 0.55, h: 0.4, fill: { color: G1 }, line: { color: G1 } });
  T(s, [{ s: label, size: 11, color: G1 }], 6.8, y + 0.25, 1.05, 0.3, { color: G1 });
};
const cap = (s, t) => T(s, [{ s: t, size: 13, color: G1 }], 0.5, 6.95, 12.3, 0.35, { color: G1 });
const R2 = { x: 7.75, y: 0.8, w: 5.2, h: 3.75 };

// ================= (a) before correction =================
{
  const s = pres.addSlide(); s.background = { color: WH };
  head(s, "카메라 좌표계에서 추정한 디바이스 배치", 0.4, 0.3, 6.5);
  // viewing rays to the outermost screen corners
  const Oc = S([0, 0, 0]);
  const ext = [DEVS[0].est[0], DEVS[2].est[1], DEVS[4].est[2], DEVS[3].est[3]];
  ext.forEach((p) => line(s, Oc, S(p), { color: G3, width: 0.75, dash: "dash" }));
  // reference: plane facing the camera (perpendicular to z_c) through c
  const fp = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => S(add(cpt, add(mul(ex, a * 3.6), mul(ey, b * 2.5)))));
  poly(s, fp, { color: BLUE, width: 1, dash: "dash" });
  T(s, [{ s: "카메라 정면 평면 (z_{\\r{c}}에 수직)", size: 11, color: BLUE }], fp[0][0], fp[0][1] - 0.34, 3.0, 0.3, { align: "left", color: BLUE });
  DEVS.forEach((d) => device(s, d.est.map(S), d.id));
  drawCamera(s);
  T(s, [{ s: "각 디바이스를 개별 마커로 추정 → 깊이·기울기 오차", size: 11, color: G1 }], 3.2, 6.35, 3.9, 0.3, { align: "right", color: G1 });

  bigArrow(s, 2.7, "원근 투영");
  // camera image = pinhole projection x' = x/z, y' = y/z
  head(s, "카메라 영상 (\\r{2D})", R2.x, 0.3, 4);
  const proj = (p) => [p[0] / p[2], p[1] / p[2]];
  const imgPts = allEst.map(proj);
  const xs = imgPts.map((p) => p[0]), ys = imgPts.map((p) => p[1]);
  const mx = (Math.max(...xs) - Math.min(...xs)) * 0.1, my = (Math.max(...ys) - Math.min(...ys)) * 0.14;
  const frame = [[Math.min(...xs) - mx, Math.max(...ys) + my], [Math.max(...xs) + mx, Math.max(...ys) + my], [Math.max(...xs) + mx, Math.min(...ys) - my], [Math.min(...xs) - mx, Math.min(...ys) - my]];
  const M = fit2D(frame, R2, 0.02);
  poly(s, frame.map(M), { fill: WH, color: K, width: 1.5 });
  DEVS.forEach((d) => device(s, d.est.map(proj).map(M), d.id, { fill: G5 }));
  const fr = frame.map(M);
  const leftNear = DEVS[0].est[0][2] < DEVS[2].est[1][2];
  T(s, [{ s: leftNear ? "가까운 쪽: 크게" : "먼 쪽: 작게", size: 11, color: G1 }], fr[0][0] + 0.1, fr[3][1] - 0.35, 1.6, 0.28, { align: "left", color: G1 });
  T(s, [{ s: leftNear ? "먼 쪽: 작게" : "가까운 쪽: 크게", size: 11, color: G1 }], fr[1][0] - 1.7, fr[3][1] - 0.35, 1.6, 0.28, { align: "right", color: G1 });
  eqBox(s, [
    { s: "핀홀 투영:  x' = f_{x} x / z + c_{x} ,   y' = f_{y} y / z + c_{y}", size: 14 },
    { s: "정점마다 깊이 z가 달라 서로 다른 배율로 축소됨", size: 12 },
    { s: "→ 직사각형 화면이 사다리꼴로 보이고 크기·간격이 왜곡", size: 12 },
    { s: "→ 카메라 좌표 (x, y)를 그대로 쓰면 \\r{2D} 배치가 틀어짐", size: 12 },
  ], R2.x, 4.75, R2.w, 1.85);
  cap(s, "\\r{(a)} 보정 전: 기울어진 비디오 월이 카메라에서 사다리꼴로 인식되는 상태");
}

// ================= (b) after correction =================
{
  const s = pres.addSlide(); s.background = { color: WH };
  head(s, "공통 평면 추정과 디바이스 정렬", 0.4, 0.3, 6.5);
  // common plane
  const plQ = plCorners.map(S);
  poly(s, plQ, { fill: G5, color: G2, width: 1 });
  T(s, [{ s: "공통 평면  z = ax + by + d", size: 12, color: G1 }], plQ[0][0], plQ[0][1] - 0.36, 2.9, 0.3, { align: "left", color: G1 });
  // estimated (dashed) -> snapped onto the plane (solid)
  DEVS.forEach((d) => poly(s, d.est.map(S), { color: G2, width: 0.75, dash: "sysDash" }));
  DEVS.forEach((d) => d.est.forEach((p) => {
    const a = S(p), b = S(snap(p));
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.06) line(s, a, b, { color: G1, width: 0.75, arrow: true });
  }));
  DEVS.forEach((d) => device(s, d.est.map(snap).map(S), d.id));
  const Oc = drawCamera(s);
  // plane frame at c
  const C2 = S(cpt);
  [[ru, 1.6, RED, "\\b{r}_{u}", [0.12, 0.28]], [rv, 1.5, GREEN, "\\b{r}_{v}", [-0.3, 0]], [g, 1.6, BLUE, "\\b{g}", [0.25, -0.05]]].forEach(([v, len, col, name, o]) => {
    const b = S(add(cpt, mul(v, len)));
    arrow(s, C2, b, { color: col, width: 3 });
    Tc(s, name, b[0] + o[0], b[1] + o[1], 0.45, 0.32, { size: 17 });
  });
  dot(s, C2, 0.065, WH);
  Tc(s, "\\b{c}", C2[0] - 0.22, C2[1] + 0.25, 0.3, 0.3, { size: 16 });
  T(s, [{ s: "점선: 개별 추정 위치,  실선: 공통 평면에 맞춘 위치", size: 11, color: G1 }], 3.0, 6.35, 4.1, 0.3, { align: "right", color: G1 });

  bigArrow(s, 2.7, "평면 좌표 변환");
  // plane coordinates (u, v): front view
  head(s, "공통 평면 좌표 (u, v): 정면에서 본 배치", R2.x, 0.3, 5.2);
  const uvAll = DEVS.flatMap((d) => d.est.map(uvOf));
  const M = fit2D([[pl.u0, pl.v0], [pl.u1, pl.v1]], R2, 0.03);
  const b0 = M([pl.u0, pl.v1]), b1 = M([pl.u1, pl.v0]);
  s.addShape(pres.shapes.RECTANGLE, { x: b0[0], y: b0[1], w: b1[0] - b0[0], h: b1[1] - b0[1], fill: { color: G5 }, line: { color: G2, width: 1 } });
  DEVS.forEach((d) => device(s, d.est.map(uvOf).map(M), d.id));
  const o2 = [b0[0] - 0.02, b1[1] + 0.02];
  arrow(s, o2, [o2[0] + 0.9, o2[1]], { color: RED, width: 2.5 });
  arrow(s, o2, [o2[0], o2[1] - 0.9], { color: GREEN, width: 2.5 });
  Tc(s, "u", o2[0] + 1.05, o2[1] + 0.02, 0.3, 0.3, { size: 15 });
  Tc(s, "v", o2[0] - 0.02, o2[1] - 1.05, 0.3, 0.3, { size: 15 });
  dot(s, o2, 0.05, WH);
  eqBox(s, [
    { s: "\\r{min}_{a,b,d} Σ_{i} Σ_{k} [ z_{i,k} − (a x_{i,k} + b y_{i,k} + d) ]^{2}", size: 13.5 },
    { s: "\\b{r}_{u} = \\b{h} / ‖\\b{h}‖ ,  \\b{h} = \\b{e}_{x} − (\\b{e}_{x}^{\\r{T}}\\b{g})\\b{g} ,   \\b{r}_{v} = \\b{g} × \\b{r}_{u}", size: 13.5 },
    { s: "u_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}}\\b{r}_{u} ,   v_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}}\\b{r}_{v}", size: 13.5 },
    { s: "→ \\b{g} 방향 성분이 제거되어 모든 디바이스가 한 평면에 정렬되고,", size: 12 },
    { s: "    실제 크기·간격을 가진 직사각형 배치로 복원", size: 12 },
  ], R2.x, 4.75, R2.w, 1.85);
  cap(s, "\\r{(b)} 보정 후: 공통 평면에 디바이스를 맞추고 평면 좌표로 변환하여 정면 배치로 복원한 상태");
}
pres.writeFile({ fileName: "keystone_correction.pptx" }).then(() => console.log("written"));
