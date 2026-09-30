// Common-plane figure in the style of the user's reference sketch:
// camera (lower-left) + one gray common plane with three phones, dashed in-plane axes,
// plane frame r_u / r_v / g (light colours) at c, g pointing back toward the camera.
//  (a) before: phones estimated independently (not coplanar), camera axes translated to c do not match the wall
//  (b) after : common plane fitted, phones on it, plane frame (r_u, r_v, g)
// Camera convention follows the reference: x_c right, y_c up, z_c optical axis.
const L = require("./lib3d.js");
const { pres, T, Tc, line, arrow, poly, dot, makeView, cameraModel, add, sub, mul, dotp, cross, norm, K, G1, G2, WH } = L;

const RED = "FF0000", GREEN = "00D000", BLUE = "0000FF";          // camera axes (saturated)
const LRED = "E06666", LGREEN = "93C47D", LBLUE = "6FA8DC";      // plane axes (light, as in the sketch)
const PLANE_FILL = "E6E7EB", PLANE_LINE = "8C9099", BEZEL = "A6A8B0", MK = "555555";
const d2r = Math.PI / 180;
const rotY = (v, a) => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
const rotX = (v, a) => [v[0], v[1] * Math.cos(a) - v[2] * Math.sin(a), v[1] * Math.sin(a) + v[2] * Math.cos(a)];
const ex = [1, 0, 0], ey = [0, 1, 0], ez = [0, 0, 1];

// ---------------- scene ----------------
const P0 = [2.2, 1.3, 7.5];
const gAway = norm(rotX(rotY(ez, -32 * d2r), 6 * d2r));   // wall turned toward the viewer, tilted w.r.t. the camera
const g = mul(gAway, -1);                                  // plane normal toward the camera: g ∝ (a, b, −1)
const hvec = sub(ex, mul(g, dotp(ex, g)));
const ru = norm(hvec), rv = norm(cross(ru, g));            // r_v = r_u × g points up
const PH = [ // phones in plane coordinates
  { c: [-2.3, 0.15], th: -4, err: [0.22, 5, -4] },
  { c: [0.0, 0.3], th: 3, err: [-0.18, -4, 5] },
  { c: [2.25, -0.4], th: -4, err: [0.2, 6, 3] },
];
const PW = 1.05, PHH = 1.95, RAD = 0.14, MKS = 0.62;
function rrect(w, h, r, n = 5) { // rounded rectangle outline (local 2D)
  const pts = [];
  [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]].forEach(([cx, cy, a0]) => {
    for (let k = 0; k <= n; k++) { const a = (a0 + (90 * k) / n) * d2r; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  });
  return pts;
}
PH.forEach((p) => {
  const t = p.th * d2r;
  p.x = add(mul(ru, Math.cos(t)), mul(rv, Math.sin(t)));
  p.y = add(mul(ru, -Math.sin(t)), mul(rv, Math.cos(t)));
  p.o = add(P0, add(mul(ru, p.c[0]), mul(rv, p.c[1])));
  // independent (erroneous) estimate for figure (a): offset along the normal + small tilt
  p.oe = add(p.o, mul(g, p.err[0]));
  p.xe = norm(add(p.x, mul(g, Math.tan(p.err[1] * d2r))));
  p.ye = norm(add(p.y, mul(g, Math.tan(p.err[2] * d2r))));
});
const cpt = PH.reduce((a, p) => add(a, mul(p.o, 1 / PH.length)), [0, 0, 0]);
const PL = { u0: -3.6, u1: 3.55, v0: -1.75, v1: 1.85 };
const onC = (u, v) => add(cpt, add(mul(ru, u), mul(rv, v)));

// ---------------- orthographic rear-3/4 view (as in the sketch) ----------------
const CAM = 1.3;
const view = makeView(50, -18);
const S = (() => {
  const body = []; for (const x of [-0.42, 0.42]) for (const y of [-0.32, 0.32]) for (const z of [-1.57, 0]) body.push([x * CAM, y * CAM, z * CAM]);
  const keys = [...body, [1.9, 0, 0], [0, 1.6, 0], ...[[PL.u0, PL.v0], [PL.u1, PL.v0], [PL.u1, PL.v1], [PL.u0, PL.v1]].map(([u, v]) => onC(u, v))];
  const raw = keys.map(view), xs = raw.map((r) => r[0]), ys = raw.map((r) => r[1]);
  const box = { x: 1.6, y: 0.75, w: 11.2, h: 5.9 };
  const sc = Math.min(box.w / (Math.max(...xs) - Math.min(...xs)), box.h / (Math.max(...ys) - Math.min(...ys)));
  const ox = box.x + (box.w - sc * (Math.max(...xs) - Math.min(...xs))) / 2 - sc * Math.min(...xs);
  const oy = box.y + (box.h - sc * (Math.max(...ys) - Math.min(...ys))) / 2 + sc * Math.max(...ys);
  return (p) => { const r = view(p); return [ox + sc * r[0], oy - sc * r[1]]; };
})();

