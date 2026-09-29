const pptxgen = require("pptxgenjs");
const fs = require("fs");
const { execSync } = require("child_process");

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
pres.title = "비디오 월 레이아웃 인식 피규어";

const K = "000000", G1 = "404040", G2 = "808080", G3 = "BFBFBF", G4 = "D9D9D9", G5 = "F2F2F2", WH = "FFFFFF";
const MATH = "Times New Roman", KO = "Malgun Gothic";
const SW = 13.333;

// ---------- math mini-markup ----------
// \b{..} bold, \r{..} roman, _{..} subscript, ^{..} superscript. Latin letters are italic by default.
function parseMath(src) {
  const runs = [];
  function push(t, st) {
    const last = runs[runs.length - 1];
    if (last && last.b === st.b && last.i === st.i && last.sub === st.sub && last.sup === st.sup && last.ko === st.ko) last.t += t;
    else runs.push({ t, ...st });
  }
  function group(s, i) { // s[i] === '{'
    let depth = 0, j = i;
    for (; j < s.length; j++) { if (s[j] === "{") depth++; else if (s[j] === "}") { depth--; if (depth === 0) break; } }
    return [s.slice(i + 1, j), j + 1];
  }
  function walk(s, st) {
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "\\" && "br".includes(s[i + 1]) && s[i + 2] === "{") {
        const [inner, nx] = group(s, i + 2);
        walk(inner, s[i + 1] === "b" ? { ...st, b: true } : { ...st, roman: true });
        i = nx; continue;
      }
      if ((c === "_" || c === "^") && s[i + 1] === "{") {
        const [inner, nx] = group(s, i + 1);
        walk(inner, c === "_" ? { ...st, sub: true } : { ...st, sup: true });
        i = nx; continue;
      }
      const ko = /[가-힣ㄱ-ㆎ]/.test(c);
      const latin = /[A-Za-z]/.test(c);
      push(c, { b: !!st.b, i: latin && !st.roman, sub: !!st.sub, sup: !!st.sup, ko });
      i++;
    }
  }
  walk(src, {});
  return runs;
}
function mathRuns(src, base = {}) {
  return parseMath(src).map((r) => ({
    text: r.t,
    options: {
      fontFace: r.ko ? KO : MATH, bold: r.b || !!base.bold, italic: r.i,
      subscript: r.sub, superscript: r.sup, color: base.color || K,
      ...(base.fontSize ? { fontSize: base.fontSize } : {}),
    },
  }));
}
// lines: array of strings (math markup) or {s, size, bold, color}
function T(slide, lines, x, y, w, h, o = {}) {
  if (!Array.isArray(lines)) lines = [lines];
  const runs = [];
  lines.forEach((ln, li) => {
    const spec = typeof ln === "string" ? { s: ln } : ln;
    const rr = mathRuns(spec.s, { bold: spec.bold, color: spec.color || o.color, fontSize: spec.size });
    if (li < lines.length - 1 && rr.length) rr[rr.length - 1].options.breakLine = true;
    runs.push(...rr);
  });
  slide.addText(runs, {
    x, y, w, h, margin: 0, isTextBox: true, fontFace: MATH,
    fontSize: o.size || 14, align: o.align || "center", valign: o.valign || "middle",
    color: o.color || K, paraSpaceAfter: o.para || 0, fit: "none",
  });
}
const Tc = (s, t, cx, cy, w, h, o) => T(s, t, cx - w / 2, cy - h / 2, w, h, o);

