// Combined figure: camera frame {C}, device frame {D_i}, and common-plane frame (c; r_u, r_v, g)
// rendered from ONE 3D scene expressed in camera coordinates (OpenCV: X right, Y down, Z optical axis).
const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.title = "카메라·디바이스·공통 평면 좌표계";

const K = "000000", G1 = "404040", G2 = "808080", G3 = "BFBFBF", G4 = "D9D9D9", G5 = "F2F2F2", WH = "FFFFFF";
const MATH = "Times New Roman", KO = "Malgun Gothic";

// ---------------- vector helpers ----------------
const add = (a, b) => a.map((v, i) => v + b[i]), sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, s) => a.map((v) => v * s), dotp = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => mul(a, 1 / Math.hypot(...a));

// ---------------- math text (same mini-markup as build.js) ----------------
function parseMath(src) {
  const runs = [];
  const push = (t, st) => {
    const l = runs[runs.length - 1];
    if (l && l.b === st.b && l.i === st.i && l.sub === st.sub && l.sup === st.sup && l.ko === st.ko) l.t += t; else runs.push({ t, ...st });
  };
  const group = (s, i) => { let d = 0, j = i; for (; j < s.length; j++) { if (s[j] === "{") d++; else if (s[j] === "}" && --d === 0) break; } return [s.slice(i + 1, j), j + 1]; };
  const walk = (s, st) => {
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\" && "br".includes(s[i + 1]) && s[i + 2] === "{") { const [g, n] = group(s, i + 2); walk(g, s[i + 1] === "b" ? { ...st, b: true } : { ...st, roman: true }); i = n; continue; }
      if ((c === "_" || c === "^") && s[i + 1] === "{") { const [g, n] = group(s, i + 1); walk(g, c === "_" ? { ...st, sub: true } : { ...st, sup: true }); i = n; continue; }
      push(c, { b: !!st.b, i: /[A-Za-z]/.test(c) && !st.roman, sub: !!st.sub, sup: !!st.sup, ko: /[가-힣]/.test(c) });
      i++;
    }
  };
  walk(src, {});
  return runs;
}
function T(s, lines, x, y, w, h, o = {}) {
  if (!Array.isArray(lines)) lines = [lines];
  const runs = [];
  lines.forEach((ln, li) => {
    const sp = typeof ln === "string" ? { s: ln } : ln;
    const rr = parseMath(sp.s).map((r) => ({ text: r.t, options: { fontFace: r.ko ? KO : MATH, bold: r.b || !!sp.bold, italic: r.i, subscript: r.sub, superscript: r.sup, color: sp.color || o.color || K, ...(sp.size ? { fontSize: sp.size } : {}) } }));
    if (li < lines.length - 1 && rr.length) rr[rr.length - 1].options.breakLine = true;
    runs.push(...rr);
  });
  s.addText(runs, { x, y, w, h, margin: 0, isTextBox: true, fontFace: MATH, fontSize: o.size || 14, align: o.align || "center", valign: o.valign || "middle", color: o.color || K, paraSpaceAfter: o.para || 0 });
}
const Tc = (s, t, cx, cy, w, h, o) => T(s, t, cx - w / 2, cy - h / 2, w, h, o);

