// Bakes the hero's dancing figure into ../assets/dancer_sprites.js.
//
//   node tools/make_dancer_sprites.mjs                  (rewrites assets/dancer_sprites.js)
//   node tools/make_dancer_sprites.mjs --png out.png    (also draws a contact sheet;
//        --step N draws every Nth frame, --cell PX sets the size of each picture)
//   node tools/make_dancer_sprites.mjs --keys out.png   (draws just the key poses, writes nothing else)
//   node tools/make_dancer_sprites.mjs --turn out.png   (draws one pose from eight sides, or --yaws a,b,c;
//                                                        writes nothing else)
//
// The dancer works like a pre-rendered 3D game sprite: a 3D figure is posed and
// rendered ahead of time, and the page only plays the finished frames back.
//
//   1. The body (head, neck, torso, arms, hands with fingers and thumbs, legs in
//      loose trousers, and trainers) is built from rounded solids hung on a
//      skeleton, in units of the figure's standing height (1.0 = head to toe).
//   2. It's posed from a hand-authored 32-beat routine of key poses. Feet are
//      planted and each leg is solved back up to its hip, and the figure turns,
//      so it's seen front-on, three-quarter, in profile and from behind.
//   3. Each solid is projected through a camera at hip height, with a little
//      perspective, to a flat shape, and the shapes are merged into one
//      silhouette. A solid blends smoothly into the part it hangs from (forearm
//      into upper arm, thigh into hips) but into nothing else, so the gaps
//      between limbs stay open.
//   4. The silhouette is traced with marching squares into closed outlines: the
//      outer edge, and any holes (a hand on a hip leaves one inside the arm).
//      These are simplified and stored delta-encoded.
//
// The page fills each frame with its own background colour, in front of a glow,
// so the dancer is only seen as a shape cut out of the light.

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_FILE = fileURLToPath(new URL('../assets/dancer_sprites.js', import.meta.url));
const FRAMES_PER_BEAT = 6;      // drawings per beat: about 12 a second at 116 bpm
const BPM = 116;
const UNITS = 1000;             // stored coordinates per standing height
const GRID = 0.002;             // silhouette sampling step, in standing heights
const SIMPLIFY_TOL = 0.0015;    // Douglas-Peucker tolerance, in standing heights
const MIN_AREA = 0.00002;       // smaller islands and holes are dropped, in square standing heights
const CAMERA_Y = 0.55;          // the camera's height: about the hips, like a seat in the stalls
const CAMERA_D = 4.5;           // and its distance: near enough for a little perspective

const deg = Math.PI / 180;

// --- 3D maths ------------------------------------------------------------------
// x is screen right, y is up and z points at the camera. A rotation is stored as
// the three directions it turns the x, y and z axes to.

