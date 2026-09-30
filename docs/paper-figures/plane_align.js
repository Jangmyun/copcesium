// Two figures on the common plane:
//  (a) camera axes vs. a tilted common plane (not aligned)
//  (b) plane-aligned axes r_u, r_v, g built from the camera x-axis, and the (u, v) coordinates
// Camera convention follows the reference figure: x_c right, y_c up, z_c optical axis.
const L = require("./lib3d.js");
const { pres, T, Tc, line, arrow, poly, dot, makeView, cameraModel, add, sub, mul, dotp, cross, norm, K, G1, G2, G3, G5, WH } = L;

const RED = "EE0000", GREEN = "00B800", BLUE = "0000EE";          // camera / aligned axes
const LRED = "E06666", LGREEN = "6AA84F", LBLUE = "6FA8DC";      // translated copies of camera axes

// ---------------- scene (camera coordinates) ----------------
const rotY = (v, a) => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
const rotX = (v, a) => [v[0], v[1] * Math.cos(a) - v[2] * Math.sin(a), v[1] * Math.sin(a) + v[2] * Math.cos(a)];
const d2r = Math.PI / 180;
const P0 = [0.9, 0.9, 5.4];
const g = norm(rotX(rotY([0, 0, 1], -28 * d2r), -18 * d2r));   // plane normal, pointing away from the camera
const ex = [1, 0, 0], ey = [0, 1, 0], ez = [0, 0, 1];
const hvec = sub(ex, mul(g, dotp(ex, g)));
const ru = norm(hvec), rv = cross(g, ru);
const onP0 = (u, v) => add(P0, add(mul(ru, u), mul(rv, v)));
const DEVS = [
  { c: [-2.3, 0.25], w: 1.6, h: 2.8, th: 4 },
  { c: [0.9, 0.95], w: 2.5, h: 1.55, th: -3 },
  { c: [1.2, -1.35], w: 1.0, h: 1.8, th: 8 },
].map((d) => {
  const t = d.th * d2r, xd = add(mul(ru, Math.cos(t)), mul(rv, Math.sin(t))), yd = add(mul(ru, -Math.sin(t)), mul(rv, Math.cos(t)));
  const o = onP0(...d.c);
  return { ...d, corners: [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => add(o, add(mul(xd, (a * d.w) / 2), mul(yd, (b * d.h) / 2)))) };
});
const allC = DEVS.flatMap((d) => d.corners);
const cpt = allC.reduce((a, p) => add(a, mul(p, 1 / allC.length)), [0, 0, 0]);
const uvOf = (p) => [dotp(sub(p, cpt), ru), dotp(sub(p, cpt), rv)];
const Us = allC.map((p) => uvOf(p)[0]), Vs = allC.map((p) => uvOf(p)[1]);
const pl = { u0: Math.min(...Us) - 0.7, u1: Math.max(...Us) + 0.7, v0: Math.min(...Vs) - 0.6, v1: Math.max(...Vs) + 0.6 };
const onC = (u, v) => add(cpt, add(mul(ru, u), mul(rv, v)));

