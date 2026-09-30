// Bakes the hero's dancing figure into ../assets/dancer_sprites.js.
//
//   node tools/make_dancer_sprites.mjs                 (rewrites assets/dancer_sprites.js)
//   node tools/make_dancer_sprites.mjs --png out.png   (also draws a contact sheet)
//
// Same approach as the running man in the midi-laser project: the dancer is a
// sprite sheet, not a rig bent at runtime. Every frame is a finished drawing:
//
//   1. A front-view body (head, neck, chest, waist, pelvis, arms, hands, legs,
//      feet) is built from smooth signed-distance shapes, in units of the
//      figure's standing height (1.0 = head to toe).
//   2. It's posed from a hand-authored 32-beat routine of key poses. Feet are planted
//      by solving each leg back from its foot, and limbs that swing toward
//      the viewer are foreshortened, the way a real body looks from the front.
//   3. The posed body's silhouette is traced (marching squares on the
//      distance field) and only its single OUTER contour is kept: one closed
//      line around the whole figure, never crossing itself, with no internal
//      lines where limbs overlap the body.
//   4. That contour is simplified and written out as integer coordinates
//      (1/1000ths of standing height), ground at y = 0, y pointing up.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_FILE = fileURLToPath(new URL('../assets/dancer_sprites.js', import.meta.url));
const FRAMES_PER_BEAT = 6;      // drawings per beat: about 12 a second at 116 bpm
const BPM = 116;
const UNITS = 1000;             // stored coordinates per standing height
const GRID = 0.002;             // silhouette sampling step, in standing heights
const SIMPLIFY_TOL = 0.002;     // Douglas-Peucker tolerance, in standing heights

const deg = Math.PI / 180;

// --- Signed-distance shapes -------------------------------------------------
// Each returns distance from (px, py) to the shape's edge: negative inside.

function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// Tapered capsule from a (radius ra) to b (radius rb): Inigo Quilez's "uneven capsule".
function roundCone(a, b, ra, rb) {
  const h = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-6);
  const tx = (b.x - a.x) / h, ty = (b.y - a.y) / h;
  const k = Math.max(-0.999, Math.min(0.999, (ra - rb) / h)), c = Math.sqrt(1 - k * k);
  return (px, py) => {
    const qx = px - a.x, qy = py - a.y;
    const ly = qx * tx + qy * ty;
    const lx = Math.abs(qx * -ty + qy * tx);
    const m = -k * lx + c * ly;
    if (m < 0) return Math.hypot(lx, ly) - ra;
    if (m > c * h) return Math.hypot(lx, ly - h) - rb;
    return lx * c + ly * k - ra;
  };
}

// Ellipse centred on c with semi-axes rx (along angle `rot`) and ry.
function ellipse(c, rx, ry, rot = 0) {
  const co = Math.cos(rot), si = Math.sin(rot);
  return (px, py) => {
    const dx = px - c.x, dy = py - c.y;
    const u = dx * co + dy * si, v = -dx * si + dy * co;
    const k0 = Math.hypot(u / rx, v / ry);
    const k1 = Math.hypot(u / (rx * rx), v / (ry * ry));
    return k0 < 1e-9 ? -Math.min(rx, ry) : k0 * (k0 - 1) / k1;
  };
}

function circle(c, r) { return (px, py) => Math.hypot(px - c.x, py - c.y) - r; }

function unionAll(shapes, k) {
  return (px, py) => {
    let d = shapes[0](px, py);
    for (let i = 1; i < shapes.length; i++) d = smin(d, shapes[i](px, py), k);
    return d;
  };
}

// --- Body --------------------------------------------------------------------
// Segment lengths in standing heights (standard anthropometric ratios).
const THIGH = 0.245, SHIN = 0.246, LEG = (THIGH + SHIN) * 0.995;
const UPPER_ARM = 0.178, FOREARM = 0.15;
const ANKLE_H = 0.046;          // ankle joint above the sole
const HIP_HALF = 0.05;          // hip joints either side of the pelvis centre

const rot = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
const add = (p, v, s = 1) => ({ x: p.x + v.x * s, y: p.y + v.y * s });