const V = (x, y, z) => ({ x, y, z });
const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a, s) => V(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const unit = (a) => mul(a, 1 / (Math.hypot(a.x, a.y, a.z) || 1e-12));
const arr = (v) => [v.x, v.y, v.z];
const X = V(1, 0, 0), Y = V(0, 1, 0), Z = V(0, 0, 1), DOWN = V(0, -1, 0);

const ID = { x: X, y: Y, z: Z };
const apply = (m, v) => add(add(mul(m.x, v.x), mul(m.y, v.y)), mul(m.z, v.z));
// compose(a, b, c) turns by c, then b, then a.
const compose = (...ms) => ms.reduceRight((b, a) => ({ x: apply(a, b.x), y: apply(a, b.y), z: apply(a, b.z) }));
function turn(axis, degrees) {                 // right-handed, about any axis
  const u = unit(axis), c = Math.cos(degrees * deg), s = Math.sin(degrees * deg);
  const r = (v) => add(add(mul(v, c), mul(cross(u, v), s)), mul(u, dot(u, v) * (1 - c)));
  return { x: r(X), y: r(Y), z: r(Z) };
}
const tip = (d) => turn(X, d);                 // + tips the top toward the camera
const face = (d) => turn(Y, d);                // + turns the front toward screen right
const bank = (d) => turn(Z, d);                // + raises the screen-right side

// A frame is a position and a rotation. Points in it are given in its own axes.
const frame = (o, m) => ({ o, m });
const at = (f, [x, y, z]) => add(f.o, apply(f.m, V(x, y, z)));
const child = (f, p, m = ID) => frame(at(f, p), compose(f.m, m));
// A bone's frame: it hangs along its own -y, with `front` as its +z.
function bone(from, to, front) {
  const y = unit(sub(from, to));
  const z = unit(sub(front, mul(y, dot(front, y))));
  return frame(from, { x: cross(y, z), y, z });
}

// Solids, placed in a frame: a ball, a tapered capsule (two balls and the cone
// that joins them), and an egg (an ellipsoid, optionally turned within the frame).
const ball = (f, c, r) => ({ kind: 'ball', a: at(f, c), ra: r });
const capsule = (f, a, b, ra, rb) => ({ kind: 'capsule', a: at(f, a), b: at(f, b), ra, rb });
const egg = (f, c, radii, m = ID) => ({ kind: 'egg', a: at(f, c), m: compose(f.m, m), radii });

// --- Flat shapes ----------------------------------------------------------------
// Each returns the distance from (px, py) to the shape's edge: negative inside.

function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function circle(c, r) { return (px, py) => Math.hypot(px - c.x, py - c.y) - r; }

// Tapered capsule from a (radius ra) to b (radius rb): Inigo Quilez's "uneven capsule".
function roundCone(a, b, ra, rb) {
  const h = Math.hypot(b.x - a.x, b.y - a.y);
  if (h <= Math.abs(ra - rb) + 1e-9) return ra > rb ? circle(a, ra) : circle(b, rb);   // one end hides the other
  const tx = (b.x - a.x) / h, ty = (b.y - a.y) / h;
  const k = (ra - rb) / h, c = Math.sqrt(1 - k * k);
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
function ellipse(c, rx, ry, rot) {
  const co = Math.cos(rot), si = Math.sin(rot);
  return (px, py) => {
    const dx = px - c.x, dy = py - c.y;
    const u = dx * co + dy * si, v = -dx * si + dy * co;
    const k0 = Math.hypot(u / rx, v / ry);
    const k1 = Math.hypot(u / (rx * rx), v / (ry * ry));
    return k0 < 1e-9 ? -Math.min(rx, ry) : k0 * (k0 - 1) / k1;
  };
}

// --- Camera ----------------------------------------------------------------------
// Looking straight along -z from hip height. Each solid is scaled by its own
// distance, so a hand reaching toward the camera looks a little bigger.
function project(p) {
  const s = CAMERA_D / (CAMERA_D - p.z);
  return { x: p.x * s, y: CAMERA_Y + (p.y - CAMERA_Y) * s, s };
}

// A solid's flat shape, with a bounding box.
function flatten(solid) {
  if (solid.kind === 'ball') {
    const c = project(solid.a), r = solid.ra * c.s;
    return { f: circle(c, r), x0: c.x - r, x1: c.x + r, y0: c.y - r, y1: c.y + r };
  }
  if (solid.kind === 'capsule') {
    const a = project(solid.a), b = project(solid.b), ra = solid.ra * a.s, rb = solid.rb * b.s;
    return { f: roundCone(a, b, ra, rb), x0: Math.min(a.x - ra, b.x - rb), x1: Math.max(a.x + ra, b.x + rb),
      y0: Math.min(a.y - ra, b.y - rb), y1: Math.max(a.y + ra, b.y + rb) };
  }
  // An egg seen down the line of sight is an ellipse: its quadric with z eliminated.
  const c = project(solid.a);
  let q00 = 0, q01 = 0, q02 = 0, q11 = 0, q12 = 0, q22 = 0;
  [solid.m.x, solid.m.y, solid.m.z].forEach((u, i) => {
    const w = 1 / (solid.radii[i] * solid.radii[i]);
    q00 += u.x * u.x * w; q01 += u.x * u.y * w; q02 += u.x * u.z * w;
    q11 += u.y * u.y * w; q12 += u.y * u.z * w; q22 += u.z * u.z * w;
  });
  const a = q00 - q02 * q02 / q22, b = q01 - q02 * q12 / q22, d = q11 - q12 * q12 / q22;
  const mid = (a + d) / 2, spread = Math.hypot((a - d) / 2, b);
  const rx = c.s / Math.sqrt(mid + spread), ry = c.s / Math.sqrt(mid - spread);
  const rot = 0.5 * Math.atan2(2 * b, a - d);
  const hx = Math.hypot(rx * Math.cos(rot), ry * Math.sin(rot)), hy = Math.hypot(rx * Math.sin(rot), ry * Math.cos(rot));
  return { f: ellipse(c, rx, ry, rot), x0: c.x - hx, x1: c.x + hx, y0: c.y - hy, y1: c.y + hy };
}

// --- Body --------------------------------------------------------------------------
// Proportions in standing heights (standard anthropometric ratios).
const THIGH = 0.245, SHIN = 0.246, LEG = THIGH + SHIN;     // hip joint to knee, knee to ankle
const UPPER_ARM = 0.18, FOREARM = 0.152;
const ANKLE_H = 0.045;                  // ankle joint above the floor
const HIP_HALF = 0.052;                 // hip joints either side of the pelvis centre
const BALL = 0.1;                       // ankle to the ball of the foot, along the foot
// In the chest's frame, for the screen-right side (the other side is its mirror image):
const COLLAR = V(0.02, 0.085, 0.03);    // where the collarbone meets the breastbone
const SHOULDER = V(0.1, 0.078, -0.012);      // the shoulder joint, shoulders relaxed
const SIDES = [['R', 1], ['L', -1]];    // R is screen right when the dancer faces the camera

// How softly each part's own solids merge.
const SOFT = { pelvis: 0.03, waist: 0.02, chest: 0.03, neck: 0.01, head: 0.012, shoulder: 0.01, upper: 0.02,
  fore: 0.015, hand: 0.004, thigh: 0.03, shin: 0.025, foot: 0.008 };
// Each part blends into the one it hangs from, and nothing else.
const JOINS = [
  ['pelvis', 'waist', 0.05], ['waist', 'chest', 0.05], ['chest', 'neck', 0.025], ['neck', 'head', 0.012],
  ...SIDES.flatMap(([s]) => [
    ['chest', 'shoulder' + s, 0.03], ['shoulder' + s, 'upper' + s, 0.02], ['upper' + s, 'fore' + s, 0.015],
    ['fore' + s, 'hand' + s, 0.008],
    ['pelvis', 'thigh' + s, 0.03], ['thigh' + s, 'shin' + s, 0.025], ['shin' + s, 'foot' + s, 0.012],
  ]),
];

// Finger curls (index to little finger), the thumb's curl, then how far the fingers spread: all 0 to 1.
const HANDS = {
  relaxed: [0.35, 0.4, 0.45, 0.5, 0.25, 0.1],
  fist: [1, 1, 1, 1, 1, 0],
  point: [0, 1, 1, 1, 1, 0],
  flat: [0, 0, 0, 0, 0.1, 0],
  spread: [0.05, 0.05, 0.05, 0.05, 0, 1],
};
// Knuckles (down the hand, and across the palm toward the thumb), finger lengths, and how far each fans out.
const FINGERS = [
  { y: -0.066, z: 0.016, len: 0.044, fan: -10 },
  { y: -0.069, z: 0.0055, len: 0.048, fan: -3 },
  { y: -0.067, z: -0.0055, len: 0.045, fan: 4 },
  { y: -0.062, z: -0.016, len: 0.036, fan: 12 },
];

// A hand hanging at the side: it points down its frame's -y, the palm faces -x and the thumb is toward +z.
function handSolids(f, shape) {
  const solids = [egg(f, [-0.001, -0.036, 0], [0.012, 0.037, 0.025])];   // palm
  const digit = (start, dir, lengths, bends, r, taper) => {
    let pt = start;
    lengths.forEach((len, j) => {
      dir = bends[j](dir);
      const next = add(pt, mul(dir, len));
      solids.push(capsule(f, arr(pt), arr(next), r, r * taper));
      pt = next; r *= taper;
    });
  };
  FINGERS.forEach((g, i) => {
    const curl = (d) => (v) => apply(bank(-shape[i] * d), v);       // toward the palm
    digit(V(-0.002, g.y, g.z), apply(tip(g.fan * shape[5]), DOWN), [0.45, 0.3, 0.25].map((k) => k * g.len),
      [curl(65), curl(95), curl(60)], 0.0058, 0.9);
  });
  const t = shape[4];
  const toPalm = (d) => (v) => apply(turn(cross(v, V(-1, 0, 0)), d), v);
  digit(V(-0.006, -0.016, 0.019), unit(V(-0.25 - 0.45 * t, -0.6, 0.75 - 0.95 * t)), [0.03, 0.026],
    [toPalm(0), toPalm(10 + 25 * t)], 0.0078, 0.88);
  return solids;
}

// A screen-right arm, in the chest's frame. Big movements come from pose `a`;
// the elbow, wrist and fingers from `b`, a moment behind, so they follow through.
function armSolids(a, b) {
  const S = add(COLLAR, apply(bank(a.shrug), sub(SHOULDER, COLLAR)));
  const out = V(Math.cos(a.fwd * deg), 0, Math.sin(a.fwd * deg));
  const upper = compose(turn(V(-out.z, 0, out.x), a.raise), turn(DOWN, a.roll));
  const d1 = apply(upper, DOWN);
  const fore = compose(turn(cross(d1, apply(upper, Z)), b.bend), upper);
  const elbow = add(S, mul(d1, UPPER_ARM)), wrist = add(elbow, mul(apply(fore, DOWN), FOREARM));
  const hand = compose(fore, turn(DOWN, b.pron), bank(-b.wrist));
  const chest = frame(V(0, 0, 0), ID), fu = frame(S, upper), ff = frame(elbow, fore), fh = frame(wrist, hand);
  return {
    chest: [capsule(chest, [0.02, 0.105, -0.025], [S.x - 0.02, S.y + 0.012, S.z], 0.03, 0.026)],   // the slope of the shoulder
    shoulder: [egg(fu, [0.004, -0.016, 0], [0.033, 0.042, 0.038])],
    upper: [capsule(fu, [0, 0, 0], [0, -UPPER_ARM, 0], 0.031, 0.025), egg(fu, [0, -0.08, 0.004], [0.028, 0.055, 0.03])],
    fore: [capsule(ff, [0, 0, 0], [0, -FOREARM, 0], 0.024, 0.017), egg(ff, [0, -0.045, 0], [0.023, 0.055, 0.026])],
    hand: handSolids(fh, b.hand),
  };
}

const shoe = (f) => [
  ball(f, [0, -0.004, -0.004], 0.03),                                   // ankle and tongue
  capsule(f, [0, -0.02, -0.022], [0, -0.028, 0.095], 0.027, 0.028),     // upper
  egg(f, [0, -0.03, 0.112], [0.028, 0.018, 0.032]),                     // toe cap
  capsule(f, [0.013, -0.036, -0.03], [0.015, -0.038, 0.125], 0.009, 0.009),    // sole
  capsule(f, [-0.013, -0.036, -0.03], [-0.015, -0.038, 0.125], 0.009, 0.009),
];

// Knee from hip and ankle, bending toward `pole`.
function solveKnee(hip, ankle, pole) {
  const d = sub(ankle, hip), dist = Math.hypot(d.x, d.y, d.z);
  const D = Math.min(Math.max(dist, 0.02), THIGH + SHIN - 1e-4);
  const dir = mul(d, 1 / dist);
  const along = (THIGH * THIGH - SHIN * SHIN + D * D) / (2 * D);
  const out = Math.sqrt(Math.max(THIGH * THIGH - along * along, 0));
  return add(add(hip, mul(dir, along)), mul(unit(sub(pole, mul(dir, dot(pole, dir)))), out));
}

// Poses the body. Returns its solids, grouped into parts.
function buildBody(p, late) {
  const parts = {};
  const put = (name, ...solids) => (parts[name] ||= []).push(...solids);
  const facing = face(p.yaw);
  const stage = frame(V(0, 0, 0), facing);       // the floor, in the dancer's own facing

  // Feet first. A raised heel pivots on the ball of the foot; a lifted foot points its toes.
  const feet = {};
  for (const [side, s] of SIDES) {
    const ft = p['foot' + side];
    const aim = face(p.yaw + s * ft.toeOut);
    const m = compose(aim, tip(ft.heel * 55 + Math.min(1, ft.lift / 0.05) * 25));
    const ballOfFoot = add(at(stage, [ft.x, ANKLE_H, ft.z]), apply(aim, V(0, -ANKLE_H, BALL)));
    feet[side] = { ankle: add(sub(ballOfFoot, apply(m, V(0, -ANKLE_H, BALL))), V(0, ft.lift, 0)), m, aim };
  }

  // The pelvis sits as high as both legs reach, less the knee bend.
  const pelvisM = compose(facing, face(p.hipTwist), bank(p.hipTilt), tip(p.bend * 0.15));
  const base = at(stage, [p.x, 0, p.z]);
  let top = Infinity;
  for (const [side, s] of SIDES) {
    const off = apply(pelvisM, V(s * HIP_HALF, 0, 0)), a = feet[side].ankle;
    const dx = base.x + off.x - a.x, dz = base.z + off.z - a.z;
    top = Math.min(top, a.y - off.y + Math.sqrt(Math.max(LEG * LEG * 0.996 - dx * dx - dz * dz, 0.01)));
  }
  const pelvis = frame(V(base.x, top - p.drop, base.z), pelvisM);

  // Spine, neck and head.
  const spine = (k, kb) => compose(face(p.twist * k), bank(-p.lean * k), tip(p.bend * kb));
  const waist = child(pelvis, [0, 0.085, 0], spine(0.45, 0.4));
  const chest = child(waist, [0, 0.1, 0], spine(0.55, 0.45));
  const look = (k) => compose(face(late.turn * k), bank(-late.headTilt * k), tip(late.nod * k));
  const neck = child(chest, [0, 0.105, -0.014], look(0.4));
  const head = child(neck, [0, 0.052, 0.006], look(0.6));

  put('pelvis',
    egg(pelvis, [0, 0.03, -0.004], [0.094, 0.08, 0.064]),
    egg(pelvis, [0.042, -0.004, -0.024], [0.052, 0.068, 0.05]),
    egg(pelvis, [-0.042, -0.004, -0.024], [0.052, 0.068, 0.05]));
  put('waist', egg(waist, [0, 0, 0.002], [0.082, 0.08, 0.06]));
  put('chest',
    egg(chest, [0, 0.025, -0.006], [0.092, 0.11, 0.064]),
    egg(chest, [0.042, 0.04, 0.022], [0.048, 0.042, 0.04]),
    egg(chest, [-0.042, 0.04, 0.022], [0.048, 0.042, 0.04]));
  put('neck', capsule(neck, [0, -0.02, 0], [0, 0.055, 0.004], 0.036, 0.031));
  put('head',
    egg(head, [0, 0.068, -0.008], [0.05, 0.062, 0.062]),           // skull and hair
    egg(head, [0, 0.085, 0.02], [0.045, 0.035, 0.035]),            // forehead
    egg(head, [0, 0.038, 0.018], [0.042, 0.045, 0.042]),           // cheeks
    egg(head, [0, 0.015, 0.02], [0.04, 0.03, 0.035]),              // jaw
    egg(head, [0, 0.008, 0.045], [0.022, 0.016, 0.018]),           // chin
    capsule(head, [0, 0.062, 0.056], [0, 0.038, 0.074], 0.008, 0.0065),  // nose
    egg(head, [0.049, 0.05, -0.004], [0.01, 0.019, 0.012]),        // ears
    egg(head, [-0.049, 0.05, -0.004], [0.01, 0.019, 0.012]));

  // Arms: built for the screen-right side in the chest's frame, then mirrored and placed.
  for (const [side, s] of SIDES) {
    const flip = (v) => V(s * v.x, v.y, v.z);
    const place = (solid) => ({ ...solid, a: at(chest, arr(flip(solid.a))), b: solid.b && at(chest, arr(flip(solid.b))),
      m: solid.m && compose(chest.m, { x: flip(solid.m.x), y: flip(solid.m.y), z: flip(solid.m.z) }) });
    for (const [part, solids] of Object.entries(armSolids(p['arm' + side], late['arm' + side]))) {
      put(part === 'chest' ? part : part + side, ...solids.map(place));
    }
  }

  // Legs: each knee bends out over its toes.
  for (const [side, s] of SIDES) {
    const ft = feet[side];
    const hip = at(pelvis, [s * HIP_HALF, 0, 0]);
    const pole = apply(ft.aim, V(s * 0.2, 0, 1));
    const knee = solveKnee(hip, ft.ankle, pole);
    const ankle = add(knee, mul(unit(sub(ft.ankle, knee)), SHIN));
    const thigh = bone(hip, knee, pole), shin = bone(knee, ankle, pole);
    put('thigh' + side, capsule(thigh, [0, 0, 0], [0, -THIGH, 0], 0.056, 0.041), egg(thigh, [0, -0.095, 0.004], [0.05, 0.1, 0.05]));
    put('shin' + side, ball(shin, [0, 0, 0.004], 0.041), capsule(shin, [0, 0, 0], [0, -SHIN + 0.03, 0], 0.04, 0.036),
      egg(shin, [0, -0.085, -0.008], [0.043, 0.085, 0.044]));
    put('foot' + side, ...shoe(frame(ankle, ft.m)));
  }
  return parts;
}

// The posed body's silhouette as a distance field, with its bounds.
function silhouette(parts) {
  const list = Object.entries(parts).map(([name, solids]) => {
    const shapes = solids.map(flatten);
    return { name, shapes, k: SOFT[name.replace(/[RL]$/, '')],
      x0: Math.min(...shapes.map((s) => s.x0)), x1: Math.max(...shapes.map((s) => s.x1)),
      y0: Math.min(...shapes.map((s) => s.y0)), y1: Math.max(...shapes.map((s) => s.y1)) };
  });
  const index = Object.fromEntries(list.map((part, i) => [part.name, i]));
  const joins = JOINS.map(([a, b, k]) => [index[a], index[b], k]);
  const vals = new Float64Array(list.length);
  const gap = (s, px, py) => Math.hypot(Math.max(s.x0 - px, 0, px - s.x1), Math.max(s.y0 - py, 0, py - s.y1));
  const field = (px, py) => {
    for (let i = 0; i < list.length; i++) {
      const part = list[i];
      const far = gap(part, px, py);
      if (far > 0.1) { vals[i] = far; continue; }        // too far off to matter: a lower bound will do
      let d = Infinity;
      for (const shape of part.shapes) {
        const g = gap(shape, px, py);
        if (g > 0 && g >= d + part.k) continue;          // can't change the result
        d = smin(d, shape.f(px, py), part.k);
      }
      vals[i] = d;
    }
    let d = Infinity;
    for (const [a, b, k] of joins) d = Math.min(d, smin(vals[a], vals[b], k));
    return d;
  };
  const pad = 0.01;
  return { field, bounds: {
    x0: Math.min(...list.map((p) => p.x0)) - pad, x1: Math.max(...list.map((p) => p.x1)) + pad,
    y0: Math.min(...list.map((p) => p.y0)) - pad, y1: Math.max(...list.map((p) => p.y1)) + pad } };
}

// --- Routine -----------------------------------------------------------------------
// The dance is a list of key poses, one on (almost) every beat. Between keys the
// figure moves quickly and then holds, so each pose lands on its beat.
//
// Arms: arm(raise, fwd, bend, roll, hand, wrist, pron, shrug)
//   raise  the upper arm's angle up from hanging: 90 is level with the shoulder, 180 straight up
//   fwd    which way it's raised: 0 out to the side, 90 straight ahead, negative behind, over 90 across the body
//   bend   how far the elbow bends (0 is straight)
//   roll   which way the elbow bends: 0 brings the forearm forward (or up, for an arm raised in front);
//          -90 bends it up, and +90 down, for an arm raised out to the side
//   hand   relaxed, fist, point, flat or spread
//   wrist  + bends the hand toward the palm          pron   + turns the palm to face behind
//   shrug  + lifts the shoulder
const arm = (raise, fwd, bend, roll = 0, hand = 'relaxed', wrist = 0, pron = 0, shrug = 0) =>
  ({ raise, fwd, bend, roll, wrist, pron, shrug, hand: HANDS[hand] });

// An arm that puts its wrist at a spot in the chest's frame (screen-right side: +x is outward),
// with the elbow pushed toward `pole`.
function reach(target, pole, hand = 'relaxed', wrist = 0, pron = 0) {
  const T = V(...target), d = sub(T, SHOULDER), dist = Math.hypot(d.x, d.y, d.z);
  const D = Math.min(dist, UPPER_ARM + FOREARM - 1e-4), dir = mul(d, 1 / dist);
  const along = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + D * D) / (2 * D);
  const up = Math.sqrt(Math.max(UPPER_ARM * UPPER_ARM - along * along, 0));
  const P = V(...pole);
  const elbow = add(add(SHOULDER, mul(dir, along)), mul(unit(sub(P, mul(dir, dot(P, dir)))), up));
  const d1 = unit(sub(elbow, SHOULDER)), d2 = unit(sub(add(SHOULDER, mul(dir, D)), elbow));
  const raise = Math.acos(Math.max(-1, Math.min(1, -d1.y))) / deg;
  const fwd = Math.atan2(d1.z, d1.x) / deg;
  const bend = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2)))) / deg;
  const out = V(Math.cos(fwd * deg), 0, Math.sin(fwd * deg));
  const side = apply(turn(V(-out.z, 0, out.x), -raise), sub(d2, mul(d1, dot(d2, d1))));
  return arm(raise, fwd, bend, Math.atan2(-side.x, side.z) / deg, hand, wrist, pron);
}