// ---------- geometry helpers ----------
function line(s, x1, y1, x2, y2, o = {}) {
  s.addShape(pres.shapes.LINE, {
    x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    flipH: x2 < x1, flipV: y2 < y1,
    line: {
      color: o.color || K, width: o.width || 1.25, dashType: o.dash || "solid",
      endArrowType: o.arrow ? "triangle" : undefined, beginArrowType: o.arrow2 ? "triangle" : undefined,
    },
  });
}
const arrow = (s, x1, y1, x2, y2, o = {}) => line(s, x1, y1, x2, y2, { ...o, arrow: true });
function poly(s, pts, o = {}) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  s.addShape(pres.shapes.CUSTOM_GEOMETRY, {
    x: x0, y: y0, w: Math.max(...xs) - x0 || 0.01, h: Math.max(...ys) - y0 || 0.01,
    points: [...pts.map((p) => ({ x: p[0] - x0, y: p[1] - y0 })), { close: true }],
    fill: o.fill ? { color: o.fill } : { type: "none" },
    line: o.noLine ? { type: "none" } : { color: o.color || K, width: o.width || 1.25, dashType: o.dash || "solid" },
  });
}
function dot(s, x, y, r = 0.06, o = {}) {
  const shape = o.shape === "sq" ? pres.shapes.RECTANGLE : o.shape === "tri" ? pres.shapes.ISOSCELES_TRIANGLE : pres.shapes.OVAL;
  s.addShape(shape, { x: x - r, y: y - r, w: 2 * r, h: 2 * r, fill: { color: o.fill || K }, line: { color: K, width: 1 } });
}
function badge(s, n, cx, cy, r = 0.19) {
  s.addShape(pres.shapes.OVAL, { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: { color: K }, line: { color: K } });
  s.addText(String(n), { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, margin: 0, isTextBox: true, fontFace: "Arial", bold: true, fontSize: 12, color: WH, align: "center", valign: "middle" });
}
function caption(s, text) {
  T(s, [{ s: text, size: 12, color: G1 }], 0.5, 6.85, SW - 1, 0.4, { color: G1 });
}
function panelTitle(s, text, x, y, w) {
  s.addText(text, { x, y, w, h: 0.35, margin: 0, isTextBox: true, fontFace: KO, bold: true, fontSize: 14, color: K, align: "left", valign: "middle" });
}
// bilinear map inside quad [TL,TR,BR,BL]; (s,t) in [0,1], s: left→right, t: top→bottom
function bil(q, s, t) {
  const [a, b, c, d] = q;
  const top = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
  const bot = [d[0] + (c[0] - d[0]) * s, d[1] + (c[1] - d[1]) * s];
  return [top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t];
}
// ArUco-like 6x6 marker (black border + 4x4 payload) mapped into quad
const PAY = ["1011", "0110", "1001", "0101"];
function marker(s, q) {
  poly(s, q, { fill: K, noLine: true });
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (PAY[r][c] !== "0") continue;
    const s0 = (c + 1) / 6, s1 = (c + 2) / 6, t0 = (r + 1) / 6, t1 = (r + 2) / 6;
    poly(s, [bil(q, s0, t0), bil(q, s1, t0), bil(q, s1, t1), bil(q, s0, t1)], { fill: WH, noLine: true });
  }
}
// axis arrow starting at (x,y) in direction (dx,dy); first `hide` portion drawn white (over the marker)
function axis(s, x, y, dx, dy, len, hide, o = {}) {
  const n = Math.hypot(dx, dy); dx /= n; dy /= n;
  if (hide > 0) line(s, x, y, x + dx * hide, y + dy * hide, { color: WH, width: o.width || 2 });
  arrow(s, x + dx * hide, y + dy * hide, x + dx * len, y + dy * len, { width: o.width || 2, color: o.color });
}
// 3D camera drawn as projected, shaded polygons (orthographic, painter's order).
// Local frame: X right, Y up, Z = optical axis. (x,y) on slide = lens-tip centre.
// yaw/pitch (deg) orient the camera relative to the viewer; defaults match Fig. 2.
function camera(s, x, y, sc = 1, view = {}) {
  const yaw = ((view.yaw ?? 50) * Math.PI) / 180, pit = ((view.pitch ?? -30) * Math.PI) / 180;
  const lw = view.lw ?? (sc > 1.5 ? 1.25 : 0.75);
  const rot = ([px, py, pz]) => {
    const x1 = px * Math.cos(yaw) + pz * Math.sin(yaw), z1 = -px * Math.sin(yaw) + pz * Math.cos(yaw);
    return [x1, py * Math.cos(pit) - z1 * Math.sin(pit), py * Math.sin(pit) + z1 * Math.cos(pit)];
  };
  const tip = rot([0, 0, 0.26]);
  const scr = (p) => { const r = rot(p); return [x + sc * (r[0] - tip[0]), y - sc * (r[1] - tip[1])]; };
  const L = [-0.45, 0.7, -0.55], Ln = Math.hypot(...L);
  const gray = (n, base, span) => {
    const r = rot(n), d = Math.max(0, (r[0] * L[0] + r[1] * L[1] + r[2] * L[2]) / Ln);
    const g = Math.round(base + span * (0.3 + 0.7 * d));
    return g.toString(16).padStart(2, "0").toUpperCase().repeat(3);
  };
  const facing = (n) => rot(n)[2] < -1e-6;
  const face = (pts, n, base, span, outline = true) => {
    if (!facing(n)) return;
    const c = gray(n, base, span);
    poly(s, pts.map(scr), { fill: c, color: outline ? K : c, width: outline ? lw : 0.5 });
  };
  const box = (x0, x1, y0, y1, z0, z1, base, span) => () => {
    const P = (a, b, c) => [a ? x1 : x0, b ? y1 : y0, c ? z1 : z0];
    face([P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0)], [0, 0, -1], base, span);
    face([P(0, 0, 1), P(0, 1, 1), P(1, 1, 1), P(1, 0, 1)], [0, 0, 1], base, span);
    face([P(0, 0, 0), P(0, 1, 0), P(0, 1, 1), P(0, 0, 1)], [-1, 0, 0], base, span);
    face([P(1, 0, 0), P(1, 0, 1), P(1, 1, 1), P(1, 1, 0)], [1, 0, 0], base, span);
    face([P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1)], [0, 1, 0], base, span);
    face([P(0, 0, 0), P(0, 0, 1), P(1, 0, 1), P(1, 0, 0)], [0, -1, 0], base, span);
  };
  // cylinder along an axis ('z' = optical axis, 'y' = vertical button)
  const cyl = (c, r, a0, a1, axis, base, span, glass) => () => {
    const N = 28;
    const pt = (t, a) => axis === "z" ? [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t), a] : [c[0] + r * Math.cos(t), a, c[2] + r * Math.sin(t)];
    const nrm = (t) => axis === "z" ? [Math.cos(t), Math.sin(t), 0] : [Math.cos(t), 0, Math.sin(t)];
    const ring = (a) => Array.from({ length: N }, (_, k) => pt((2 * Math.PI * k) / N, a));
    const capN0 = axis === "z" ? [0, 0, -1] : [0, -1, 0], capN1 = axis === "z" ? [0, 0, 1] : [0, 1, 0];
    for (let k = 0; k < N; k++) {
      const t0 = (2 * Math.PI * k) / N, t1 = (2 * Math.PI * (k + 1)) / N;
      face([pt(t0, a0), pt(t1, a0), pt(t1, a1), pt(t0, a1)], nrm((t0 + t1) / 2), base, span, false);
    }
    // silhouette outline = convex hull of both end rings
    const hp = [...ring(a0), ...ring(a1)].map(scr).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of hp) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of [...hp].reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    poly(s, [...lo.slice(0, -1), ...up.slice(0, -1)], { color: K, width: lw });
    [[a0, capN0], [a1, capN1]].forEach(([a, n]) => {
      if (!facing(n)) return;
      poly(s, ring(a).map(scr), { fill: gray(n, base, span), color: K, width: lw });
      if (glass) {
        const g = (rr, zz) => Array.from({ length: N }, (_, k) => { const t = (2 * Math.PI * k) / N; return scr([c[0] + rr * Math.cos(t), c[1] + rr * Math.sin(t), zz]); });
        poly(s, g(r * 0.78, a), { fill: "1A1A1A", color: K, width: lw });
        poly(s, g(r * 0.5, a), { fill: "4D4D4D", noLine: true });
        const hl = Array.from({ length: 10 }, (_, k) => { const t = Math.PI * 0.55 + (k / 9) * Math.PI * 0.5; return scr([c[0] + r * 0.62 * Math.cos(t), c[1] + r * 0.62 * Math.sin(t), a]); });
        poly(s, hl, { fill: "D9D9D9", noLine: true });
      }
    });
  };
  const parts = [
    { c: [0, 0, -0.16], draw: box(-0.31, 0.31, -0.21, 0.21, -0.32, 0, 40, 140) },          // body
    { c: [-0.08, 0.25, -0.16], draw: box(-0.22, 0.06, 0.21, 0.29, -0.27, -0.05, 40, 140) }, // viewfinder hump
    { c: [0.2, 0.24, -0.13], draw: cyl([0.2, 0, -0.13], 0.045, 0.21, 0.27, "y", 90, 150) },   // shutter button
    { c: [0, 0, 0.08], draw: cyl([0, 0], 0.15, 0, 0.17, "z", 55, 150) },                     // lens barrel
    { c: [0, 0, 0.215], draw: cyl([0, 0], 0.175, 0.17, 0.26, "z", 30, 130, true) },           // lens hood
  ];
  parts.sort((a, b) => rot(b.c)[2] - rot(a.c)[2]).forEach((p) => p.draw());
  return (v) => { const r = rot(v); return [r[0], -r[1]]; }; // screen direction of a local axis
}