// ---------------- 2D drawing helpers ----------------
function line(s, a, b, o = {}) {
  s.addShape(pres.shapes.LINE, {
    x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]),
    flipH: b[0] < a[0], flipV: b[1] < a[1],
    line: { color: o.color || K, width: o.width || 1.25, dashType: o.dash || "solid", endArrowType: o.arrow ? "triangle" : undefined, beginArrowType: o.arrow2 ? "triangle" : undefined },
  });
}
const arrow = (s, a, b, o = {}) => line(s, a, b, { ...o, arrow: true });
function poly(s, pts, o = {}) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys);
  s.addShape(pres.shapes.CUSTOM_GEOMETRY, {
    x: x0, y: y0, w: Math.max(...xs) - x0 || 0.01, h: Math.max(...ys) - y0 || 0.01,
    points: [...pts.map((p) => ({ x: p[0] - x0, y: p[1] - y0 })), { close: true }],
    fill: o.fill ? { color: o.fill } : { type: "none" },
    line: o.noLine ? { type: "none" } : { color: o.color || K, width: o.width || 1, dashType: o.dash || "solid" },
  });
}
function dot(s, p, r = 0.06, fill = K) { s.addShape(pres.shapes.OVAL, { x: p[0] - r, y: p[1] - r, w: 2 * r, h: 2 * r, fill: { color: fill }, line: { color: K, width: 1 } }); }
function badge(s, n, cx, cy, r = 0.15) {
  s.addShape(pres.shapes.OVAL, { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: { color: K }, line: { color: K } });
  s.addText(String(n), { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, margin: 0, isTextBox: true, fontFace: "Arial", bold: true, fontSize: 11, color: WH, align: "center", valign: "middle" });
}
const PAY = ["1011", "0110", "1001", "0101"];
function marker(s, q) { // q = projected [TL,TR,BR,BL]; orthographic projection is affine, so bilinear mapping is exact
  const bil = (u, v) => { const t = add(q[0], mul(sub(q[1], q[0]), u)), b = add(q[3], mul(sub(q[2], q[3]), u)); return add(t, mul(sub(b, t), v)); };
  poly(s, q, { fill: K, noLine: true });
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (PAY[r][c] === "0")
    poly(s, [bil((c + 1) / 6, (r + 1) / 6), bil((c + 2) / 6, (r + 1) / 6), bil((c + 2) / 6, (r + 2) / 6), bil((c + 1) / 6, (r + 2) / 6)], { fill: WH, noLine: true });
}

// ---------------- projection (viewer behind-left-above the camera = rear 3/4) ----------------
const YAW = 50, PITCH = -18;
function makeView(yaw = YAW, pitch = PITCH) {
  const ya = (yaw * Math.PI) / 180, pa = (pitch * Math.PI) / 180;
  // input: camera coords (Y down) → render frame (Y up) → rotate → orthographic
  return (p) => {
    const [x, y, z] = [p[0], -p[1], p[2]];
    const x1 = x * Math.cos(ya) + z * Math.sin(ya), z1 = -x * Math.sin(ya) + z * Math.cos(ya);
    return [x1, y * Math.cos(pa) - z1 * Math.sin(pa), y * Math.sin(pa) + z1 * Math.cos(pa)];
  };
}

// ---------------- 3D camera model (box camera, lens front = optical centre at origin) ----------------
function cameraModel(s, O2, sc, rot) { // rot: model(render frame, Y up) -> view
  const hex = (g) => Math.max(0, Math.min(255, Math.round(g))).toString(16).padStart(2, "0").toUpperCase().repeat(3);
  const L = [-0.45, 0.7, -0.55], Ln = Math.hypot(...L);
  const R = (p) => rot([p[0], -p[1], p[2]]); // model given in render frame; rot expects camera coords
  const scr = (p) => { const r = R(p); return [O2[0] + sc * r[0], O2[1] - sc * r[1]]; };
  const lit = (n) => { const r = R(n); return Math.max(0, (r[0] * L[0] + r[1] * L[1] + r[2] * L[2]) / Ln); };
  const facing = (n) => R(n)[2] < -1e-6;
  const shade = (n, base, span) => hex(base + span * (0.3 + 0.7 * lit(n)));
  const parts = [];
  function solid(V, F, base, span, fills = []) {
    const c = V.reduce((a, v) => add(a, mul(v, 1 / V.length)), [0, 0, 0]);
    parts.push({ c, draw: () => F.forEach((f, fi) => {
      const P = f.map((i) => V[i]);
      let n = [0, 0, 0];
      P.forEach((a, i) => { const b = P[(i + 1) % P.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); });
      const fc = P.reduce((a, v) => add(a, mul(v, 1 / P.length)), [0, 0, 0]);
      if (dotp(sub(fc, c), n) < 0) n = mul(n, -1);
      if (facing(n)) poly(s, P.map(scr), { fill: fills[fi] || shade(n, base, span), width: 1 });
    }) });
  }
  const dz = -0.47;
  const bx = (x0, x1, y0, y1, z0, z1, base, span) => {
    const V = []; for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) V.push([x, y, z + dz]);
    solid(V, [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]], base, span);
  };
  bx(-0.42, 0.42, -0.32, 0.32, -1.1, 0, 55, 150);
  const b = 0.17, f = 0.32, z1 = 0.47;
  solid([[-b, -b, dz], [b, -b, dz], [b, b, dz], [-b, b, dz], [-f, -f, z1 + dz], [f, -f, z1 + dz], [f, f, z1 + dz], [-f, f, z1 + dz]],
    [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], 45, 150, [null, "262626"]);
  parts.sort((a, b2) => R(b2.c)[2] - R(a.c)[2]).forEach((p) => p.draw());
}