// Feet: foot(x, z, lift, heel, toeOut): the ankle's spot on the floor (in the dancer's own facing:
// +x is the dancer's screen-right side, +z in front), how high the foot is lifted, the heel
// raised (1 is up on the ball of the foot), and the toes turned out (degrees).
const foot = (x, z = 0, lift = 0, heel = 0, toeOut = 8) => ({ x, z, lift, heel, toeOut });

// Pose:
//   yaw       which way the dancer faces: 0 is the camera, 90 screen right, 180 away
//   spin      on a key: turn this far to reach it, instead of the shortest way round
//   glide     on a key: move to it at an even speed, without easing or holding
//   x, z      the hips over the floor, in the dancer's own facing (sway, and stepping forward)
//   drop      how far the hips sink below straight legs
//   hipTilt   + raises the screen-right hip             hipTwist  turns the hips, on top of yaw
//   lean      + bends the spine toward screen right      bend      + bends forward
//   twist     turns the shoulders against the hips
//   headTilt  + tips the head toward screen right        nod       + looks down     turn   + looks to screen right
const BASE = { yaw: 0, x: 0, z: 0, drop: 0.02, hipTilt: 0, hipTwist: 0, lean: 0, bend: 0, twist: 0,
  headTilt: 0, nod: 0, turn: 0, footR: foot(0.1), footL: foot(-0.1), armR: arm(10, 15, 20), armL: arm(10, 15, 20) };