// ---------------- common drawing ----------------
const CAM = 1.55; // camera model scale (schematic, larger than true scale)
function setup(s) {
  const view = makeView(50, -18);
  const body = []; for (const x of [-0.42, 0.42]) for (const y of [-0.32, 0.32]) for (const z of [-1.57, 0]) body.push([x * CAM, y * CAM, z * CAM]);
  const keys = [[0, 0, 0], ...body, [1.7, 0, 0], [0, 1.45, 0], [0, 0, 1.9], ...[[pl.u0, pl.v0], [pl.u1, pl.v0], [pl.u1, pl.v1], [pl.u0, pl.v1]].map(([u, v]) => onC(u, v))];
  const raw = keys.map(view), xs = raw.map((r) => r[0]), ys = raw.map((r) => r[1]);
  const box = { x: 0.35, y: 0.45, w: 8.75, h: 6.1 };
  const sc = Math.min(box.w / (Math.max(...xs) - Math.min(...xs)), box.h / (Math.max(...ys) - Math.min(...ys)));
  const ox = box.x + (box.w - sc * (Math.max(...xs) - Math.min(...xs))) / 2 - sc * Math.min(...xs);
  const oy = box.y + (box.h - sc * (Math.max(...ys) - Math.min(...ys))) / 2 + sc * Math.max(...ys);
  const S = (p) => { const r = view(p); return [ox + sc * r[0], oy - sc * r[1]]; };

  // plane + devices (faint)
  const plQ = [[pl.u0, pl.v1], [pl.u1, pl.v1], [pl.u1, pl.v0], [pl.u0, pl.v0]].map(([u, v]) => S(onC(u, v)));
  poly(s, plQ, { fill: G5, color: G2, width: 1 });
  DEVS.forEach((d) => {
    poly(s, d.corners.map(S), { fill: WH, color: "A6A6A6", width: 1 });
    d.corners.forEach((q) => dot(s, S(q), 0.035, G2));
  });
  T(s, [{ s: "공통 평면   z = ax + by + d", size: 13, color: G1 }], plQ[3][0] + 0.15, plQ[3][1] + 0.1, 3.2, 0.32, { align: "left", color: G1 });

  // camera + camera axes
  const Oc = S([0, 0, 0]);
  cameraModel(s, Oc, sc * CAM, view);
  [[ex, 1.7, RED, "x_{\\r{c}}", [0.1, 0.28]], [ey, 1.45, GREEN, "y_{\\r{c}}", [-0.3, 0]], [ez, 1.9, BLUE, "z_{\\r{c}}", [-0.05, 0.3]]].forEach(([v, len, col, name, o]) => {
    const b = S(mul(v, len));
    arrow(s, Oc, b, { color: col, width: 3 });
    Tc(s, name, b[0] + o[0], b[1] + o[1], 0.45, 0.32, { size: 18 });
  });
  dot(s, Oc, 0.05, WH);
  T(s, [{ s: "카메라 좌표계", size: 13, bold: true }], Oc[0] - 1.9, Oc[1] + 1.15, 1.8, 0.32, { align: "left" });
  return { S, sc, plQ };
}
function card(s, title, lines, x, y, w, h) {
  s.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: { color: WH }, line: { color: G3, width: 1 } });
  T(s, [{ s: title, size: 14, bold: true }], x + 0.2, y + 0.12, w - 0.4, 0.36, { align: "left" });
  T(s, lines, x + 0.2, y + 0.55, w - 0.4, h - 0.65, { align: "left", valign: "top", para: 5 });
}
function arc(s, S, c, a, b, r, o = {}) { // arc between unit directions a, b around c
  const pts = [];
  for (let k = 0; k <= 16; k++) { const t = k / 16; pts.push(S(add(c, mul(norm(add(mul(a, 1 - t), mul(b, t))), r)))); }
  for (let k = 0; k < 16; k++) line(s, pts[k], pts[k + 1], { color: o.color || K, width: o.width || 1 });
  return pts[8];
}
const cap = (s, t) => T(s, [{ s: t, size: 13, color: G1 }], 0.5, 6.95, 12.3, 0.35, { color: G1 });

// ================= (a) not aligned =================
{
  const s = pres.addSlide(); s.background = { color: WH };
  const { S } = setup(s);
  const C2 = S(cpt), Lc = 2.0;
  // camera axes translated to c (dashed, light) — they are not in the plane
  [[ex, LRED, "\\b{e}_{x}", [0.25, 0.05]], [ey, LGREEN, "\\b{e}_{y}", [-0.28, 0]], [ez, LBLUE, "\\b{e}_{z}", [0.1, -0.25]]].forEach(([v, col, name, o]) => {
    const b = S(add(cpt, mul(v, Lc)));
    arrow(s, C2, b, { color: col, width: 2.25, dash: "dash" });
    Tc(s, name, b[0] + o[0], b[1] + o[1], 0.45, 0.32, { size: 16 });
  });
  // e_x leaves the plane: drop to the plane along g
  const tip = add(cpt, mul(ex, Lc)), foot = sub(tip, mul(g, dotp(sub(tip, cpt), g)));
  line(s, S(tip), S(foot), { color: G1, width: 1, dash: "sysDot" });
  dot(s, S(foot), 0.04, WH);
  // plane normal g and its angle to e_z
  const gt = S(add(cpt, mul(g, 2.2)));
  arrow(s, C2, gt, { color: K, width: 2.75 });
  Tc(s, "\\b{g}", gt[0] + 0.05, gt[1] - 0.25, 0.35, 0.32, { size: 18 });
  const am = arc(s, S, cpt, g, ez, 1.3, { color: K });
  Tc(s, "θ", am[0] + 0.18, am[1] - 0.08, 0.3, 0.3, { size: 16 });
  dot(s, C2, 0.07, WH);
  Tc(s, "\\b{c}", C2[0] - 0.2, C2[1] + 0.25, 0.3, 0.3, { size: 17 });
  card(s, "정렬 전: 좌표축과 평면의 불일치", [
    { s: "\\b{e}_{x}, \\b{e}_{y}, \\b{e}_{z}: 카메라 좌표축 단위벡터", size: 13 },
    { s: "공통 평면:  z = ax + by + d", size: 15 },
    { s: "법선:  \\b{g} = (−a, −b, 1)^{\\r{T}} / ‖(−a, −b, 1)^{\\r{T}}‖", size: 15 },
    { s: "\\b{g} ≠ \\b{e}_{z} ,  \\b{e}_{x}^{\\r{T}}\\b{g} ≠ 0 ,  \\b{e}_{y}^{\\r{T}}\\b{g} ≠ 0", size: 15 },
    { s: "→ 카메라 x, y축은 평면 위의", size: 13 },
    { s: "    수평·수직 방향이 아님", size: 13 },
  ], 9.3, 2.0, 3.75, 2.75);
  cap(s, "\\r{(a)} 카메라 좌표계와 공통 평면이 정렬되지 않은 상태");
}