// ---------------- scene definition (camera coordinates, arbitrary unit ≈ 10 cm) ----------------
const P0 = [1.2, -0.4, 7.0];
// plane normal g points toward the camera (z < 0); plane turned about Y and tilted about X
const g = norm((() => { const a = (-22 * Math.PI) / 180, t = (-8 * Math.PI) / 180; let n = [0, 0, -1]; n = [n[0] * Math.cos(a) + n[2] * Math.sin(a), n[1], -n[0] * Math.sin(a) + n[2] * Math.cos(a)]; return [n[0], n[1] * Math.cos(t) - n[2] * Math.sin(t), n[1] * Math.sin(t) + n[2] * Math.cos(t)]; })());
const ex = [1, 0, 0];
const hvec = sub(ex, mul(g, dotp(ex, g)));
const ru = norm(hvec), rv = cross(g, ru); // rv = g × ru → "up" on the wall (−Y direction)
const onPlane = (u, v) => add(P0, add(mul(ru, u), mul(rv, v)));
const DEVS = [
  { id: "i", c: [-2.65, 0.25], w: 1.9, h: 3.2, th: 5 },
  { id: "2", c: [1.4, 1.2], w: 2.8, h: 1.75, th: -3 },
  { id: "3", c: [2.05, -1.55], w: 1.0, h: 1.9, th: 9 },
];
const MK = 0.62; // marker side (same physical size on every device)
DEVS.forEach((d) => {
  const t = (d.th * Math.PI) / 180;
  d.xd = add(mul(ru, Math.cos(t)), mul(rv, Math.sin(t)));
  d.yd = add(mul(ru, -Math.sin(t)), mul(rv, Math.cos(t)));
  d.zd = cross(d.xd, d.yd); // = g (toward the camera), as for an ArUco marker frame
  d.o = onPlane(...d.c);
  const P = (a, b) => add(d.o, add(mul(d.xd, a), mul(d.yd, b)));
  d.P = P;
  d.corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([sx, sy]) => P((sx * d.w) / 2, (sy * d.h) / 2));
  d.bezel = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([sx, sy]) => P(sx * (d.w / 2 + 0.12), sy * (d.h / 2 + 0.18)));
  d.mk = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([sx, sy]) => P((sx * MK) / 2, (sy * MK) / 2));
});
const allC = DEVS.flatMap((d) => d.corners);
const cpt = allC.reduce((a, p) => add(a, mul(p, 1 / allC.length)), [0, 0, 0]);
const uv = (p) => [dotp(sub(p, cpt), ru), dotp(sub(p, cpt), rv)];
const Us = allC.map((p) => uv(p)[0]), Vs = allC.map((p) => uv(p)[1]);
const pl = { u0: Math.min(...Us) - 0.65, u1: Math.max(...Us) + 0.65, v0: Math.min(...Vs) - 0.6, v1: Math.max(...Vs) + 0.6 };
const onC = (u, v) => add(cpt, add(mul(ru, u), mul(rv, v)));