const pose = (o) => ({ ...BASE, ...o });
const mirror = (o) => ({ ...o, yaw: -o.yaw, spin: o.spin && -o.spin, x: -o.x, hipTilt: -o.hipTilt, hipTwist: -o.hipTwist,
  lean: -o.lean, twist: -o.twist, headTilt: -o.headTilt, turn: -o.turn,
  footR: { ...o.footL, x: -o.footL.x }, footL: { ...o.footR, x: -o.footR.x }, armR: o.armL, armL: o.armR });

const HAND_ON_HIP = reach([0.16, -0.1, -0.01], [1, 0, -0.6]);

// 1. Step-touch, turning into each step: fists up beside the head on the step, punched down and out on the touch.
const step = pose({ yaw: 20, x: 0.07, hipTilt: 5, lean: -3, twist: 8, headTilt: 3, footR: foot(0.15), footL: foot(-0.11),
  armR: arm(72, 10, 105, -75, 'fist'), armL: arm(68, 15, 110, -70, 'fist') });
const touch = pose({ yaw: 20, x: 0.09, hipTilt: 8, lean: -5, twist: -4, headTilt: -2, drop: 0.04, footR: foot(0.15), footL: foot(0.03, 0.04, 0.01, 1),
  armR: arm(38, 5, 12, 0, 'fist'), armL: arm(36, 10, 15, 0, 'fist') });