// ---------- shared device layout (plane units ~ cm, v up) ----------
const DEV = [
  { id: 1, w: 7, h: 14, c: [5, 19], th: 0 },
  { id: 2, w: 24, h: 16, c: [22, 20.5], th: -3 },
  { id: 3, w: 14, h: 7, c: [8, 4.5], th: 6 },
  { id: 4, w: 7, h: 14, c: [29.5, 2.5], th: 12 },
];
DEV.forEach((d) => {
  const t = (d.th * Math.PI) / 180, C = Math.cos(t), S = Math.sin(t);
  d.q = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([sx, sy]) => {
    const x = (sx * d.w) / 2, y = (sy * d.h) / 2;
    return [d.c[0] + C * x - S * y, d.c[1] + S * x + C * y];
  });
});
const all = DEV.flatMap((d) => d.q);
const umin = Math.min(...all.map((p) => p[0])), umax = Math.max(...all.map((p) => p[0]));
const vmin = Math.min(...all.map((p) => p[1])), vmax = Math.max(...all.map((p) => p[1]));
const Awall = (umax - umin) / (vmax - vmin), Avid = 16 / 9;
const sAdj = Awall / Avid; // < 1: wall taller than video → shrink u range
DEV.forEach((d) => {
  d.n = d.q.map(([u, v]) => [(u - umin) / (umax - umin), (v - vmin) / (vmax - vmin)]);
  d.a = d.n.map(([u, v]) => (sAdj < 1 ? [0.5 + sAdj * (u - 0.5), v] : [u, 0.5 + (v - 0.5) / sAdj]));
});
fs.writeFileSync("devices.json", JSON.stringify(DEV.map((d) => ({ id: d.id, w: d.w, h: d.h, quad: d.a }))));
execSync("python3 crops.py");

// ===================================================================
// Fig 1 — pipeline
// ===================================================================
{
  const s = pres.addSlide(); s.background = { color: WH };
  const bw = 2.75, gap = 0.45, x0 = (SW - (4 * bw + 3 * gap)) / 2, bh = 1.85;
  const rows = [1.3, 4.25];
  const steps = [
    ["등록", ["클라이언트 i ↔ 마커 \\r{ID}", "디스플레이 크기 (w_{i}, h_{i})"]],
    ["마커 표시", ["화면 중앙에 동일한 크기·방향", "마커 한 변 L = 6 \\r{cm}"]],
    ["마커 검출·자세 추정", ["네 정점 좌표 + 실제 크기 + 보정 결과", { s: "→  \\b{R}_{i} ,  \\b{t}_{i}", size: 16 }]],
    ["화면 정점 계산", [{ s: "\\b{p}_{i,k}^{\\r{cam}} = \\b{R}_{i} \\b{p}_{i,k}^{\\r{device}} + \\b{t}_{i}", size: 15 }, "k ∈ {\\r{TL, TR, BR, BL}}"]],
    ["공통 평면 추정", [{ s: "z = ax + by + d", size: 16 }, "깊이 오차 제곱합 최소화"]],
    ["평면 2차원 좌표 변환", ["평면 축 \\b{r}_{1}, \\b{r}_{2} 와 기준점 \\b{c}", { s: "u_{i,k} , v_{i,k}", size: 16 }]],
    ["정규화·종횡비 조정", [{ s: "û_{i,k} , v̂_{i,k} ∈ [0, 1]", size: 16 }, "영상 비율에 맞춰 중심 기준 축소"]],
    ["영역 전달·출력", ["정점 좌표를 클라이언트로 전달", "할당 영역을 잘라 화면에 출력"]],
  ];
  steps.forEach(([title, body], idx) => {
    const r = Math.floor(idx / 4), c = idx % 4;
    const x = x0 + c * (bw + gap), y = rows[r];
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: bw, h: bh, rectRadius: 0.08, fill: { color: r === 0 ? WH : G5 }, line: { color: K, width: 1.5 } });
    badge(s, idx + 1, x + 0.35, y + 0.35);
    s.addText(title, { x: x + 0.62, y: y + 0.17, w: bw - 0.75, h: 0.36, margin: 0, isTextBox: true, fontFace: KO, bold: true, fontSize: 14, color: K, valign: "middle" });
    T(s, body.map((b) => (typeof b === "string" ? { s: b, size: 12 } : b)), x + 0.15, y + 0.65, bw - 0.3, bh - 0.8, { para: 6 });
    if (c < 3) arrow(s, x + bw + 0.04, y + bh / 2, x + bw + gap - 0.04, y + bh / 2, { width: 2 });
  });
  // row 1 → row 2 connector
  const x4c = x0 + 3 * (bw + gap) + bw / 2, x5c = x0 + bw / 2, yb = rows[0] + bh, ym = 3.55;
  line(s, x4c, yb + 0.04, x4c, ym, { width: 2 });
  line(s, x4c, ym, x5c, ym, { width: 2 });
  arrow(s, x5c, ym, x5c, rows[1] - 0.04, { width: 2 });
  // group labels
  s.addText("A. 디바이스별 추정  (i = 1, …, N 각각 독립 수행)", { x: x0, y: 0.8, w: 6, h: 0.35, margin: 0, isTextBox: true, fontFace: KO, bold: true, fontSize: 13, color: G1 });
  s.addText("B. 전체 배치 통합  (공통 좌표계 · 하나의 가상 화면)", { x: x5c + 0.15, y: 3.7, w: 6, h: 0.35, margin: 0, isTextBox: true, fontFace: KO, bold: true, fontSize: 13, color: G1 });
  // pre-calibration
  const x3 = x0 + 2 * (bw + gap);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x3 - 0.1, y: 0.3, w: bw + 0.2 + bw * 0.75, h: 0.62, rectRadius: 0.06, fill: { color: WH }, line: { color: K, width: 1.25, dashType: "dash" } });
  T(s, [{ s: "사전 카메라 보정 → 내부 파라미터 \\b{K}, 렌즈 왜곡 계수 \\b{D}", size: 12 }], x3, 0.3, bw + bw * 0.75, 0.62);
  arrow(s, x3 + bw / 2, 0.92, x3 + bw / 2, rows[0] - 0.04, { width: 1.5, dash: "dash" });
  caption(s, "그림 1. 마커 기반 비디오 월 레이아웃 인식의 전체 과정");
}