// ---------------- draw the scene into a slide region ----------------
function drawScene(s, box, opt = {}) {
  const view = makeView();
  const camScale = opt.camScale || 1.8; // camera drawn larger than true scale (schematic)
  const keyPts = [[0, 0, 0], [-0.9, 0.9, -1.8].map((v) => v * camScale), ...[[pl.u0, pl.v0], [pl.u1, pl.v0], [pl.u1, pl.v1], [pl.u0, pl.v1]].map(([u, v]) => onC(u, v))];
  const raw = keyPts.map(view);
  const xs = raw.map((r) => r[0]), ys = raw.map((r) => r[1]);
  const sc = Math.min(box.w / (Math.max(...xs) - Math.min(...xs)), box.h / (Math.max(...ys) - Math.min(...ys)));
  const ox = box.x + (box.w - sc * (Math.max(...xs) - Math.min(...xs))) / 2 - sc * Math.min(...xs);
  const oy = box.y + (box.h - sc * (Math.max(...ys) - Math.min(...ys))) / 2 + sc * Math.max(...ys);
  const S = (p) => { const r = view(p); return [ox + sc * r[0], oy - sc * r[1]]; };
  const dir2 = (a, v, len) => S(add(a, mul(v, len)));
  const fs = opt.fs || 1; // font scale

  // common plane
  const plQ = [[pl.u0, pl.v1], [pl.u1, pl.v1], [pl.u1, pl.v0], [pl.u0, pl.v0]].map(([u, v]) => S(onC(u, v)));
  poly(s, plQ, { fill: G5, color: G2, width: 1 });
  T(s, [{ s: "공통 평면  z = ax + by + d", size: 12 * fs, color: G1 }], plQ[3][0] + 0.2, plQ[3][1] + 0.12, 2.6, 0.3, { align: "left", color: G1 });

  // devices
  DEVS.forEach((d) => {
    poly(s, d.bezel.map(S), { fill: G4, color: K, width: 1 });
    poly(s, d.corners.map(S), { fill: WH, color: K, width: 1.25 });
    marker(s, d.mk.map(S));
  });
  // plane axis lines through c
  line(s, S(onC(pl.u0, 0)), S(onC(pl.u1, 0)), { color: G2, width: 0.75, dash: "sysDash" });
  line(s, S(onC(0, pl.v0)), S(onC(0, pl.v1)), { color: G2, width: 0.75, dash: "sysDash" });

  // example projection of p_{i,BR}
  const Di = DEVS[0], p = Di.corners[2], [pu, pv] = uv(p);
  const fu = S(onC(pu, 0)), fv = S(onC(0, pv));
  line(s, S(p), fu, { dash: "dash", width: 1 });
  line(s, S(p), fv, { dash: "dash", width: 1 });
  dot(s, fu, 0.045, WH); dot(s, fv, 0.045, WH);
  const off = mul(rv, 0.3);
  line(s, S(add(onC(0, 0), off)), S(add(onC(pu, 0), off)), { arrow: true, arrow2: true, width: 0.75 });
  Tc(s, "u_{i,k}", ...S(add(onC(pu / 2, 0), mul(rv, 0.62))), 0.55, 0.28, { size: 13 * fs });
  const offv = mul(ru, 0.3);
  line(s, S(add(onC(0, 0), offv)), S(add(onC(0, pv), offv)), { arrow: true, arrow2: true, width: 0.75 });
  Tc(s, "v_{i,k}", ...S(add(onC(0, pv / 2), mul(ru, 0.68))), 0.55, 0.28, { size: 13 * fs });

  // device i: corners, labels, size, axes
  const lab = ["TL", "TR", "BR", "BL"], lo = [[-0.62, 0.3], [0.55, 0.12], [0.35, -0.42], [-0.62, -0.36]];
  Di.corners.forEach((q, k) => {
    dot(s, S(q), 0.065);
    const L2 = S(Di.P(Math.sign(lo[k][0]) * (Di.w / 2 + Math.abs(lo[k][0])), Math.sign(lo[k][1]) * (Di.h / 2 + Math.abs(lo[k][1]))));
    Tc(s, `\\b{p}_{i,\\r{${lab[k]}}}^{\\r{cam}}`, L2[0], L2[1], 0.85, 0.32, { size: 13 * fs });
  });
  DEVS.slice(1).forEach((d) => d.corners.forEach((q) => dot(s, S(q), 0.045, G2)));
  // w_i (above top edge) and h_i (left of left edge)
  const wa = S(Di.P(-Di.w / 2, Di.h / 2 + 0.42)), wb = S(Di.P(Di.w / 2, Di.h / 2 + 0.42));
  line(s, wa, wb, { arrow: true, arrow2: true, width: 0.75, color: G1 });
  Tc(s, "w_{i}", ...S(Di.P(0, Di.h / 2 + 0.66)), 0.4, 0.28, { size: 13 * fs });
  const ha = S(Di.P(-Di.w / 2 - 0.45, Di.h / 2)), hb = S(Di.P(-Di.w / 2 - 0.45, -Di.h / 2));
  line(s, ha, hb, { arrow: true, arrow2: true, width: 0.75, color: G1 });
  Tc(s, "h_{i}", ...S(Di.P(-Di.w / 2 - 0.75, 0)), 0.4, 0.28, { size: 13 * fs });
  // device axes (white where they cross the black marker)
  const O2 = S(Di.o);
  [[Di.xd, 1.05, "x_{i}", MK / 2], [Di.yd, 1.05, "y_{i}", MK / 2], [Di.zd, 1.0, "z_{i}", 0]].forEach(([v, len, name, hide]) => {
    const a = S(add(Di.o, mul(v, hide))), b = S(add(Di.o, mul(v, len)));
    if (hide) line(s, O2, a, { color: WH, width: 2 });
    arrow(s, a, b, { color: G1, width: 2 });
    const lb = S(add(add(Di.o, mul(v, len + (hide ? 0.2 : 0.45))), v === Di.xd ? mul(Di.yd, -0.3) : [0, 0, 0]));
    Tc(s, name, lb[0], lb[1], 0.4, 0.28, { size: 14 * fs, color: G1 });
  });
  dot(s, O2, 0.045, WH);

  // common-plane frame at c
  const C2 = S(cpt);
  const L_E = 2.7;
  const exTip = S(add(cpt, mul(ex, L_E))), hTip = S(add(cpt, mul(hvec, L_E)));
  arrow(s, C2, exTip, { dash: "dash", width: 1.25 });
  line(s, exTip, hTip, { dash: "sysDot", width: 1, arrow: true });
  Tc(s, "\\b{e}_{x}", exTip[0] + 0.28, exTip[1] + 0.02, 0.4, 0.28, { size: 15 * fs });
  arrow(s, C2, dir2(cpt, ru, 1.45), { width: 2.75 });
  arrow(s, C2, dir2(cpt, rv, 1.35), { width: 2.75 });
  arrow(s, C2, dir2(cpt, g, 1.6), { width: 2.75 });
  const ruL = dir2(cpt, ru, 1.5), rvL = dir2(cpt, rv, 1.62), gL = dir2(cpt, g, 1.9);
  Tc(s, "\\b{r}_{u}", ruL[0] + 0.05, ruL[1] - 0.3, 0.4, 0.3, { size: 17 * fs });
  Tc(s, "\\b{r}_{v}", rvL[0] - 0.22, rvL[1] + 0.3, 0.4, 0.3, { size: 17 * fs });
  Tc(s, "\\b{g}", gL[0], gL[1], 0.3, 0.3, { size: 17 * fs });
  poly(s, [S(cpt), S(add(cpt, mul(ru, 0.25))), S(add(cpt, add(mul(ru, 0.25), mul(rv, 0.25)))), S(add(cpt, mul(rv, 0.25)))], { width: 0.75 });
  dot(s, C2, 0.075, WH);
  Tc(s, "\\b{c}", C2[0] - 0.08, C2[1] + 0.25, 0.3, 0.3, { size: 17 * fs });

  // camera + frame {C}; t_i
  const Oc = S([0, 0, 0]);
  cameraModel(s, Oc, sc * camScale, view);
  arrow(s, Oc, S(add(Di.o, mul(sub([0, 0, 0], Di.o), 0.035))), { dash: "dash", width: 1.75, color: G1 });
  const tl = S(mul(Di.o, 0.45));
  Tc(s, "\\b{t}_{i}", tl[0] - 0.05, tl[1] - 0.25, 0.4, 0.3, { size: 17 * fs });
  const Rl = S(add(Di.o, add(mul(Di.xd, 0.5), mul(Di.yd, 0.55))));
  Tc(s, "\\b{R}_{i}", Rl[0] + 0.05, Rl[1], 0.45, 0.3, { size: 16 * fs });
  const camAx = [[[1, 0, 0], 1.3, "x_{\\r{c}}"], [[0, 1, 0], 0.75, "y_{\\r{c}}"], [[0, 0, 1], 1.2, "z_{\\r{c}}"]];
  camAx.forEach(([v, len, name]) => {
    const b = S(mul(v, len * camScale / 1.8 * 1.8));
    arrow(s, Oc, b, { width: 2.25 });
    const lb = S(mul(v, (len + 0.3) * camScale / 1.8 * 1.8));
    const at = v[2] ? [b[0] - 0.35, b[1] + 0.2] : lb;
    Tc(s, name, at[0], at[1], 0.4, 0.3, { size: 16 * fs });
  });
  dot(s, Oc, 0.05, WH);
  // frame names
  T(s, [{ s: "카메라 좌표계 {C}", size: 12 * fs, bold: true }], Oc[0] - 2.4, Oc[1] + 1.45, 2.2, 0.3, { align: "left" });
  T(s, [{ s: "디바이스 좌표계 {D_{i}}", size: 12 * fs, bold: true, color: G1 }], ...S(Di.P(0, -Di.h / 2 - 1.0)).map((v, i) => v - [1.2, 0.15][i]), 2.4, 0.3, {});
  const pc = S(onC(pl.u1 - 0.2, pl.v0 + 0.05));
  T(s, [{ s: "공통 평면 좌표계 (\\b{c}; \\b{r}_{u}, \\b{r}_{v})", size: 12 * fs, bold: true }], pc[0] - 3.1, pc[1] + 0.05, 3.1, 0.3, { align: "right" });
  return { S, sc };
}

