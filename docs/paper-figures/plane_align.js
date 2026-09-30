// Two figures on the common plane:
//  (a) the common plane stands in front of the camera but is tilted w.r.t. the camera axes
//  (b) the plane is rotated by R_p = [r_u r_v g]^T so that r_u, r_v, g coincide with x_c, y_c, z_c
// Camera convention follows the reference figure: x_c right, y_c up, z_c optical axis.
const L = require("./lib3d.js");
const { pres, T, Tc, line, arrow, poly, dot, makeView, cameraModel, add, sub, mul, dotp, cross, norm, K, G1, G2, G3, G5, WH } = L;

const RED = "EE0000", GREEN = "00B800", BLUE = "0000EE";      // camera / plane axes
const LRED = "E06666", LGREEN = "6AA84F", LBLUE = "6FA8DC";  // camera axes translated to c

// ---------------- scene (camera coordinates) ----------------
const d2r = Math.PI / 180;
const rotY = (v, a) => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
const rotX = (v, a) => [v[0], v[1] * Math.cos(a) - v[2] * Math.sin(a), v[1] * Math.sin(a) + v[2] * Math.cos(a)];
const ex = [1, 0, 0], ey = [0, 1, 0], ez = [0, 0, 1];
const P0 = [1.3, 0.3, 7.0];                                   // plane stands in front of the camera
const g = norm(rotX(rotY(ez, -10 * d2r), -22 * d2r));           // tilted normal (away from camera)
const hvec = sub(ex, mul(g, dotp(ex, g)));
const ru = norm(hvec), rv = cross(g, ru);
const DEVS = [
  { c: [-1.9, 0.2], w: 1.5, h: 2.6, th: 4 },
  { c: [0.9, 0.85], w: 2.3, h: 1.45, th: -3 },
  { c: [1.1, -1.25], w: 0.95, h: 1.7, th: 8 },
];
const onP0 = (u, v) => add(P0, add(mul(ru, u), mul(rv, v)));
DEVS.forEach((d) => {
  const t = d.th * d2r, xd = add(mul(ru, Math.cos(t)), mul(rv, Math.sin(t))), yd = add(mul(ru, -Math.sin(t)), mul(rv, Math.cos(t)));
  const o = onP0(...d.c);
  d.corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => add(o, add(mul(xd, (a * d.w) / 2), mul(yd, (b * d.h) / 2))));
});
const allC = DEVS.flatMap((d) => d.corners);
const cpt = allC.reduce((a, p) => add(a, mul(p, 1 / allC.length)), [0, 0, 0]);
const uvOf = (p) => [dotp(sub(p, cpt), ru), dotp(sub(p, cpt), rv)];
const Us = allC.map((p) => uvOf(p)[0]), Vs = allC.map((p) => uvOf(p)[1]);
const pl = { u0: Math.min(...Us) - 0.55, u1: Math.max(...Us) + 0.55, v0: Math.min(...Vs) - 0.5, v1: Math.max(...Vs) + 0.5 };
const tilted = (u, v) => add(cpt, add(mul(ru, u), mul(rv, v)));   // point on the tilted plane
const aligned = (u, v) => add(cpt, add(mul(ex, u), mul(ey, v)));  // same (u, v) after rotation by R_p
const corners4 = [[pl.u0, pl.v1], [pl.u1, pl.v1], [pl.u1, pl.v0], [pl.u0, pl.v0]];