// A limb pointing `angle` degrees from straight down, swinging outward (away
// from the body's centre line) when positive. `out` is +1 for the figure's
// screen-right side and -1 for screen-left.
const limbDir = (angle, out) => ({ x: out * Math.sin(angle * deg), y: -Math.cos(angle * deg) });

// Pose:
//   sway      pelvis left/right                lean      spine, degrees toward screen right
//   drop      how far the hips sink            shTilt    shoulder line, + raises the right shoulder
//   hipTilt   + raises the right hip           headTilt  + tips the head toward screen right
//   footR/L   { x, lift, kneeUp }: kneeUp 1 lifts the knee toward the viewer
//   armR/L    { a, tilt, e, tiltF }: upper-arm angle from hanging, how far it swings toward the
//             viewer, elbow bend (outward +), and how far the forearm points at the viewer
function buildBody(p) {
  const ankle = { R: { x: p.footR.x, y: ANKLE_H + p.footR.lift }, L: { x: p.footL.x, y: ANKLE_H + p.footL.lift } };
  const tilt = p.hipTilt * deg;
  const hipOff = { R: rot({ x: HIP_HALF, y: -0.012 }, tilt), L: rot({ x: -HIP_HALF, y: -0.012 }, tilt) };
  // The pelvis sits as high as both legs allow, less the knee bend.
  const top = (side) => {
    const dx = ankle[side].x - (p.sway + hipOff[side].x);
    return ankle[side].y + Math.sqrt(Math.max(LEG * LEG - dx * dx, 0.02)) - hipOff[side].y;
  };
  const pc = { x: p.sway, y: Math.min(top('R'), top('L')) - p.drop };
  const hip = { R: add(pc, hipOff.R), L: add(pc, hipOff.L) };

  // Legs: solve the knee from hip and ankle. Knees bend toward the viewer, so
  // from the front the leg just looks shorter, with the knee drifting outward.
  const leg = (side, out) => {
    const h = hip[side], a = ankle[side];
    const dx = a.x - h.x, dy = a.y - h.y, dist = Math.hypot(dx, dy);
    const D = Math.min(dist, THIGH + SHIN - 1e-4);
    const along = (THIGH * THIGH - SHIN * SHIN + D * D) / (2 * D);
    const bend = Math.sqrt(Math.max(THIGH * THIGH - along * along, 0));
    const foot = p[side === 'R' ? 'footR' : 'footL'];
    // Planted or stepping: both halves of the leg shorten as the knee bends toward the viewer.
    const bent = { x: h.x + (dx / dist) * along + out * bend * 0.3, y: h.y + (dy / dist) * along + bend * 0.04 };
    // A knee lift: the thigh points at the viewer (so it nearly vanishes) and the shin hangs at full length.
    const raised = { x: a.x - (dx / dist) * SHIN + out * 0.02, y: a.y - (dy / dist) * SHIN };
    const knee = { x: bent.x + (raised.x - bent.x) * foot.kneeUp, y: bent.y + (raised.y - bent.y) * foot.kneeUp };
    const lifted = foot.lift;
    const onToe = Math.min(1, lifted / 0.02);       // a lifted foot hangs toe-down
    const sole = { x: a.x + out * 0.012, y: a.y - 0.024 - onToe * 0.008 };
    const calf = add(knee, { x: a.x - knee.x, y: a.y - knee.y }, 0.3);
    const shinA = Math.atan2(a.y - knee.y, a.x - knee.x);
    return unionAll([
      roundCone(h, knee, 0.058, 0.041),
      circle(knee, 0.04),
      roundCone(knee, a, 0.04, 0.026),
      ellipse(calf, 0.07, 0.04, shinA),
      ellipse(sole, 0.037 - onToe * 0.008, 0.0215 + onToe * 0.008, out * -8 * deg),
    ], 0.014);
  };

  // Torso, stacked up the spine.
  const spine = -p.lean * deg;                       // leaning right turns the spine clockwise
  const waistC = add(pc, rot({ x: 0, y: 0.098 }, tilt * 0.4 + spine * 0.5));
  const chestC = add(waistC, rot({ x: 0, y: 0.118 }, spine));
  const shA = spine + p.shTilt * deg;
  const shoulder = { R: add(chestC, rot({ x: 0.112, y: 0.06 }, shA)), L: add(chestC, rot({ x: -0.112, y: 0.06 }, shA)) };
  const neckBase = add(chestC, rot({ x: 0, y: 0.088 }, spine));
  const headA = spine * 0.6 - p.headTilt * deg;
  const headC = add(neckBase, rot({ x: 0, y: 0.084 }, headA));
  const torso = unionAll([
    ellipse(add(pc, { x: 0, y: 0.012 }), 0.096, 0.066, tilt),
    ellipse(waistC, 0.079, 0.08, spine),
    ellipse(chestC, 0.101, 0.094, spine),
    circle(shoulder.R, 0.043), circle(shoulder.L, 0.043),
    roundCone(neckBase, shoulder.R, 0.036, 0.036), roundCone(neckBase, shoulder.L, 0.036, 0.036),
  ], 0.03);
  const head = unionAll([
    ellipse(headC, 0.057, 0.07, headA),
    ellipse(add(headC, rot({ x: 0, y: -0.03 }, headA)), 0.045, 0.043, headA),
    roundCone(add(neckBase, rot({ x: 0, y: -0.01 }, spine)), add(headC, rot({ x: 0, y: -0.035 }, headA)), 0.032, 0.029),
  ], 0.012);

  // Arms hang from the shoulders and swing with the torso. Tilting a segment
  // toward the viewer foreshortens it.
  const arm = (side, out) => {
    const a = p[side === 'R' ? 'armR' : 'armL'];
    const d1 = rot(limbDir(a.a, out), shA), d2 = rot(limbDir(a.a + a.e, out), shA);
    const elbow = add(shoulder[side], d1, UPPER_ARM * Math.cos(a.tilt * deg));
    const foreLen = FOREARM * Math.cos(a.tiltF * deg);
    const wrist = add(elbow, d2, foreLen);
    const hand = add(wrist, d2, 0.03 * Math.cos(a.tiltF * deg));
    const pointing = Math.abs(Math.sin(a.tiltF * deg));          // a hand aimed at the viewer looks rounder
    return {
      reach: [elbow, hand],
      sdf: unionAll([
        roundCone(shoulder[side], elbow, 0.037, 0.029),
        roundCone(elbow, wrist, 0.029, 0.021),
        ellipse(hand, 0.037 - pointing * 0.008, 0.025 + pointing * 0.004, Math.atan2(d2.y, d2.x)),
      ], 0.01),
    };
  };
  const armR = arm('R', 1), armL = arm('L', -1);
  const legR = leg('R', 1), legL = leg('L', -1);

  const sdf = (px, py) => {
    let d = smin(torso(px, py), head(px, py), 0.014);
    d = smin(d, legR(px, py), 0.024);
    d = smin(d, legL(px, py), 0.024);
    d = smin(d, armR.sdf(px, py), 0.009);
    d = smin(d, armL.sdf(px, py), 0.009);
    return d;
  };
  const bounds = { x0: Infinity, x1: -Infinity, y0: -0.03, y1: -Infinity };
  for (const pt of [pc, headC, shoulder.R, shoulder.L, ankle.R, ankle.L, ...armR.reach, ...armL.reach]) {
    bounds.x0 = Math.min(bounds.x0, pt.x - 0.13); bounds.x1 = Math.max(bounds.x1, pt.x + 0.13);
    bounds.y1 = Math.max(bounds.y1, pt.y + 0.14);
  }
  return { sdf, bounds };
}