// ===================================================================
// Fig 2 — device frame & marker pose
// ===================================================================
{
  const s = pres.addSlide(); s.background = { color: WH };
  panelTitle(s, "(a) 디바이스 기준 좌표계", 0.6, 0.3, 5);
  panelTitle(s, "(b) 카메라 좌표계로의 변환", 7.0, 0.3, 5.5);
  // --- (a)
  const cx = 3.0, cy = 3.35, w = 2.4, h = 3.6, m = 1.0;
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: cx - w / 2 - 0.15, y: cy - h / 2 - 0.3, w: w + 0.3, h: h + 0.6, rectRadius: 0.2, fill: { color: G4 }, line: { color: K, width: 1.25 } });
  s.addShape(pres.shapes.RECTANGLE, { x: cx - w / 2, y: cy - h / 2, w, h, fill: { color: WH }, line: { color: K, width: 1.5 } });
  marker(s, [[cx - m / 2, cy - m / 2], [cx + m / 2, cy - m / 2], [cx + m / 2, cy + m / 2], [cx - m / 2, cy + m / 2]]);
  axis(s, cx, cy, 1, 0, 1.05, m / 2);
  axis(s, cx, cy, 0, -1, 1.1, m / 2);
  dot(s, cx, cy, 0.05, { fill: WH });
  Tc(s, "x", cx + 1.12, cy - 0.17, 0.3, 0.3, { size: 16 });
  Tc(s, "y", cx + 0.17, cy - 1.13, 0.3, 0.3, { size: 16 });
  // marker size
  line(s, cx - m / 2, cy + m / 2 + 0.15, cx + m / 2, cy + m / 2 + 0.15, { arrow: true, arrow2: true, width: 1 });
  Tc(s, "L = 6 \\r{cm}", cx, cy + m / 2 + 0.38, 1.4, 0.3, { size: 13 });
  // corners
  const L = cx - w / 2, R = cx + w / 2, Tp = cy - h / 2, B = cy + h / 2;
  [[L, Tp], [R, Tp], [R, B], [L, B]].forEach(([x, y]) => dot(s, x, y, 0.07));
  Tc(s, "\\r{TL} (−w_{i}/2, +h_{i}/2, 0)", L + 0.1, Tp - 0.55, 2.3, 0.32, { size: 13 });
  Tc(s, "\\r{TR} (+w_{i}/2, +h_{i}/2, 0)", R + 0.2, Tp - 0.55, 2.3, 0.32, { size: 13 });
  Tc(s, "\\r{BL} (−w_{i}/2, −h_{i}/2, 0)", L + 0.1, B + 0.55, 2.3, 0.32, { size: 13 });
  Tc(s, "\\r{BR} (+w_{i}/2, −h_{i}/2, 0)", R + 0.2, B + 0.55, 2.3, 0.32, { size: 13 });
  // dimensions
  line(s, L, B + 0.9, R, B + 0.9, { arrow: true, arrow2: true, width: 1 });
  Tc(s, "w_{i}", cx, B + 1.12, 0.6, 0.3, { size: 16 });
  line(s, L - 0.45, Tp, L - 0.45, B, { arrow: true, arrow2: true, width: 1 });
  Tc(s, "h_{i}", L - 0.75, cy, 0.5, 0.3, { size: 16 });
  // (a) → (b)
  arrow(s, 5.35, 3.2, 6.55, 3.2, { width: 3 });
  Tc(s, "\\b{R}_{i} ,  \\b{t}_{i}", 5.95, 2.85, 1.3, 0.35, { size: 17 });
  Tc(s, "마커 자세", 5.95, 3.55, 1.3, 0.3, { size: 12 });
  // --- (b)
  const O = [7.55, 4.35];
  // device in perspective
  const q = [[9.5, 1.35], [11.75, 1.05], [11.95, 4.1], [9.7, 4.4]];
  const qb = [bil(q, -0.06, -0.075), bil(q, 1.06, -0.075), bil(q, 1.06, 1.075), bil(q, -0.06, 1.075)];
  poly(s, qb, { fill: G4 });
  poly(s, q, { fill: WH, width: 1.5 });
  const ms = m / w / 2, mt = m / h / 2;
  marker(s, [bil(q, 0.5 - ms, 0.5 - mt), bil(q, 0.5 + ms, 0.5 - mt), bil(q, 0.5 + ms, 0.5 + mt), bil(q, 0.5 - ms, 0.5 + mt)]);
  const Cc = bil(q, 0.5, 0.5);
  // t_i
  arrow(s, O[0] + 0.05, O[1] - 0.05, O[0] + 0.83 * (Cc[0] - O[0]), O[1] + 0.83 * (Cc[1] - O[1]), { width: 1.75, dash: "dash" });
  Tc(s, "\\b{t}_{i}", 8.95, 3.2, 0.45, 0.35, { size: 18 });
  // local axes (rotated by R_i)
  const ex = [q[1][0] - q[0][0], q[1][1] - q[0][1]], ey = [q[0][0] - q[3][0], q[0][1] - q[3][1]];
  const hx = Math.hypot(...ex) * ms, hy = Math.hypot(...ey) * mt;
  axis(s, Cc[0], Cc[1], ex[0], ex[1], 0.95, hx * 1.02);
  axis(s, Cc[0], Cc[1], ey[0], ey[1], 0.95, hy * 1.02);
  dot(s, Cc[0], Cc[1], 0.05, { fill: WH });
  Tc(s, "\\b{R}_{i}", 11.45, 2.15, 0.45, 0.35, { size: 18 });
  // corners
  const names = ["TL", "TR", "BR", "BL"];
  const offs = [[-0.4, -0.35], [0.4, -0.3], [0.45, 0.32], [-0.4, 0.35]];
  q.forEach(([x, y], k) => {
    dot(s, x, y, 0.07);
    Tc(s, `\\b{p}_{i,\\r{${names[k]}}}^{\\r{cam}}`, x + offs[k][0], y + offs[k][1], 0.9, 0.32, { size: 14 });
  });
  // camera + axes
  // camera axes follow the 3D camera's projected frame (OpenCV: X right, Y down, Z optical axis)
  const cdir = camera(s, O[0], O[1], 1.45, { yaw: 58, pitch: -25 });
  [["X_{\\r{c}}", [1, 0, 0], 0.95], ["Y_{\\r{c}}", [0, -1, 0], 0.8], ["Z_{\\r{c}}", [0, 0, 1], 1.1]].forEach(([lab, v, len]) => {
    const [dx, dy] = cdir(v), n = Math.hypot(dx, dy), ux = dx / n, uy = dy / n;
    arrow(s, O[0], O[1], O[0] + ux * len, O[1] + uy * len, { width: 1.5 });
    Tc(s, lab, O[0] + ux * (len + 0.22), O[1] + uy * (len + 0.22) + (v[2] ? 0.28 : 0), 0.4, 0.3, { size: 14 });
  });
  Tc(s, "카메라", O[0] - 0.95, O[1] + 1.0, 0.8, 0.3, { size: 12 });
  // equation
  s.addShape(pres.shapes.RECTANGLE, { x: 7.0, y: 5.6, w: 5.8, h: 0.95, fill: { color: G5 }, line: { color: K, width: 1 } });
  T(s, [{ s: "\\b{p}_{i,k}^{\\r{cam}} = \\b{R}_{i} \\b{p}_{i,k}^{\\r{device}} + \\b{t}_{i} ,   k ∈ {\\r{TL, TR, BR, BL}}", size: 20 }], 7.0, 5.6, 5.8, 0.95);
  caption(s, "그림 2. 마커 자세 (\\b{R}_{i}, \\b{t}_{i})와 디스플레이 크기 (w_{i}, h_{i})를 이용한 화면 정점 계산");
}