// 2. Disco: point up to the sky, then down to the floor.
const discoUp = pose({ yaw: 25, x: -0.03, hipTilt: -7, lean: 5, twist: 10, headTilt: 6, nod: -12, turn: 20, drop: 0.014,
  footR: foot(0.12, 0.02, 0, 0, 20), footL: foot(-0.13, -0.02), armR: arm(150, 15, 0, 0, 'point'), armL: HAND_ON_HIP });
const discoDown = pose({ yaw: 25, x: -0.04, hipTilt: -7, lean: 7, twist: -6, headTilt: 4, nod: 28, turn: 12, drop: 0.032,
  footR: foot(0.12, 0.02), footL: foot(-0.13, -0.02), armR: arm(42, 25, 0, 0, 'point'), armL: HAND_ON_HIP });
// 3. The floss: straight arms swing to one side, one in front of the hips and one behind, as the hips swing the other way.
const floss = pose({ yaw: 8, x: -0.055, hipTilt: -8, lean: 4, hipTwist: -10, drop: 0.03, footR: foot(0.1), footL: foot(-0.1),
  armR: arm(52, -25, 4, 0, 'fist'), armL: arm(56, 160, 4, 0, 'fist') });
// 4. Y, M, C, A.
const letterY = pose({ drop: 0.012, nod: -8, armR: arm(155, 5, 0, 0, 'flat'), armL: arm(155, 5, 0, 0, 'flat') });
const letterM = pose({ drop: 0.03, armR: reach([0.04, 0.27, 0.02], [1, 0.4, 0], 'flat'), armL: reach([0.04, 0.27, 0.02], [1, 0.4, 0], 'flat') });
const letterC = pose({ x: 0.03, hipTilt: -4, lean: -8, headTilt: -5, armR: reach([-0.12, 0.33, 0.05], [1, 1, 0], 'flat'), armL: reach([0.3, 0.3, 0.05], [1, -0.5, 0], 'flat') });
const letterA = pose({ drop: 0, footR: foot(0.16), footL: foot(-0.16), armR: reach([0.035, 0.33, 0.06], [1, 0, 0], 'flat', 25), armL: reach([0.035, 0.33, 0.06], [1, 0, 0], 'flat', 25) });
// 5. Knee lifts: drive one knee up to the opposite elbow.
const stepOn = pose({ yaw: -15, x: 0.06, hipTilt: 4, lean: -2, drop: 0.03, footR: foot(0.1), footL: foot(-0.1),
  armR: arm(30, 40, 90, 0, 'fist'), armL: arm(80, 20, 100, -60, 'fist') });