// ---------------- drawing ----------------
const PAY = ["1011", "0110", "1001", "0101"];
function phone(s, o, X, Y, idx) {
  const at = (a, b) => S(add(o, add(mul(X, a), mul(Y, b))));
  poly(s, rrect(PW, PHH, RAD).map(([a, b]) => at(a, b)), { fill: "F2F2F4", color: BEZEL, width: 1.5 });
  poly(s, rrect(PW - 0.1, PHH - 0.1, RAD * 0.7).map(([a, b]) => at(a, b)), { fill: WH, color: BEZEL, width: 0.75 });
  // marker (dark gray, 6x6 grid)
  const m = MKS / 2, q = [at(-m, m), at(m, m), at(m, -m), at(-m, -m)];
  const bil = (u, v) => { const t = add(q[0], mul(sub(q[1], q[0]), u)), b = add(q[3], mul(sub(q[2], q[3]), u)); return add(t, mul(sub(b, t), v)); };
  poly(s, q, { fill: MK, noLine: true });
  const pay = PAY.map((r, i) => (idx % 2 ? r.split("").reverse().join("") : r)).slice(idx % 3).concat(PAY.slice(0, idx % 3));
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (pay[r][c] === "0")
    poly(s, [bil((c + 1) / 6, (r + 1) / 6), bil((c + 2) / 6, (r + 1) / 6), bil((c + 2) / 6, (r + 2) / 6), bil((c + 1) / 6, (r + 2) / 6)], { fill: WH, noLine: true });
}
function drawCamera(s) {
  const Oc = S([0, 0, 0]);
  cameraModel(s, Oc, 1, view, (p) => S(mul(p, CAM)));
  const tips = {};
  [["x", ex, 1.9, RED, "x_{\\r{c}}", [0.05, 0.3]], ["y", ey, 1.6, GREEN, "y_{\\r{c}}", [-0.3, 0.05]], ["z", ez, 2.1, BLUE, "z_{\\r{c}}", [-0.05, 0.3]]].forEach(([k, v, len, col, name, o]) => {
    const b = S(mul(v, len));
    arrow(s, Oc, b, { color: col, width: 3 });
    Tc(s, name, b[0] + o[0], b[1] + o[1], 0.45, 0.32, { size: 18 });
    tips[k] = b;
  });
  return { Oc, tips };
}
function frameAt(s, o, axes) { // axes: [[vec, len, colour, label, labelOffset], ...]
  const C2 = S(o);
  axes.forEach(([v, len, col, name, off, dash]) => {
    const b = S(add(o, mul(v, len)));
    arrow(s, C2, b, { color: col, width: 3, dash });
    Tc(s, name, b[0] + off[0], b[1] + off[1], 0.5, 0.36, { size: 20 });
  });
  dot(s, C2, 0.055, K);
}
function eqs(s, lines) { T(s, lines, 0.45, 0.4, 5.6, 1.8, { align: "left", valign: "top", para: 4 }); }
const cap = (s, t) => T(s, [{ s: t, size: 13, color: G1 }], 0.5, 6.95, 12.3, 0.35, { color: G1 });

// ================= (a) before =================
{
  const s = pres.addSlide(); s.background = { color: WH };
  PH.forEach((p, i) => phone(s, p.oe, p.xe, p.ye, i));
  const { tips } = drawCamera(s);
  line(s, tips.z, S(cpt), { color: G2, width: 2, dash: "dash" });
  // camera axes translated to c: they do not follow the wall
  frameAt(s, cpt, [
    [ex, 1.7, LRED, "\\b{e}_{x}", [0.15, 0.3], "dash"],
    [ey, 1.45, LGREEN, "\\b{e}_{y}", [-0.32, 0.05], "dash"],
    [mul(ez, -1), 2.2, LBLUE, "−\\b{e}_{z}", [-0.3, 0.2], "dash"],
  ]);
  eqs(s, [
    { s: "개별 마커로 추정한 디바이스는 서로 다른 깊이·기울기를 가짐", size: 13 },
    { s: "카메라 축을 그대로 쓰면  \\b{e}_{x}, \\b{e}_{y} 가 벽면과 어긋남", size: 13 },
    { s: "→ 카메라 영상에서 사다리꼴로 왜곡되어 보임", size: 13 },
  ]);
  cap(s, "\\r{(a)} 보정 전: 카메라 좌표축과 디바이스 배치가 어긋난 상태");
}

// ================= (b) after (as in the sketch) =================
{
  const s = pres.addSlide(); s.background = { color: WH };
  poly(s, [[PL.u0, PL.v1], [PL.u1, PL.v1], [PL.u1, PL.v0], [PL.u0, PL.v0]].map(([u, v]) => S(onC(u, v))), { fill: PLANE_FILL, color: PLANE_LINE, width: 1 });
  line(s, S(onC(PL.u0, 0)), S(onC(PL.u1, 0)), { color: G2, width: 1.25, dash: "dash" });
  line(s, S(onC(0, PL.v0)), S(onC(0, PL.v1)), { color: G2, width: 1.25, dash: "dash" });
  PH.forEach((p, i) => phone(s, p.o, p.x, p.y, i));
  const { tips } = drawCamera(s);
  line(s, tips.z, S(cpt), { color: G2, width: 2, dash: "dash" });
  frameAt(s, cpt, [
    [ru, 1.6, LRED, "\\b{r}_{u}", [-0.3, 0.35]],
    [rv, 1.35, LGREEN, "\\b{r}_{v}", [-0.3, 0.05]],
    [g, 2.3, LBLUE, "\\b{g}", [-0.05, 0.32]],
  ]);
  eqs(s, [
    { s: "공통 평면:  z = ax + by + d ,   \\b{g} = (a, b, −1)^{\\r{T}} / ‖(a, b, −1)^{\\r{T}}‖", size: 13 },
    { s: "\\b{r}_{u} = \\b{h} / ‖\\b{h}‖ ,  \\b{h} = \\b{e}_{x} − (\\b{e}_{x}^{\\r{T}}\\b{g})\\b{g} ,   \\b{r}_{v} = \\b{r}_{u} × \\b{g}", size: 13 },
    { s: "u_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}}\\b{r}_{u} ,   v_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}}\\b{r}_{v}", size: 13 },
  ]);
  cap(s, "\\r{(b)} 보정 후: 공통 평면과 평면 기준축 (\\b{r}_{u}, \\b{r}_{v}, \\b{g})");
}
pres.writeFile({ fileName: "common_plane_style.pptx" }).then(() => console.log("written"));