// ================= (b) aligned =================
{
  const s = pres.addSlide(); s.background = { color: WH };
  const { S } = setup(s);
  const C2 = S(cpt);
  // plane axis lines
  line(s, S(onC(pl.u0, 0)), S(onC(pl.u1, 0)), { color: G2, width: 0.75, dash: "sysDash" });
  line(s, S(onC(0, pl.v0)), S(onC(0, pl.v1)), { color: G2, width: 0.75, dash: "sysDash" });
  // example vertex p (bottom-right corner of the left device) and its (u, v)
  const p = DEVS[0].corners[2], [pu, pv] = uvOf(p);
  line(s, S(p), S(onC(pu, 0)), { dash: "dash", width: 1 });
  line(s, S(p), S(onC(0, pv)), { dash: "dash", width: 1 });
  dot(s, S(onC(pu, 0)), 0.045, WH); dot(s, S(onC(0, pv)), 0.045, WH);
  line(s, S(onC(0, 0.3)), S(onC(pu, 0.3)), { arrow: true, arrow2: true, width: 0.75 });
  Tc(s, "u_{i,k}", ...S(onC(pu / 2, 0.6)), 0.55, 0.3, { size: 15 });
  line(s, S(onC(-0.3, 0)), S(onC(-0.3, pv)), { arrow: true, arrow2: true, width: 0.75 });
  Tc(s, "v_{i,k}", ...S(onC(-0.68, pv / 2)), 0.55, 0.3, { size: 15 });
  dot(s, S(p), 0.075);
  Tc(s, "\\b{p}_{i,k}^{\\r{cam}}", S(p)[0] - 0.45, S(p)[1] + 0.3, 0.9, 0.34, { size: 16 });
  // construction of r_u from e_x
  const LE = 2.8, exT = add(cpt, mul(ex, LE)), hT = add(cpt, mul(hvec, LE));
  arrow(s, C2, S(exT), { color: LRED, width: 2, dash: "dash" });
  line(s, S(exT), S(hT), { color: G1, width: 1.25, dash: "sysDot", arrow: true });
  Tc(s, "\\b{e}_{x}", S(exT)[0] + 0.28, S(exT)[1] - 0.05, 0.45, 0.32, { size: 16 });
  Tc(s, "−(\\b{e}_{x}^{\\r{T}}\\b{g})\\b{g}", (S(exT)[0] + S(hT)[0]) / 2 + 0.75, (S(exT)[1] + S(hT)[1]) / 2 + 0.05, 1.3, 0.3, { size: 13 });
  // aligned frame (r_u, r_v, g) = red, green, blue
  [[ru, 2.0, RED, "\\b{r}_{u}", [0.12, -0.28]], [rv, 1.8, GREEN, "\\b{r}_{v}", [-0.3, 0]], [g, 2.1, BLUE, "\\b{g}", [0.2, -0.15]]].forEach(([v, len, col, name, o]) => {
    const b = S(add(cpt, mul(v, len)));
    arrow(s, C2, b, { color: col, width: 3.25 });
    Tc(s, name, b[0] + o[0], b[1] + o[1], 0.45, 0.34, { size: 19 });
  });
  poly(s, [S(cpt), S(add(cpt, mul(ru, 0.28))), S(add(cpt, add(mul(ru, 0.28), mul(rv, 0.28)))), S(add(cpt, mul(rv, 0.28)))], { width: 0.75 });
  dot(s, C2, 0.07, WH);
  Tc(s, "\\b{c}", C2[0] + 0.2, C2[1] + 0.28, 0.3, 0.3, { size: 17 });
  card(s, "정렬 후: 공통 평면 기준축 (\\b{r}_{u}, \\b{r}_{v}, \\b{g})", [
    { s: "\\b{h} = \\b{e}_{x} − (\\b{e}_{x}^{\\r{T}}\\b{g}) \\b{g}", size: 15 },
    { s: "\\b{r}_{u} = \\b{h} / ‖\\b{h}‖ ,   \\b{r}_{v} = \\b{g} × \\b{r}_{u}", size: 15 },
    { s: "\\b{c} = (1/N) Σ_{i} Σ_{k} \\b{p}_{i,k}^{\\r{cam}}", size: 15 },
    { s: "u_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}} \\b{r}_{u}", size: 15 },
    { s: "v_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}} \\b{r}_{v}", size: 15 },
  ], 9.3, 2.1, 3.75, 2.5);
  cap(s, "\\r{(b)} 공통 평면 기준축으로 정렬한 상태");
}
pres.writeFile({ fileName: "common_plane_alignment.pptx" }).then(() => console.log("written"));