// --- Routine -------------------------------------------------------------------
// The dance is a list of key poses, one on (almost) every beat. Between keys
// the figure moves quickly and then holds, so each pose lands on its beat.

// Arms: [angle from hanging, tilt toward the viewer, elbow bend, forearm tilt].
const EASY = [16, 10, -40, 44], EASY_IN = [12, 8, -78, 34], EASY_OUT = [30, 14, 14, 30];
const ON_HIP = [40, -6, -118, 12], POINT_UP = [150, 4, 2, 4], POINT_DOWN = [-28, 22, 4, 22];
const ROOF = [138, 8, 34, 6], CLAP = [162, 6, 22, 6], OUT = [90, 0, 0, 0];

// Feet: [x, lift, kneeUp].
const BASE = { sway: 0, hipTilt: 0, lean: 0, shTilt: 0, headTilt: 0, drop: 0.02,
  footR: [0.11, 0, 0], footL: [-0.11, 0, 0], armR: EASY, armL: EASY };
const pose = (o) => ({ ...BASE, ...o });
const mirror = (o) => ({ ...o, sway: -o.sway, hipTilt: -o.hipTilt, lean: -o.lean, shTilt: -o.shTilt, headTilt: -o.headTilt,
  footR: [-o.footL[0], o.footL[1], o.footL[2]], footL: [-o.footR[0], o.footR[1], o.footR[2]], armR: o.armL, armL: o.armR });