// ===================================================================
// Fig 3 — common plane fitting (top-down cross-section)
// ===================================================================
{
  const s = pres.addSlide(); s.background = { color: WH };
  panelTitle(s, "(a) 위에서 본 단면 (카메라 → 디바이스 배치)", 0.6, 0.3, 7);
  const cam = [4.1, 5.35];
  const pl = (x) => 2.35 - 0.1 * (x - 0.9);
  const devs = [
    { x: [1.2, 2.8], e: [0.32, -0.02], shape: "ci", fill: K },
    { x: [3.4, 5.0], e: [-0.26, 0.18], shape: "sq", fill: WH },
    { x: [5.6, 7.2], e: [0.12, -0.3], shape: "tri", fill: G2 },
  ];
  // sight rays
  devs.forEach((d) => d.x.forEach((x, j) => line(s, cam[0], cam[1], x, pl(x) + d.e[j], { color: G3, width: 0.75, dash: "sysDash" })));
  // fitted plane
  line(s, 0.7, pl(0.7), 7.6, pl(7.6), { width: 2.5 });
  Tc(s, "공통 평면   z = ax + by + d", 2.3, pl(2.2) - 0.85, 3.2, 0.35, { size: 15 });
  line(s, 2.3, pl(2.2) - 0.66, 2.2, pl(2.2) - 0.04, { width: 0.75 });
  devs.forEach((d, i) => {
    const p = d.x.map((x, j) => [x, pl(x) + d.e[j]]);
    line(s, p[0][0], p[0][1], p[1][0], p[1][1], { color: G2, width: 5 });
    p.forEach(([x, y]) => {
      line(s, x, y, x, pl(x), { width: 1, dash: "dash" });
      dot(s, x, y, 0.09, { shape: d.shape === "ci" ? undefined : d.shape, fill: d.fill });
    });
    Tc(s, `디바이스 ${i + 1}`, (p[0][0] + p[1][0]) / 2, Math.max(p[0][1], p[1][1]) + 0.55, 1.4, 0.3, { size: 12 });
  });
  // annotate one residual
  const ax = devs[1].x[0], ay = pl(ax) + devs[1].e[0];
  Tc(s, "e_{i,k}", ax - 0.42, ay - 0.08, 0.5, 0.3, { size: 15 });
  // axes & camera
  camera(s, cam[0], cam[1], 1.1, { yaw: 25, pitch: -62 });
  arrow(s, 0.8, 6.25, 1.6, 6.25, { width: 1.5 });
  arrow(s, 0.8, 6.25, 0.8, 5.45, { width: 1.5 });
  Tc(s, "x", 1.75, 6.25, 0.25, 0.3, { size: 15 });
  Tc(s, "z (깊이)", 1.25, 5.35, 0.9, 0.3, { size: 13 });
  // legend
  dot(s, 0.8, 1.02, 0.08);
  T(s, [{ s: "개별 마커로 추정한 화면 정점 (기호별 디바이스)", size: 12 }], 0.98, 0.87, 4.1, 0.3, { align: "left" });
  line(s, 5.3, 1.02, 5.7, 1.02, { dash: "dash", width: 1 });
  T(s, [{ s: "깊이 방향 오차", size: 12 }], 5.8, 0.87, 1.6, 0.3, { align: "left" });
  // --- (b) equations
  panelTitle(s, "(b) 최소제곱 평면 추정", 8.1, 0.3, 4.5);
  const cards = [
    ["화면 정점 (카메라 좌표계)", "\\b{p}_{i,k}^{\\r{cam}} = (x_{i,k}, y_{i,k}, z_{i,k})^{\\r{T}}"],
    ["공통 평면", "z = ax + by + d"],
    ["깊이 방향 오차", "e_{i,k} = z_{i,k} − (ax_{i,k} + by_{i,k} + d)"],
    ["평면 계수 결정", "(a, b, d) = \\r{arg min}_{a,b,d} Σ_{i} Σ_{k} e_{i,k}^{2}"],
  ];
  cards.forEach(([hd, eq], i) => {
    const y = 0.9 + i * 1.35;
    s.addShape(pres.shapes.RECTANGLE, { x: 8.1, y, w: 4.75, h: 1.15, fill: { color: G5 }, line: { color: G3, width: 0.75 } });
    badge(s, i + 1, 8.4, y + 0.3, 0.16);
    s.addText(hd, { x: 8.65, y: y + 0.12, w: 4, h: 0.36, margin: 0, isTextBox: true, fontFace: KO, bold: true, fontSize: 12, color: K, valign: "middle" });
    T(s, [{ s: eq, size: 17 }], 8.25, y + 0.5, 4.5, 0.55);
    if (i < cards.length - 1) arrow(s, 10.47, y + 1.15, 10.47, y + 1.35, { width: 1.25 });
  });
  caption(s, "그림 3. 모든 화면 정점의 깊이 오차 제곱합을 최소화하는 공통 평면 추정");
}