// ---------------- projection: rear 3/4 view with mild perspective ----------------
const CAM = 1.35;
const view = makeView(50, -16);
const DPER = 26, zRef = view(cpt)[2];
const persp = (p) => { const r = view(p), k = DPER / (DPER + r[2] - zRef); return [r[0] * k, r[1] * k]; };
function fitter() {
  const body = []; for (const x of [-0.42, 0.42]) for (const y of [-0.32, 0.32]) for (const z of [-1.57, 0]) body.push([x * CAM, y * CAM, z * CAM]);
  const keys = [...body, [1.8, 0, 0], [0, 1.5, 0], ...corners4.map((c) => tilted(...c)), ...corners4.map((c) => aligned(...c))];
  const raw = keys.map(persp), xs = raw.map((r) => r[0]), ys = raw.map((r) => r[1]);
  const box = { x: 0.35, y: 0.55, w: 8.3, h: 6.0 };
  const sc = Math.min(box.w / (Math.max(...xs) - Math.min(...xs)), box.h / (Math.max(...ys) - Math.min(...ys)));
  const ox = box.x + (box.w - sc * (Math.max(...xs) - Math.min(...xs))) / 2 - sc * Math.min(...xs);
  const oy = box.y + (box.h - sc * (Math.max(...ys) - Math.min(...ys))) / 2 + sc * Math.max(...ys);
  return (p) => { const r = persp(p); return [ox + sc * r[0], oy - sc * r[1]]; };
}
const S = fitter();

// ---------------- drawing helpers ----------------
function drawPlane(s, map, o = {}) {
  const Q = corners4.map((c) => S(map(...c)));
  poly(s, Q, o.ghost ? { color: G2, width: 1, dash: "dash" } : { fill: G5, color: G2, width: 1 });
  if (!o.ghost) DEVS.forEach((d) => {
    const pts = d.corners.map((p) => S(map(...uvOf(p))));
    poly(s, pts, { fill: WH, color: "A6A6A6", width: 1 });
    pts.forEach((q) => dot(s, q, 0.035, G2));
  });
  return Q;
}
function drawCamera(s) {
  const Oc = S([0, 0, 0]);
  cameraModel(s, Oc, 1, view, (p) => S(mul(p, CAM)));
  [[ex, 1.8, RED, "x_{\\r{c}}", [0.12, 0.28]], [ey, 1.5, GREEN, "y_{\\r{c}}", [-0.3, 0]], [ez, 2.0, BLUE, "z_{\\r{c}}", [-0.05, 0.32]]].forEach(([v, len, col, name, o]) => {
    const b = S(mul(v, len));
    arrow(s, Oc, b, { color: col, width: 3 });
    Tc(s, name, b[0] + o[0], b[1] + o[1], 0.45, 0.32, { size: 18 });
  });
  dot(s, Oc, 0.05, WH);
  T(s, [{ s: "카메라 좌표계", size: 13, bold: true }], Oc[0] - 1.7, Oc[1] + 1.05, 1.8, 0.32, { align: "left" });
}
function card(s, title, lines, x, y, w, h) {
  s.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: { color: WH }, line: { color: G3, width: 1 } });
  T(s, [{ s: title, size: 14, bold: true }], x + 0.2, y + 0.12, w - 0.4, 0.36, { align: "left" });
  T(s, lines, x + 0.2, y + 0.55, w - 0.4, h - 0.65, { align: "left", valign: "top", para: 5 });
}
function arcPts(c, a, b, r, n = 20) { // points on the arc from direction a to b around c
  const pts = [];
  for (let k = 0; k <= n; k++) { const t = k / n; pts.push(S(add(c, mul(norm(add(mul(a, 1 - t), mul(b, t))), r)))); }
  return pts;
}
function polyline(s, pts, o = {}) {
  for (let k = 0; k < pts.length - 1; k++) line(s, pts[k], pts[k + 1], { color: o.color || K, width: o.width || 1, dash: o.dash, arrow: o.arrow && k === pts.length - 2 });
}
const cap = (s, t) => T(s, [{ s: t, size: 13, color: G1 }], 0.5, 6.95, 12.3, 0.35, { color: G1 });