// 1. Step-touch: step right, left foot taps in; step left, right foot taps in.
const step = pose({ sway: 0.082, hipTilt: 6, lean: -3, shTilt: -4, headTilt: 3, footR: [0.13, 0, 0], footL: [-0.13, 0, 0], armR: EASY_OUT, armL: EASY_IN });
const touch = pose({ sway: 0.09, hipTilt: 8, lean: -5, shTilt: -6, headTilt: -2, footR: [0.13, 0, 0], footL: [0.005, 0.014, 0] });
// 2. Disco: point to the sky, then down across the body, hips popping the other way.
const discoUp = pose({ sway: -0.03, hipTilt: -7, lean: 5, shTilt: 8, headTilt: 6, drop: 0.014, footR: [0.12, 0, 0], footL: [-0.13, 0, 0], armR: POINT_UP, armL: ON_HIP });
const discoDown = pose({ sway: 0.04, hipTilt: 7, lean: -4, shTilt: -6, headTilt: -6, drop: 0.032, footR: [0.12, 0, 0], footL: [-0.13, 0, 0], armR: POINT_DOWN, armL: ON_HIP });
// 3. The floss: straight arms swing to one side while the hips swing to the other.
const floss = pose({ sway: -0.045, hipTilt: -6, lean: 3, shTilt: 3, drop: 0.03, footR: [0.1, 0, 0], footL: [-0.1, 0, 0], armR: [38, 0, 0, 0], armL: [-36, 18, 0, 18] });
// 4. Y, M, C, A.
const letterY = pose({ drop: 0.012, armR: POINT_UP, armL: POINT_UP });
const letterM = pose({ drop: 0.03, armR: [120, 6, 170, 10], armL: [120, 6, 170, 10] });
const letterC = pose({ sway: 0.03, hipTilt: -4, lean: -6, headTilt: -5, armR: [165, 6, 60, 6], armL: [95, 0, -60, 0] });
const letterA = pose({ drop: 0, footR: [0.16, 0, 0], footL: [-0.16, 0, 0], armR: CLAP, armL: CLAP });
// 5. Knee lifts: step onto one leg, then drive the other knee up to the opposite elbow.
const stepOn = pose({ sway: 0.06, hipTilt: 4, lean: -2, drop: 0.03, footR: [0.1, 0, 0], footL: [-0.1, 0, 0], armR: EASY_IN, armL: [70, 0, 70, 10] });
const kneeUp = pose({ sway: 0.075, hipTilt: 9, lean: -5, shTilt: -5, drop: 0.008, footR: [0.1, 0, 0], footL: [-0.02, 0.2, 1], armR: [75, 0, 85, 10], armL: [25, 10, -60, 40] });
// 6. Jumps: a star jump, then a tuck jump with the arms thrown up.
const stand = pose({ drop: 0.015 });
const squat = pose({ drop: 0.11, footR: [0.12, 0, 0], footL: [-0.12, 0, 0], armR: [22, -10, 20, 0], armL: [22, -10, 20, 0] });
const star = pose({ drop: 0, footR: [0.24, 0.11, 0], footL: [-0.24, 0.11, 0], armR: [128, 0, 0, 0], armL: [128, 0, 0, 0] });
const land = pose({ drop: 0.1, footR: [0.13, 0, 0], footL: [-0.13, 0, 0], armR: [45, 10, 60, 30], armL: [45, 10, 60, 30] });
const tuck = pose({ drop: 0, footR: [0.08, 0.14, 0.6], footL: [-0.08, 0.14, 0.6], armR: ROOF, armL: ROOF });
// 7. Arm wave: a ripple that runs from the left hand, across the shoulders, out the right hand.
const wave = [
  pose({ armL: OUT, armR: OUT }),
  pose({ armL: [78, 0, 48, 0], armR: OUT, lean: -2, shTilt: 3 }),
  pose({ armL: [112, 0, -44, 0], armR: OUT, lean: -3, shTilt: -9, headTilt: -4 }),
  pose({ armL: [84, 0, -6, 0], armR: [84, 0, -6, 0], drop: 0.035 }),
  pose({ armL: OUT, armR: [112, 0, -44, 0], lean: 3, shTilt: 9, headTilt: 4 }),
  pose({ armL: OUT, armR: [78, 0, 48, 0], lean: 2, shTilt: -3 }),
  pose({ armL: OUT, armR: OUT }),
  pose({ armL: [60, 0, 20, 0], armR: [60, 0, 20, 0], drop: 0.03 }),
];
// 8. Walk like an Egyptian, then a side kick to finish.
const egyptian = pose({ sway: 0.05, hipTilt: 5, drop: 0.025, footR: [0.1, 0, 0], footL: [-0.1, 0, 0], armR: [90, 0, 90, 0], armL: [90, 0, -90, 0] });
const finish = pose({ sway: -0.05, hipTilt: -8, lean: 8, shTilt: 6, headTilt: 5, drop: 0.005, footR: [0.34, 0.22, 0], footL: [-0.12, 0, 0], armR: POINT_UP, armL: [95, 0, 10, 0] });