// ===================================================================
// Fig 4 — in-plane axes and 2D projection
// ===================================================================
{
  const s = pres.addSlide(); s.background = { color: WH };
  panelTitle(s, "(a) 공통 평면 위의 기준축과 투영", 0.6, 0.3, 7);
  const c = [4.1, 4.3], a1 = [0.8, -0.13], a2 = [-0.36, -0.46];
  const P = (u, v) => [c[0] + u * a1[0] + v * a2[0], c[1] + u * a1[1] + v * a2[1]];
  poly(s, [P(-3.3, -2.1), P(3.3, -2.1), P(3.3, 2.1), P(-3.3, 2.1)], { fill: G5, color: G2 });
  T(s, [{ s: "공통 평면", size: 12, color: G1 }], 0.75, 3.35, 1.0, 0.3, { align: "left", color: G1 });
  // devices lying on plane
  const dq = [[-2.9, -1.3, -1.8, 0.5], [-0.8, 1.2, 0.2, 1.8], [1.5, 2.9, -1.7, 0.2]];
  dq.forEach(([u0, u1, v0, v1]) => {
    const qq = [P(u0, v1), P(u1, v1), P(u1, v0), P(u0, v0)];
    poly(s, qq, { fill: WH, color: G2, width: 1 });
    qq.forEach(([x, y]) => dot(s, x, y, 0.04, { fill: G2 }));
  });
  // axis lines through c
  const r1a = P(-3.3, 0), r1b = P(3.3, 0), r2a = P(0, -2.1), r2b = P(0, 2.1);
  line(s, r1a[0], r1a[1], r1b[0], r1b[1], { color: G2, width: 0.75, dash: "sysDash" });
  line(s, r2a[0], r2a[1], r2b[0], r2b[1], { color: G2, width: 0.75, dash: "sysDash" });
  // point p & projections
  const pu = -1.3, pv = -1.8, p = P(pu, pv), fu = P(pu, 0), fv = P(0, pv);
  line(s, p[0], p[1], fu[0], fu[1], { dash: "dash", width: 1 });
  line(s, p[0], p[1], fv[0], fv[1], { dash: "dash", width: 1 });
  dot(s, fu[0], fu[1], 0.05, { fill: WH });
  dot(s, fv[0], fv[1], 0.05, { fill: WH });
  dot(s, p[0], p[1], 0.08);
  Tc(s, "\\b{p}_{i,k}^{\\r{cam}}", p[0] - 0.35, p[1] + 0.3, 0.9, 0.35, { size: 16 });
  // u and v brackets
  const U = (t) => [c[0] + t * pu * a1[0], c[1] + t * pu * a1[1] - 0.22];
  line(s, U(0.05)[0], U(0.05)[1], U(0.95)[0], U(0.95)[1], { arrow: true, arrow2: true, width: 1 });
  Tc(s, "u_{i,k}", (U(0)[0] + U(1)[0]) / 2, (U(0)[1] + U(1)[1]) / 2 - 0.22, 0.6, 0.3, { size: 15 });
  const V0 = [c[0] + 0.25, c[1]], V1 = [fv[0] + 0.25, fv[1]];
  line(s, V0[0] + 0.03, V0[1] + 0.05, V1[0] - 0.02, V1[1] - 0.03, { arrow: true, arrow2: true, width: 1 });
  Tc(s, "v_{i,k}", (V0[0] + V1[0]) / 2 + 0.35, (V0[1] + V1[1]) / 2, 0.6, 0.3, { size: 15 });
  // r1, r2, n, e_x
  const r1t = P(2.4, 0), r2t = P(0, 1.9);
  arrow(s, c[0], c[1], r1t[0], r1t[1], { width: 2.75 });
  arrow(s, c[0], c[1], r2t[0], r2t[1], { width: 2.75 });
  Tc(s, "\\b{r}_{1}", r1t[0] + 0.05, r1t[1] + 0.3, 0.45, 0.35, { size: 18 });
  Tc(s, "\\b{r}_{2}", r2t[0] - 0.3, r2t[1] + 0.05, 0.45, 0.35, { size: 18 });
  const ext = [r1t[0], r1t[1] - 1.05];
  arrow(s, c[0], c[1], ext[0], ext[1], { width: 1.5, dash: "dash" });
  line(s, ext[0], ext[1], r1t[0], r1t[1] - 0.08, { width: 1, dash: "sysDot", arrow: true });
  Tc(s, "\\b{e}_{x} = (1, 0, 0)^{\\r{T}}", ext[0] + 0.15, ext[1] - 0.3, 1.9, 0.35, { size: 14 });
  Tc(s, "−(\\b{e}_{x}^{\\r{T}}\\b{n})\\b{n}", ext[0] + 0.85, (ext[1] + r1t[1]) / 2, 1.3, 0.35, { size: 14 });
  arrow(s, c[0], c[1], c[0], c[1] - 2.5, { width: 2.75 });
  Tc(s, "\\b{n}", c[0] + 0.25, c[1] - 2.45, 0.35, 0.35, { size: 18 });
  // right-angle mark
  poly(s, [P(0, 0), P(0.28, 0), P(0.28, 0.28), P(0, 0.28)], { color: K, width: 0.75 });
  dot(s, c[0], c[1], 0.08, { fill: WH });
  Tc(s, "\\b{c}", c[0] - 0.28, c[1] + 0.15, 0.3, 0.35, { size: 18 });
  // --- (b) equations
  panelTitle(s, "(b) 기준축 설정과 2차원 좌표", 8.1, 0.3, 4.5);
  const cards = [
    ["법선 벡터", "\\b{n} = (a, b, −1)^{\\r{T}} / ‖(a, b, −1)^{\\r{T}}‖"],
    ["수평축 (x축에서 법선 성분 제거)", "\\b{r}_{1} = \\b{h} / ‖\\b{h}‖,   \\b{h} = \\b{e}_{x} − (\\b{e}_{x}^{\\r{T}}\\b{n})\\b{n}"],
    ["수직축 (평면 위에서 수평축과 직교)", "\\b{r}_{2} = \\b{n} × \\b{r}_{1}"],
    ["기준점 (모든 정점의 평균)", "\\b{c} = (1/N) Σ_{i} Σ_{k} \\b{p}_{i,k}^{\\r{cam}}"],
    ["평면 좌표", "u_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}}\\b{r}_{1},   v_{i,k} = (\\b{p}_{i,k}^{\\r{cam}} − \\b{c})^{\\r{T}}\\b{r}_{2}"],
  ];
  cards.forEach(([hd, eq], i) => {
    const y = 0.85 + i * 1.12;
    s.addShape(pres.shapes.RECTANGLE, { x: 7.95, y, w: 4.95, h: 0.98, fill: { color: G5 }, line: { color: G3, width: 0.75 } });
    badge(s, i + 1, 8.22, y + 0.26, 0.15);
    s.addText(hd, { x: 8.45, y: y + 0.09, w: 4.3, h: 0.34, margin: 0, isTextBox: true, fontFace: KO, bold: true, fontSize: 12, color: K, valign: "middle" });
    T(s, [{ s: eq, size: i === 4 ? 13.5 : 15 }], 8.05, y + 0.45, 4.75, 0.45);
  });
  caption(s, "그림 4. 공통 평면의 기준축 (\\b{r}_{1}, \\b{r}_{2}) 설정과 화면 정점의 2차원 좌표 변환");
}