// ================= (a) not aligned =================
{
  const s = pres.addSlide(); s.background = { color: WH };
  const Q = drawPlane(s, tilted);
  T(s, [{ s: "공통 평면   z = ax + by + d", size: 13, color: G1 }], Q[2][0] - 3.2, Q[2][1] + 0.1, 3.2, 0.32, { align: "right", color: G1 });
  drawCamera(s);
  const C2 = S(cpt), Lc = 1.9;
  [[ex, LRED, "\\b{e}_{x}", [0.28, 0.08]], [ey, LGREEN, "\\b{e}_{y}", [-0.3, 0]], [ez, LBLUE, "\\b{e}_{z}", [0.2, -0.22]]].forEach(([v, col, name, o]) => {
    const b = S(add(cpt, mul(v, Lc)));
    arrow(s, C2, b, { color: col, width: 2.25, dash: "dash" });
    Tc(s, name, b[0] + o[0], b[1] + o[1], 0.45, 0.32, { size: 16 });
  });
  const tip = add(cpt, mul(ex, Lc)), foot = sub(tip, mul(g, dotp(sub(tip, cpt), g)));
  line(s, S(tip), S(foot), { color: G1, width: 1, dash: "sysDot" });
  dot(s, S(foot), 0.04, WH);
  const gt = S(add(cpt, mul(g, 2.1)));
  arrow(s, C2, gt, { color: K, width: 2.75 });
  Tc(s, "\\b{g}", gt[0] + 0.22, gt[1] - 0.1, 0.35, 0.32, { size: 18 });
  const am = arcPts(cpt, g, ez, 1.2);
  polyline(s, am);
  Tc(s, "θ", am[10][0] + 0.2, am[10][1] - 0.1, 0.3, 0.3, { size: 16 });
  dot(s, C2, 0.07, WH);
  Tc(s, "\\b{c}", C2[0] - 0.2, C2[1] + 0.26, 0.3, 0.3, { size: 17 });
  card(s, "정렬 전: 좌표축과 평면의 불일치", [
    { s: "\\b{e}_{x}, \\b{e}_{y}, \\b{e}_{z}: 카메라 좌표축 단위벡터", size: 13 },
    { s: "공통 평면:  z = ax + by + d", size: 15 },
    { s: "법선:  \\b{g} = (−a, −b, 1)^{\\r{T}} / ‖(−a, −b, 1)^{\\r{T}}‖", size: 15 },
    { s: "\\b{g} ≠ \\b{e}_{z} ,  \\b{e}_{x}^{\\r{T}}\\b{g} ≠ 0 ,  \\b{e}_{y}^{\\r{T}}\\b{g} ≠ 0", size: 15 },
    { s: "→ 평면이 광축에 대해 θ만큼 기울어", size: 13 },
    { s: "    카메라 x, y축이 평면 위에 있지 않음", size: 13 },
  ], 9.3, 1.9, 3.75, 2.9);
  cap(s, "\\r{(a)} 카메라 좌표계와 공통 평면이 정렬되지 않은 상태");
}