const KEYS = [
  [0, step], [1, touch], [2, mirror(step)], [3, mirror(touch)],
  [4, discoUp], [5, discoDown], [6, discoUp], [7, discoDown],
  [8, floss], [8.5, mirror(floss)], [9, floss], [9.5, mirror(floss)], [10, floss], [10.5, mirror(floss)], [11, floss], [11.5, mirror(floss)],
  [12, letterY], [13, letterM], [14, letterC], [15, letterA],
  [16, stepOn], [17, kneeUp], [18, mirror(stepOn)], [19, mirror(kneeUp)],
  [20, squat], [20.5, star], [21, land], [21.5, stand], [22, squat], [22.5, tuck], [23, land], [23.5, stand],
  ...wave.map((w, i) => [24 + i / 2, w]),
  [28, egyptian], [29, mirror(egyptian)], [30, egyptian], [30.5, mirror(egyptian)],
  [31, finish],
];
const BEATS = 32;               // length of the routine
const SNAP = 0.8;               // fraction of the gap spent moving; the rest holds the pose

function poseAt(beat) {
  const b = ((beat % BEATS) + BEATS) % BEATS;
  let i = KEYS.length - 1;
  for (let k = 0; k < KEYS.length; k++) if (KEYS[k][0] <= b) i = k;
  const [t0, from] = KEYS[i], [t1raw, to] = KEYS[(i + 1) % KEYS.length];
  const t1 = t1raw <= t0 ? t1raw + BEATS : t1raw;
  const t = Math.min(1, (b - t0) / (t1 - t0) / SNAP);
  const s = t * t * (3 - 2 * t);
  const mix = (a, c) => a + (c - a) * s;
  const mixAll = (a, c) => a.map((v, k) => mix(v, c[k]));
  const footOf = (a, c) => {
    const [x, lift, kneeUp] = mixAll(a, c);
    // A foot sliding along the floor picks itself up on the way.
    const hop = a[1] < 0.005 && c[1] < 0.005 ? 0.035 * Math.sin(Math.PI * s) * Math.min(1, Math.abs(c[0] - a[0]) / 0.06) : 0;
    return { x, lift: lift + hop, kneeUp };
  };
  const armOf = ([a, tilt, e, tiltF]) => ({ a, tilt, e, tiltF });
  return {
    sway: mix(from.sway, to.sway), hipTilt: mix(from.hipTilt, to.hipTilt), lean: mix(from.lean, to.lean),
    shTilt: mix(from.shTilt, to.shTilt), headTilt: mix(from.headTilt, to.headTilt),
    drop: mix(from.drop, to.drop) + 0.01 * (0.5 + 0.5 * Math.cos(beat * 2 * Math.PI)),   // sink into each beat
    footR: footOf(from.footR, to.footR), footL: footOf(from.footL, to.footL),
    armR: armOf(mixAll(from.armR, to.armR)), armL: armOf(mixAll(from.armL, to.armL)),
  };
}