// ---------------- slide 1: figure + explanation panel ----------------
{
  const s = pres.addSlide(); s.background = { color: WH };
  drawScene(s, { x: 0.35, y: 0.35, w: 8.55, h: 6.25 }, { camScale: 1.8, fs: 0.95 });
  const cards = [
    ["카메라 좌표계 {C}", ["원점: 카메라 광학 중심,  z_{\\r{c}}: 광축", "\\b{p}^{\\r{cam}}, \\b{t}_{i}, \\b{g}, \\b{r}_{u}, \\b{r}_{v} 는 모두 {C}에서 표현"]],
    ["디바이스 좌표계 {D_{i}}", ["원점: 화면(마커) 중심,  z_{i}: 화면 법선", "\\b{p}_{i,k}^{\\r{device}} = (±w_{i}/2, ±h_{i}/2, 0)^{\\r{T}}"]],
    ["{D_{i}} → {C} 변환 (마커 자세)", [{ s: "\\b{p}_{i,k}^{\\r{cam}} = \\b{R}_{i} \\b{p}_{i,k}^{\\r{device}} + \\b{t}_{i}", size: 15 }]],
    ["공통 평면 기준축", ["\\b{g} ∥ (a, b, −1)^{\\r{T}},   \\b{h} = \\b{e}_{x} − (\\b{e}_{x}^{\\r{T}}\\b{g})\\b{g}", "\\b{r}_{u} = \\b{h} / ‖\\b{h}‖,   \\b{r}_{v} = \\b{g} × \\b{r}_{u}"]],
    ["공통 평면 2차원 좌표", ["u_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}}\\b{r}_{u}", "v_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}}\\b{r}_{v}"]],
  ];
  const x0 = 9.1, cw = 3.95, ch = 1.14, gap = 0.12, y0 = 0.4;
  cards.forEach(([hd, body], i) => {
    const y = y0 + i * (ch + gap);
    s.addShape(pres.shapes.RECTANGLE, { x: x0, y, w: cw, h: ch, fill: { color: G5 }, line: { color: G3, width: 0.75 } });
    badge(s, i + 1, x0 + 0.24, y + 0.23);
    T(s, [{ s: hd, size: 12, bold: true }], x0 + 0.48, y + 0.07, cw - 0.6, 0.32, { align: "left" });
    T(s, body.map((b) => (typeof b === "string" ? { s: b, size: 13 } : b)), x0 + 0.12, y + 0.42, cw - 0.24, ch - 0.5, { para: 2 });
  });
  T(s, [{ s: "그림 3. 카메라 좌표계, 디바이스 좌표계와 공통 평면 좌표계의 관계", size: 12, color: G1 }], 0.5, 6.95, 12.3, 0.35, { color: G1 });
}
// ---------------- slide 2: figure only (for the paper, equations stay in the text) ----------------
{
  const s = pres.addSlide(); s.background = { color: WH };
  drawScene(s, { x: 0.8, y: 0.3, w: 11.7, h: 6.4 }, { camScale: 1.8, fs: 1.05 });
  T(s, [{ s: "그림 3. 카메라 좌표계, 디바이스 좌표계와 공통 평면 좌표계의 관계", size: 12, color: G1 }], 0.5, 6.95, 12.3, 0.35, { color: G1 });
}
pres.writeFile({ fileName: "coordinate_frames.pptx" }).then(() => console.log("written"));