// ===================================================================
// Fig 5 — normalization & aspect-ratio adjustment
// ===================================================================
{
  const s = pres.addSlide(); s.background = { color: WH };
  const top = 0.85, boxH = 3.2;
  const pw = 3.75, gap = 0.55, px0 = (SW - (3 * pw + 2 * gap)) / 2;
  const PX = [px0, px0 + pw + gap, px0 + 2 * (pw + gap)];
  const heads = ["(a) 공통 평면 좌표 (u, v)", "(b) [0, 1] 범위로 정규화", "(c) 송출 영상 종횡비에 맞춤 조정"];
  heads.forEach((h, i) => panelTitle(s, h, PX[i], 0.3, pw));
  const drawDevs = (key, map) => DEV.forEach((d) => {
    const pts = d[key].map(map);
    poly(s, pts, { fill: G5, width: 1.25 });
    const cx = pts.reduce((a, p) => a + p[0], 0) / 4, cy = pts.reduce((a, p) => a + p[1], 0) / 4;
    s.addText(String(d.id), { x: cx - 0.15, y: cy - 0.15, w: 0.3, h: 0.3, margin: 0, isTextBox: true, fontFace: "Arial", bold: true, fontSize: 12, align: "center", valign: "middle" });
    pts.forEach(([x, y]) => dot(s, x, y, 0.035));
  });
  // (a)
  {
    const sc = Math.min((pw - 0.9) / (umax - umin), (boxH - 0.6) / (vmax - vmin));
    const ox = PX[0] + 0.55 + ((pw - 0.9) - sc * (umax - umin)) / 2, oy = top + 0.2 + sc * (vmax - vmin);
    const M = ([u, v]) => [ox + (u - umin) * sc, oy - (v - vmin) * sc];
    const b0 = M([umin, vmax]), b1 = M([umax, vmin]);
    s.addShape(pres.shapes.RECTANGLE, { x: b0[0], y: b0[1], w: b1[0] - b0[0], h: b1[1] - b0[1], fill: { type: "none" }, line: { color: K, width: 1, dashType: "dash" } });
    drawDevs("q", M);
    Tc(s, "u_{\\r{min}}", b0[0], b1[1] + 0.2, 0.7, 0.3, { size: 13 });
    Tc(s, "u_{\\r{max}}", b1[0], b1[1] + 0.2, 0.7, 0.3, { size: 13 });
    Tc(s, "v_{\\r{min}}", b0[0] - 0.33, b1[1] - 0.05, 0.6, 0.3, { size: 13 });
    Tc(s, "v_{\\r{max}}", b0[0] - 0.33, b0[1] + 0.05, 0.6, 0.3, { size: 13 });
  }
  // (b)
  const sq = 2.75;
  {
    const ox = PX[1] + (pw - sq) / 2 + 0.1, oy = top + 0.2 + sq;
    const M = ([u, v]) => [ox + u * sq, oy - v * sq];
    s.addShape(pres.shapes.RECTANGLE, { x: ox, y: oy - sq, w: sq, h: sq, fill: { type: "none" }, line: { color: K, width: 1, dashType: "dash" } });
    drawDevs("n", M);
    Tc(s, "0", ox, oy + 0.2, 0.3, 0.3, { size: 13 });
    Tc(s, "1", ox + sq, oy + 0.2, 0.3, 0.3, { size: 13 });
    Tc(s, "1", ox - 0.2, oy - sq, 0.3, 0.3, { size: 13 });
    Tc(s, "û", ox + sq / 2, oy + 0.22, 0.3, 0.3, { size: 15 });
    Tc(s, "v̂", ox - 0.38, oy - sq / 2, 0.3, 0.3, { size: 15 });
  }
  // (c)
  {
    const fw = pw - 0.2, fh = fw / Avid, ox = PX[2] + 0.1, oy = top + 0.2 + (sq - fh) / 2 + fh;
    const M = ([u, v]) => [ox + u * fw, oy - v * fh];
    s.addShape(pres.shapes.RECTANGLE, { x: ox, y: oy - fh, w: fw, h: fh, fill: { color: G4 }, line: { color: K, width: 1.5 } });
    const l = M([0.5 - sAdj / 2, 1]), r = M([0.5 + sAdj / 2, 0]);
    s.addShape(pres.shapes.RECTANGLE, { x: l[0], y: l[1], w: r[0] - l[0], h: r[1] - l[1], fill: { color: WH }, line: { color: K, width: 1, dashType: "dash" } });
    drawDevs("a", M);
    line(s, ox + fw / 2, oy - fh - 0.12, ox + fw / 2, oy + 0.12, { color: G2, width: 0.75, dash: "sysDash" });
    arrow(s, ox + 0.05, oy - fh - 0.15, l[0] - 0.02, oy - fh - 0.15, { width: 1.25 });
    arrow(s, ox + fw - 0.05, oy - fh - 0.15, r[0] + 0.02, oy - fh - 0.15, { width: 1.25 });
    Tc(s, "W", ox + fw / 2, oy + 0.22, 0.4, 0.3, { size: 14 });
    Tc(s, "H", ox + fw + 0.12, oy - fh / 2, 0.3, 0.3, { size: 14 });
    Tc(s, "0.5 − s/2", l[0] - 0.05, oy + 0.48, 0.95, 0.3, { size: 12 });
    Tc(s, "0.5 + s/2", r[0] + 0.05, oy + 0.48, 0.95, 0.3, { size: 12 });
  }
  arrow(s, PX[0] + pw + 0.05, top + 1.6, PX[1] - 0.05, top + 1.6, { width: 2.5 });
  arrow(s, PX[1] + pw + 0.05, top + 1.6, PX[2] - 0.05, top + 1.6, { width: 2.5 });
  // equations under panels
  const eqY = 4.55, eqH = 2.05;
  const eqs = [
    [{ s: "모든 화면 정점의 범위", size: 12, bold: true }, { s: "u_{\\r{min}} = \\r{min}_{i,k} u_{i,k},  u_{\\r{max}} = \\r{max}_{i,k} u_{i,k}", size: 14 }, { s: "v_{\\r{min}} = \\r{min}_{i,k} v_{i,k},  v_{\\r{max}} = \\r{max}_{i,k} v_{i,k}", size: 14 }],
    [{ s: "축별 독립 정규화", size: 12, bold: true }, { s: "û_{i,k} = (u_{i,k} − u_{\\r{min}}) / (u_{\\r{max}} − u_{\\r{min}})", size: 14 }, { s: "v̂_{i,k} = (v_{i,k} − v_{\\r{min}}) / (v_{\\r{max}} − v_{\\r{min}})", size: 14 }],
    [{ s: "A_{\\r{wall}} = (u_{\\r{max}} − u_{\\r{min}}) / (v_{\\r{max}} − v_{\\r{min}}),   A_{\\r{video}} = W / H", size: 12.5 }, { s: "세로로 긴 월 (A_{\\r{wall}} < A_{\\r{video}}):  s = A_{\\r{wall}} / A_{\\r{video}}", size: 12.5 }, { s: "ũ_{i,k} = 0.5 + s (û_{i,k} − 0.5)", size: 14 }, { s: "가로로 긴 월:  ṽ_{i,k} = 0.5 + (A_{\\r{video}} / A_{\\r{wall}}) (v̂_{i,k} − 0.5)", size: 12.5 }],
  ];
  eqs.forEach((ls, i) => {
    s.addShape(pres.shapes.RECTANGLE, { x: PX[i], y: eqY, w: pw, h: eqH, fill: { color: G5 }, line: { color: G3, width: 0.75 } });
    T(s, ls, PX[i] + 0.12, eqY + 0.1, pw - 0.24, eqH - 0.2, { para: 5 });
  });
  caption(s, "그림 5. 평면 좌표의 [0, 1] 정규화와 송출 영상 종횡비에 따른 좌표 범위 조정 (세로로 긴 비디오 월의 예)");
}