const kneeUp = pose({ yaw: -25, x: 0.075, hipTilt: 9, lean: -5, twist: -20, bend: 15, drop: 0.008, footR: foot(0.1), footL: foot(-0.01, 0.12, 0.2, 0, 0),
  armR: arm(60, 120, 100, 0, 'fist'), armL: arm(40, -30, 80, 0, 'fist') });
// 6. A star jump, then a full turn on one foot.
const squat = pose({ drop: 0.11, bend: 15, footR: foot(0.12), footL: foot(-0.12), armR: arm(25, -30, 20), armL: arm(25, -30, 20) });
const star = pose({ drop: 0, footR: foot(0.24, 0, 0.11), footL: foot(-0.24, 0, 0.11), armR: arm(130, 0, 0, 0, 'spread'), armL: arm(130, 0, 0, 0, 'spread') });
const land = pose({ drop: 0.1, bend: 10, footR: foot(0.13), footL: foot(-0.13), armR: arm(45, 40, 60), armL: arm(45, 40, 60) });
const prep = pose({ drop: 0.06, x: 0.03, footR: foot(0.05), footL: foot(-0.13, 0.03), armR: arm(80, 70, 70), armL: arm(80, -10, 15) });
// Up on the ball of one foot, the other at its knee, arms overhead. `glide` keeps the turn moving at an even speed.
const pirouette = (yaw) => pose({ yaw, spin: 90, glide: true, drop: 0.005, footR: foot(0, 0, 0, 1, 0), footL: foot(-0.03, 0.03, 0.23, 0, 55),
  armR: reach([0.04, 0.33, 0.04], [1, 0.3, 0.3]), armL: reach([0.04, 0.33, 0.04], [1, 0.3, 0.3]) });
const spun = pose({ spin: 90, glide: true, drop: 0.05, footR: foot(0.12), footL: foot(-0.12), armR: arm(60, 10, 15, 0, 'spread'), armL: arm(60, 10, 15, 0, 'spread') });
// 7. Arm wave: a ripple that runs from the left hand, across the shoulders, out the right hand.
const OUT = arm(90, 0, 0, 0, 'flat');
const wave = [
  pose({ armL: OUT, armR: OUT }),
  pose({ armL: arm(78, 0, 48, -90, 'flat', 30), armR: OUT, lean: -2 }),
  pose({ armL: arm(112, 0, 44, 90, 'flat', -30), armR: OUT, lean: -3, headTilt: -4 }),
  pose({ armL: arm(84, 0, 6, 90, 'flat'), armR: arm(84, 0, 6, 90, 'flat'), drop: 0.035 }),
  pose({ armL: OUT, armR: arm(112, 0, 44, 90, 'flat', -30), lean: 3, headTilt: 4 }),
  pose({ armL: OUT, armR: arm(78, 0, 48, -90, 'flat', 30), lean: 2 }),
  pose({ armL: OUT, armR: OUT }),
  pose({ armL: arm(60, 0, 20), armR: arm(60, 0, 20), drop: 0.03 }),
];
// 8. Walk like an Egyptian, in profile, then a side kick to finish.
const egyptian = pose({ yaw: 90, x: 0, hipTilt: 4, drop: 0.03, footR: foot(0.08, 0.1), footL: foot(-0.08, -0.08, 0, 0.6),
  armR: arm(70, -90, 90, 0, 'flat', -80), armL: arm(90, 90, 90, 0, 'flat', -80) });
const finish = pose({ yaw: -10, x: -0.05, hipTilt: -8, lean: 8, headTilt: 5, drop: 0.005, footR: foot(0.34, 0, 0.22), footL: foot(-0.12),
  armR: arm(150, 10, 0, 0, 'point'), armL: arm(95, 0, 10) });