// --- Tracing -------------------------------------------------------------------
function traceOuterContour(sdf, { x0, x1, y0, y1 }) {
  const nx = Math.ceil((x1 - x0) / GRID) + 1, ny = Math.ceil((y1 - y0) / GRID) + 1;
  const v = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = sdf(x0 + i * GRID, y0 + j * GRID);
  const X = (i) => x0 + i * GRID, Y = (j) => y0 + j * GRID;

  // Crossing point on a cell edge, keyed so neighbouring cells share it.
  const pts = new Map();
  function edgePt(i, j, horiz) {
    const key = (horiz ? 'h' : 'v') + i + ',' + j;
    if (!pts.has(key)) {
      const a = v[j * nx + i], b = horiz ? v[j * nx + i + 1] : v[(j + 1) * nx + i];
      const t = a / (a - b);
      pts.set(key, horiz ? { x: X(i) + t * GRID, y: Y(j) } : { x: X(i), y: Y(j) + t * GRID });
    }
    return key;
  }
  const links = new Map();
  const link = (a, b) => { (links.get(a) || links.set(a, []).get(a)).push(b); (links.get(b) || links.set(b, []).get(b)).push(a); };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = v[j * nx + i], b = v[j * nx + i + 1], c = v[(j + 1) * nx + i + 1], d = v[(j + 1) * nx + i];
      const idx = (a < 0 ? 1 : 0) | (b < 0 ? 2 : 0) | (c < 0 ? 4 : 0) | (d < 0 ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const S = () => edgePt(i, j, true), E = () => edgePt(i + 1, j, false), N = () => edgePt(i, j + 1, true), W = () => edgePt(i, j, false);
      const center = (a + b + c + d) / 4;
      switch (idx) {
        case 1: case 14: link(W(), S()); break;
        case 2: case 13: link(S(), E()); break;
        case 3: case 12: link(W(), E()); break;
        case 4: case 11: link(E(), N()); break;
        case 6: case 9: link(S(), N()); break;
        case 7: case 8: link(W(), N()); break;
        case 5: if (center < 0) { link(W(), N()); link(S(), E()); } else { link(W(), S()); link(E(), N()); } break;
        case 10: if (center < 0) { link(W(), S()); link(E(), N()); } else { link(W(), N()); link(S(), E()); } break;
      }
    }
  }
  // Walk the links into closed loops; keep the one enclosing the most area.
  const seen = new Set();
  let best = null, bestArea = 0;
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let prev = null, cur = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      loop.push(pts.get(cur));
      const next = links.get(cur).find((k) => k !== prev && !seen.has(k));
      prev = cur; cur = next;
    }
    const area = signedArea(loop);
    if (Math.abs(area) > Math.abs(bestArea)) { best = loop; bestArea = area; }
  }
  if (bestArea < 0) best.reverse();
  return best;
}

function signedArea(loop) {
  let s = 0;
  for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; s += a.x * b.y - b.x * a.y; }
  return s / 2;
}

function simplifyOpen(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1e-12;
  let worst = 0, wi = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len;
    if (d > worst) { worst = d; wi = i; }
  }
  if (worst <= tol) return [a, b];
  const l = simplifyOpen(pts.slice(0, wi + 1), tol), r = simplifyOpen(pts.slice(wi), tol);
  return l.slice(0, -1).concat(r);
}