// ===================================================================
// Fig 6 — distribution & final wall
// ===================================================================
{
  const s = pres.addSlide(); s.background = { color: WH };
  panelTitle(s, "(a) 서버: 송출 영상과 디바이스별 할당 영역", 0.6, 0.3, 6);
  panelTitle(s, "(b) 클라이언트: 할당 영역 출력 결과", 7.45, 0.3, 5.5);
  const fw = 6.0, fh = fw * 9 / 16, ox = 0.6, oy = 1.0;
  s.addImage({ path: "frame.png", x: ox, y: oy, w: fw, h: fh });
  s.addShape(pres.shapes.RECTANGLE, { x: ox, y: oy, w: fw, h: fh, fill: { type: "none" }, line: { color: K, width: 1.5 } });
  const M = ([u, v]) => [ox + u * fw, oy + (1 - v) * fh];
  DEV.forEach((d) => {
    const pts = d.a.map(M);
    poly(s, pts, { color: WH, width: 4 });
    poly(s, pts, { color: K, width: 1.75 });
    const cx = pts.reduce((a, p) => a + p[0], 0) / 4, cy = pts.reduce((a, p) => a + p[1], 0) / 4;
    s.addShape(pres.shapes.OVAL, { x: cx - 0.17, y: cy - 0.17, w: 0.34, h: 0.34, fill: { color: WH }, line: { color: K, width: 1 } });
    s.addText(String(d.id), { x: cx - 0.17, y: cy - 0.17, w: 0.34, h: 0.34, margin: 0, isTextBox: true, fontFace: "Arial", bold: true, fontSize: 12, align: "center", valign: "middle" });
  });
  // TL/TR labels on device 2 as example
  const d2 = DEV[1].a.map(M);
  ["TL", "TR", "BR", "BL"].forEach((k, j) => {
    dot(s, d2[j][0], d2[j][1], 0.06, { fill: WH });
  });
  Tc(s, "(ũ_{2,\\r{TL}}, ṽ_{2,\\r{TL}})", d2[0][0] + 0.55, d2[0][1] - 0.2, 1.4, 0.3, { size: 12, color: K });
  T(s, [{ s: "서버 → 클라이언트 i :  { (ũ_{i,k}, ṽ_{i,k}) | k ∈ {\\r{TL, TR, BR, BL}} }", size: 15 }], ox, oy + fh + 0.3, fw, 0.4);
  T(s, [{ s: "클라이언트 i : 네 정점이 이루는 영역을 w_{i} × h_{i} 화면에 맞춰 출력", size: 13 }], ox, oy + fh + 0.8, fw, 0.4);
  arrow(s, 6.8, 2.7, 7.4, 2.7, { width: 3 });
  // (b) physical wall
  const bx0 = 7.6, by0 = 1.05, bw = 5.2, bh = 4.9;
  const sc = Math.min(bw / (umax - umin), bh / (vmax - vmin));
  const W2 = ([u, v]) => [bx0 + (bw - sc * (umax - umin)) / 2 + (u - umin) * sc, by0 + (vmax - v) * sc];
  DEV.forEach((d) => {
    const [cx, cy] = W2(d.c), w = d.w * sc, h = d.h * sc, bz = 0.07;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: cx - w / 2 - bz, y: cy - h / 2 - bz, w: w + 2 * bz, h: h + 2 * bz, rectRadius: 0.06, rotate: -d.th, fill: { color: "262626" }, line: { color: K, width: 0.75 } });
    s.addImage({ path: `crop${d.id}.png`, x: cx - w / 2, y: cy - h / 2, w, h, rotate: -d.th });
  });
  caption(s, "그림 6. 계산된 좌표의 전달과 각 디바이스의 할당 영역 출력");
}

// ===================================================================
// Camera 3D asset slide (for copy & reuse)
// ===================================================================
{
  const s = pres.addSlide(); s.background = { color: WH };
  panelTitle(s, "카메라 3D 도형 (편집 가능한 도형 · 복사하여 재사용)", 0.6, 0.3, 9);
  const views = [
    ["\\r{(a)} 그림 2 시점 (뒤·위에서)", { yaw: 58, pitch: -25 }, 2.9, 3.4],
    ["\\r{(b)} 그림 3 시점 (위를 향함)", { yaw: 25, pitch: -62 }, 6.45, 3.55],
    ["\\r{(c)} 정면 사선 시점 (렌즈 방향)", { yaw: 145, pitch: -22 }, 10.75, 4.2],
  ];
  views.forEach(([t, v, x, y], i) => {
    camera(s, x, y, 3.2, v);
    T(s, [{ s: t, size: 13 }], 0.6 + i * 4.15, 5.9, 3.9, 0.35);
  });
  caption(s, "그림 \\r{A}. 피규어에 사용한 3차원 카메라 도형");
}

pres.writeFile({ fileName: "videowall_figures.pptx" }).then(() => console.log("written"));