const KEYS = [
  [0, step], [1, touch], [2, mirror(step)], [3, mirror(touch)],
  [4, discoUp], [5, discoDown], [6, discoUp], [7, discoDown],
  [8, floss], [8.5, mirror(floss)], [9, floss], [9.5, mirror(floss)], [10, floss], [10.5, mirror(floss)], [11, floss], [11.5, mirror(floss)],
  [12, letterY], [13, letterM], [14, letterC], [15, letterA],
  [16, stepOn], [17, kneeUp], [18, mirror(stepOn)], [19, mirror(kneeUp)],
  [20, squat], [20.5, star], [21, land], [21.5, prep], [22, pirouette(90)], [22.5, pirouette(180)], [23, pirouette(270)], [23.5, spun],
  ...wave.map((w, i) => [24 + i / 2, w]),
  [28, egyptian], [29, mirror(egyptian)], [30, egyptian], [30.5, mirror(egyptian)],
  [31, finish],
];
const BEATS = 32;               // length of the routine
const SNAP = 0.8;               // fraction of the gap spent moving; the rest holds the pose
const LAG = 0.08;               // how far (in beats) elbows, hands and the head trail the body

function poseAt(beat) {
  const b = ((beat % BEATS) + BEATS) % BEATS;
  let i = KEYS.length - 1;
  for (let k = 0; k < KEYS.length; k++) if (KEYS[k][0] <= b) i = k;
  const [t0, from] = KEYS[i], [t1raw, to] = KEYS[(i + 1) % KEYS.length];
  const t1 = t1raw <= t0 ? t1raw + BEATS : t1raw;
  const t = to.glide ? (b - t0) / (t1 - t0) : Math.min(1, (b - t0) / (t1 - t0) / SNAP);
  const s = to.glide ? t : t * t * (3 - 2 * t);
  const mix = (a, c) => a + (c - a) * s;
  const mixAll = (a, c) => Object.fromEntries(Object.keys(a).map((k) => [k, Array.isArray(a[k]) ? a[k].map((v, j) => mix(v, c[k][j])) : mix(a[k], c[k])]));
  const footOf = (a, c) => {
    const f = mixAll(a, c);
    // A foot sliding along the floor picks itself up on the way.
    if (a.lift < 0.005 && c.lift < 0.005) f.lift += 0.035 * Math.sin(Math.PI * s) * Math.min(1, Math.hypot(c.x - a.x, c.z - a.z) / 0.06);
    return f;
  };
  const out = {};
  for (const key of ['x', 'z', 'drop', 'hipTilt', 'hipTwist', 'lean', 'bend', 'twist', 'headTilt', 'nod', 'turn']) out[key] = mix(from[key], to[key]);
  const shortest = ((((to.yaw - from.yaw) % 360) + 540) % 360) - 180;
  out.yaw = from.yaw + (to.spin ?? shortest) * s;
  out.drop += 0.01 * (0.5 + 0.5 * Math.cos(beat * 2 * Math.PI));    // sink into each beat
  out.footR = footOf(from.footR, to.footR); out.footL = footOf(from.footL, to.footL);
  out.armR = mixAll(from.armR, to.armR); out.armL = mixAll(from.armL, to.armL);
  return out;
}