// ================= (b) aligned =================
{
  const s = pres.addSlide(); s.background = { color: WH };
  const Q = drawPlane(s, aligned);
  T(s, [{ s: "정렬된 공통 평면  (\\b{g} ∥ z_{\\r{c}})", size: 13, color: G1 }], Q[2][0] - 3.4, Q[2][1] + 0.1, 3.4, 0.32, { align: "right", color: G1 });
  const G = drawPlane(s, tilted, { ghost: true });
  // rotation arrow at the corner that moves the most
  const k = [0, 1, 2, 3].reduce((b, i) => (Math.hypot(...sub(G[i], Q[i])) > Math.hypot(...sub(G[b], Q[b])) ? i : b), 0);
  const a0 = sub(tilted(...corners4[k]), cpt), a1 = sub(aligned(...corners4[k]), cpt);
  const rp = arcPts(cpt, norm(a0), norm(a1), Math.hypot(...a0), 14);
  polyline(s, rp, { width: 1.75, arrow: true });
  Tc(s, "\\b{R}_{p}", rp[7][0] + 0.32, rp[7][1], 0.5, 0.32, { size: 17 });
  T(s, [{ s: "회전 전 공통 평면 (점선)", size: 12, color: G2 }], G[0][0] - 2.4, G[0][1] - 0.15, 2.3, 0.3, { align: "right", color: G2 });
  drawCamera(s);
  const C2 = S(cpt);
  // example vertex p and its (u, v) on the aligned plane
  const p = DEVS[0].corners[2], [pu, pv] = uvOf(p), P2 = S(aligned(pu, pv));
  line(s, S(aligned(pl.u0, 0)), S(aligned(pl.u1, 0)), { color: G2, width: 0.75, dash: "sysDash" });
  line(s, S(aligned(0, pl.v0)), S(aligned(0, pl.v1)), { color: G2, width: 0.75, dash: "sysDash" });
  line(s, P2, S(aligned(pu, 0)), { dash: "dash", width: 1 });
  line(s, P2, S(aligned(0, pv)), { dash: "dash", width: 1 });
  dot(s, S(aligned(pu, 0)), 0.045, WH); dot(s, S(aligned(0, pv)), 0.045, WH);
  line(s, S(aligned(0, 0.3)), S(aligned(pu, 0.3)), { arrow: true, arrow2: true, width: 0.75 });
  Tc(s, "u_{i,k}", ...S(aligned(pu / 2, 0.62)), 0.55, 0.3, { size: 15 });
  line(s, S(aligned(-0.55, 0)), S(aligned(-0.55, pv)), { arrow: true, arrow2: true, width: 0.75 });
  Tc(s, "v_{i,k}", ...S(aligned(pu - 0.4, pv / 2)), 0.55, 0.3, { size: 15 });
  dot(s, P2, 0.075);
  Tc(s, "\\b{p}_{i,k}", P2[0] - 0.4, P2[1] + 0.28, 0.6, 0.32, { size: 16 });
  // plane axes, now parallel to the camera axes
  [[ex, 1.8, RED, "\\b{r}_{u}", [0.1, 0.3]], [ey, 1.6, GREEN, "\\b{r}_{v}", [-0.3, 0]], [ez, 1.9, BLUE, "\\b{g}", [0.25, -0.1]]].forEach(([v, len, col, name, o]) => {
    const b = S(add(cpt, mul(v, len)));
    arrow(s, C2, b, { color: col, width: 3.25 });
    Tc(s, name, b[0] + o[0], b[1] + o[1], 0.45, 0.34, { size: 19 });
  });
  poly(s, [S(cpt), S(aligned(0.28, 0)), S(aligned(0.28, 0.28)), S(aligned(0, 0.28))], { width: 0.75 });
  dot(s, C2, 0.07, WH);
  Tc(s, "\\b{c}", C2[0] + 0.02, C2[1] + 0.38, 0.3, 0.3, { size: 17 });
  card(s, "정렬 후: 평면 기준축 = 카메라 축", [
    { s: "\\b{h} = \\b{e}_{x} − (\\b{e}_{x}^{\\r{T}}\\b{g}) \\b{g}", size: 15 },
    { s: "\\b{r}_{u} = \\b{h} / ‖\\b{h}‖ ,   \\b{r}_{v} = \\b{g} × \\b{r}_{u}", size: 15 },
    { s: "\\b{R}_{p} = [ \\b{r}_{u}  \\b{r}_{v}  \\b{g} ]^{\\r{T}}", size: 15 },
    { s: "\\b{R}_{p}(\\b{p}_{i,k}^{\\r{cam}} − \\b{c}) = (u_{i,k}, v_{i,k}, w_{i,k})^{\\r{T}}", size: 15 },
    { s: "u_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}} \\b{r}_{u}", size: 15 },
    { s: "v_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}} \\b{r}_{v}", size: 15 },
    { s: "→ \\b{r}_{u}, \\b{r}_{v}, \\b{g} 가 x_{\\r{c}}, y_{\\r{c}}, z_{\\r{c}} 와 일치,  w_{i,k} ≈ 0", size: 13 },
  ], 9.3, 1.55, 3.75, 3.6);
  cap(s, "\\r{(b)} 공통 평면을 회전하여 카메라 좌표계와 정렬한 상태");
}
pres.writeFile({ fileName: "common_plane_alignment.pptx" }).then(() => console.log("written"));