// Simplifies a closed loop, starting it at the top of the head.
function finishLoop(loop) {
  let top = 0;
  for (let i = 1; i < loop.length; i++) if (loop[i].y > loop[top].y) top = i;
  const ring = loop.slice(top).concat(loop.slice(0, top));
  let far = 0, farD = 0;
  for (let i = 0; i < ring.length; i++) { const d = Math.hypot(ring[i].x - ring[0].x, ring[i].y - ring[0].y); if (d > farD) { farD = d; far = i; } }
  const a = simplifyOpen(ring.slice(0, far + 1), SIMPLIFY_TOL);
  const b = simplifyOpen(ring.slice(far).concat([ring[0]]), SIMPLIFY_TOL);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

// --- Bake ----------------------------------------------------------------------
const total = BEATS * FRAMES_PER_BEAT;
const frames = [];
for (let f = 0; f < total; f++) {
  const body = buildBody(poseAt(f / FRAMES_PER_BEAT));
  const poly = finishLoop(traceOuterContour(body.sdf, body.bounds));
  frames.push(poly.flatMap((p) => [Math.round(p.x * UNITS), Math.round(p.y * UNITS)]));
}

const fps = (FRAMES_PER_BEAT * BPM) / 60;
const src = `// GENERATED by tools/make_dancer_sprites.mjs - edit that script, not this file.
//
// The hero's dancer as a sprite sheet: every frame is one closed outline of
// the whole figure (a single line that never crosses itself), stored as flat
// [x0, y0, x1, y1, ...] integers in 1/${UNITS}ths of the figure's standing
// height, ground at y = 0, y pointing up. ${total} frames cover an ${BEATS}-beat routine
// and are meant to be played stepped, at ${fps.toFixed(1)} frames a second.
window.DANCER_SPRITES = {
  units: ${UNITS},
  fps: ${fps.toFixed(2)},
  framesPerBeat: ${FRAMES_PER_BEAT},
  frames: [
${frames.map((fr) => `    [${fr.join(',')}],`).join('\n')}
  ],
};
`;
writeFileSync(OUT_FILE, src);
console.log(`wrote ${OUT_FILE} (${(src.length / 1024).toFixed(1)} KB), ${total} frames`);
console.log(`vertices per frame: ${frames.map((f) => f.length / 2).join(' ')}`);

// --- Optional contact sheet ------------------------------------------------------
const pngArg = process.argv.indexOf('--png');
if (pngArg > 0) {
  const stepArg = process.argv.indexOf('--step');
  const step = stepArg > 0 ? Number(process.argv[stepArg + 1]) : 1;
  const cellArg = process.argv.indexOf('--cell');
  writeContactSheet(process.argv[pngArg + 1], frames.filter((_, i) => i % step === 0), cellArg > 0 ? Number(process.argv[cellArg + 1]) : 230);
}

function writeContactSheet(file, list, cell) {
  const cols = Math.min(8, list.length), rows = Math.ceil(list.length / cols);
  const W = cols * cell, H = rows * cell;
  const img = Buffer.alloc(W * H * 3, 14);
  const put = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 3; img[o] = r; img[o + 1] = g; img[o + 2] = b; };
  const line = (ax, ay, bx, by, c) => {
    const n = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))) + 1;
    for (let i = 0; i <= n; i++) { const t = i / n; put(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t), ...c); }
  };
  list.forEach((fr, k) => {
    const ox = (k % cols) * cell + cell / 2, oy = Math.floor(k / cols) * cell + cell - 14;
    const s = (cell - 34) / (1.22 * UNITS);
    line(ox - cell / 2 + 6, oy, ox + cell / 2 - 6, oy, [44, 44, 64]);
    const P = (i) => [ox + fr[2 * i] * s, oy - fr[2 * i + 1] * s];
    const n = fr.length / 2;
    for (let i = 0; i < n; i++) { const [ax, ay] = P(i), [bx, by] = P((i + 1) % n); line(ax, ay, bx, by, [255, 110, 90]); }
  });
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb)); return Buffer.concat([len, tb, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log(`contact sheet: ${file}`);
}
