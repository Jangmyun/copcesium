// Combined figure: camera frame {C}, device frame {D_i}, and common-plane frame (c; r_u, r_v, g)
// rendered from ONE 3D scene expressed in camera coordinates (OpenCV: X right, Y down, Z optical axis).
const pptxgen = require("pptxgenjs");
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";
pres.title = "공통 평면 정렬";

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
    const [x, y, z] = p;
    const x1 = x * Math.cos(ya) + z * Math.sin(ya), z1 = -x * Math.sin(ya) + z * Math.cos(ya);
    return [x1, y * Math.cos(pa) - z1 * Math.sin(pa), y * Math.sin(pa) + z1 * Math.cos(pa)];
  };
}

// ---------------- 3D camera model (box camera, lens front = optical centre at origin) ----------------
function cameraModel(s, O2, sc, rot, scrFn) { // rot: model(render frame, Y up) -> view; scrFn: optional model->slide projection
  const hex = (g) => Math.max(0, Math.min(255, Math.round(g))).toString(16).padStart(2, "0").toUpperCase().repeat(3);
  const L = [-0.45, 0.7, -0.55], Ln = Math.hypot(...L);
  const R = rot;
  const scr = scrFn || ((p) => { const r = R(p); return [O2[0] + sc * r[0], O2[1] - sc * r[1]]; });
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


module.exports = { pres, T, Tc, line, arrow, poly, dot, badge, makeView, cameraModel, add, sub, mul, dotp, cross, norm, K, G1, G2, G3, G4, G5, WH, KO, MATH };