// --- Tracing -------------------------------------------------------------------
// Every closed outline of the silhouette: the outer edge, holes, and any islands.
function traceOutlines(field, { x0, x1, y0, y1 }) {
  const nx = Math.ceil((x1 - x0) / GRID) + 1, ny = Math.ceil((y1 - y0) / GRID) + 1;
  const v = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = field(x0 + i * GRID, y0 + j * GRID);
  const X0 = (i) => x0 + i * GRID, Y0 = (j) => y0 + j * GRID;

  // Crossing point on a cell edge, keyed so neighbouring cells share it.
  const pts = new Map();
  function edgePt(i, j, horiz) {
    const key = (horiz ? 'h' : 'v') + i + ',' + j;
    if (!pts.has(key)) {
      const a = v[j * nx + i], b = horiz ? v[j * nx + i + 1] : v[(j + 1) * nx + i];
      const t = a / (a - b);
      pts.set(key, horiz ? { x: X0(i) + t * GRID, y: Y0(j) } : { x: X0(i), y: Y0(j) + t * GRID });
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
  // Walk the links into closed loops, dropping specks.
  const seen = new Set(), loops = [];
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
    if (Math.abs(signedArea(loop)) >= MIN_AREA) loops.push(loop);
  }
  return loops;
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

// Simplifies a closed loop, split at its top point and the point farthest from it.
function simplifyLoop(loop) {
  let top = 0;
  for (let i = 1; i < loop.length; i++) if (loop[i].y > loop[top].y) top = i;
  const ring = loop.slice(top).concat(loop.slice(0, top));
  let far = 0, farD = 0;
  for (let i = 0; i < ring.length; i++) { const d = Math.hypot(ring[i].x - ring[0].x, ring[i].y - ring[0].y); if (d > farD) { farD = d; far = i; } }
  const a = simplifyOpen(ring.slice(0, far + 1), SIMPLIFY_TOL);
  const b = simplifyOpen(ring.slice(far).concat([ring[0]]), SIMPLIFY_TOL);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

// Renders one pose to its outlines, in integer units.
function render(p, late) {
  const { field, bounds } = silhouette(buildBody(p, late));
  return traceOutlines(field, bounds).map(simplifyLoop)
    .map((loop) => loop.map((pt) => ({ x: Math.round(pt.x * UNITS), y: Math.round(pt.y * UNITS) })));
}

// Google's polyline encoding: each number zig-zagged, then written five bits to a character.
function encode(nums) {
  let s = '';
  for (const n of nums) {
    let v = n < 0 ? ~(n << 1) : n << 1;
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    s += String.fromCharCode(v + 63);
  }
  return s;
}
// Each outline is a run of (dx, dy) steps from the origin; outlines are separated by spaces.
const encodeFrame = (loops) => loops.map((loop) => encode(loop.flatMap((pt, i) => {
  const prev = i ? loop[i - 1] : { x: 0, y: 0 };
  return [pt.x - prev.x, pt.y - prev.y];
}))).join(' ');

// --- Bake ----------------------------------------------------------------------
const flag = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const cell = Number(flag('--cell') ?? 230);

if (flag('--turn')) {
  const still = pose({ armR: arm(25, 10, 25), armL: arm(25, 10, 25) });
  const yaws = (flag('--yaws') ?? '0,45,90,135,180,225,270,315').split(',').map(Number);
  writeContactSheet(flag('--turn'), yaws.map((yaw) => render({ ...still, yaw }, { ...still, yaw })), cell);
} else if (flag('--keys')) {
  writeContactSheet(flag('--keys'), KEYS.map(([, k]) => render(k, k)), cell);
} else {
  const total = BEATS * FRAMES_PER_BEAT;
  const frames = [];
  const started = Date.now();
  for (let f = 0; f < total; f++) {
    const beat = f / FRAMES_PER_BEAT;
    frames.push(render(poseAt(beat), poseAt(beat - LAG)));
  }
  const fps = (FRAMES_PER_BEAT * BPM) / 60;
  const src = `// GENERATED by tools/make_dancer_sprites.mjs - edit that script, not this file.
//
// The hero's dancer as a sprite sheet: ${total} frames covering a ${BEATS}-beat routine, to be
// played stepped at ${fps.toFixed(1)} frames a second. Each frame is the figure's silhouette as
// closed outlines (the outer edge, and any holes), to be filled with the even-odd rule.
// An outline is a string of (dx, dy) steps in Google's polyline encoding, in 1/${UNITS}ths
// of the figure's standing height, from the ground at y = 0, with y pointing up.
// A frame's outlines are separated by spaces.
window.DANCER_SPRITES = {
  units: ${UNITS},
  fps: ${fps.toFixed(2)},
  framesPerBeat: ${FRAMES_PER_BEAT},
  frames: [
${frames.map((fr) => `    ${JSON.stringify(encodeFrame(fr))},`).join('\n')}
  ],
};
`;
  writeFileSync(OUT_FILE, src);
  console.log(`wrote ${OUT_FILE} (${(src.length / 1024).toFixed(1)} KB, ${(deflateSync(src).length / 1024).toFixed(1)} KB compressed), ${total} frames in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`points per frame: ${frames.map((f) => f.reduce((n, l) => n + l.length, 0)).join(' ')}`);
  if (flag('--png')) {
    const step = Number(flag('--step') ?? 1);
    writeContactSheet(flag('--png'), frames.filter((_, i) => i % step === 0), cell);
  }
}

// --- Contact sheet ----------------------------------------------------------------
// Each frame filled in the page's background colour in front of a glow, as on the site.
function writeContactSheet(file, list, size) {
  const cols = Math.min(8, list.length), rows = Math.ceil(list.length / cols);
  const W = cols * size, H = rows * size;
  const BG = [17, 17, 24], GLOW = [255, 90, 54];
  const img = new Float32Array(W * H * 3);
  const tall = size * 0.6;
  list.forEach((loops, k) => {
    const ox = (k % cols) * size, oy = Math.floor(k / cols) * size;
    const cx = ox + size / 2, floor = oy + size - 14;
    const gx = cx, gy = floor - tall * 0.55, gr = tall * 0.95;
    for (let y = oy; y < oy + size; y++) {
      for (let x = ox; x < ox + size; x++) {
        const r = Math.hypot(x + 0.5 - gx, y + 0.5 - gy) / gr;
        const a = Math.max(0, 1 - r) ** 1.6 * 0.6;
        for (let c = 0; c < 3; c++) img[(y * W + x) * 3 + c] = BG[c] + (GLOW[c] - BG[c]) * a;
      }
    }
    const cover = fillCoverage(loops.map((loop) => loop.map((pt) => [cx + pt.x / UNITS * tall, floor - pt.y / UNITS * tall])), W, H);
    for (const [i, a] of cover) for (let c = 0; c < 3; c++) img[i * 3 + c] += (BG[c] - img[i * 3 + c]) * Math.min(1, a);
  });
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let i = 0; i < W * 3; i++) raw[y * (W * 3 + 1) + 1 + i] = Math.max(0, Math.min(255, Math.round(img[y * W * 3 + i])));
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb)); return Buffer.concat([len, tb, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  console.log(`contact sheet: ${file}`);
}

// Even-odd fill coverage of some polygons, 4 samples down each pixel: Map of pixel index to coverage.
function fillCoverage(polys, W, H) {
  const edges = polys.flatMap((poly) => poly.map((a, i) => [a, poly[(i + 1) % poly.length]]));
  const cover = new Map();
  const addTo = (i, a) => cover.set(i, (cover.get(i) || 0) + a);
  const ys = edges.flatMap(([a, b]) => [a[1], b[1]]);
  const top = Math.max(0, Math.floor(Math.min(...ys))), bottom = Math.min(H - 1, Math.ceil(Math.max(...ys)));
  for (let row = top; row <= bottom; row++) {
    for (let sub = 0; sub < 4; sub++) {
      const y = row + (sub + 0.5) / 4;
      const xs = [];
      for (const [a, b] of edges) if ((a[1] <= y) !== (b[1] <= y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const xa = Math.max(0, xs[n]), xb = Math.min(W, xs[n + 1]);
        if (xb <= xa) continue;
        const ia = Math.floor(xa), ib = Math.floor(xb);
        if (ia === ib) { addTo(row * W + ia, (xb - xa) / 4); continue; }
        addTo(row * W + ia, (ia + 1 - xa) / 4);
        for (let i = ia + 1; i < ib; i++) addTo(row * W + i, 0.25);
        if (ib < W) addTo(row * W + ib, (xb - ib) / 4);
      }
    }
  }
  return cover;
}
