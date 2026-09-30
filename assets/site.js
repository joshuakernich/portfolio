// A dancing silhouette behind the hero, project filters, and a screenshot lightbox.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const canvas = document.querySelector('.dancer');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const BEAT = 60 / 116; // seconds per beat

    // A pose is a set of joint angles in degrees. Arms and legs are measured from hanging straight
    // down, positive swinging outward; elbows and knees are relative to the limb above them.
    // Limbs are rigid, so the figure moves like baked sprite frames rather than stretching.
    const pose = (lean, sway, la, ra, ll, rl, head = 0) => ({ lean, sway, la, ra, ll, rl, head });
    const mirror = (p) => pose(-p.lean, -p.sway, p.ra, p.la, p.rl, p.ll, -p.head);
    const grooveDown = pose(0, -0.2, [30, 140], [30, 140], [16, -20], [16, -20], -4);
    const grooveUp = pose(0, 0.2, [22, 120], [22, 120], [6, -6], [6, -6], 4);
    const discoRight = pose(-6, -0.3, [-18, 0], [148, 4], [10, -8], [4, -2], 8);
    const waveLeft = pose(8, 0.3, [150, 25], [140, 35], [4, -2], [18, -16], -6);
    const kneeLeft = pose(5, 0.25, [60, 70], [55, 80], [52, -95], [4, -2], 0);
    const handsUp = pose(0, 0, [100, 70], [100, 70], [22, -26], [22, -26], 0);
    const clap = pose(0, 0, [168, 25], [168, 25], [8, -6], [8, -6], 0);
    const routine = [
      grooveDown, grooveUp, grooveDown, grooveUp,
      discoRight, mirror(discoRight), discoRight, mirror(discoRight),
      waveLeft, mirror(waveLeft), kneeLeft, mirror(kneeLeft),
      handsUp, clap, handsUp, clap,
    ];

    const mix = (a, b, t) => a + (b - a) * t;
    const mixPair = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t)];
    const blend = (a, b, t) => pose(mix(a.lean, b.lean, t), mix(a.sway, b.sway, t), mixPair(a.la, b.la, t),
      mixPair(a.ra, b.ra, t), mixPair(a.ll, b.ll, t), mixPair(a.rl, b.rl, t), mix(a.head, b.head, t));
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const rad = (d) => (d * Math.PI) / 180;

    // The figure is drawn solid on its own layer, then faded as one piece, so overlapping limbs
    // never show seams: it reads as a single clean silhouette.
    const layer = document.createElement('canvas');
    const lctx = layer.getContext('2d');
    let w = 0, h = 0, fold = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth; h = canvas.clientHeight;
      // How much of the banner shows on first load, so the dancer's feet stay above the fold.
      fold = innerHeight - (canvas.getBoundingClientRect().top + scrollY);
      for (const [c, x] of [[canvas, ctx], [layer, lctx]]) {
        c.width = w * dpr; c.height = h * dpr;
        x.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };

    // Lays out the skeleton for a pose with its lowest foot on the floor.
    const skeleton = (p, U, cx, floor, bounce) => {
      const lean = rad(p.lean);
      const up = [Math.sin(lean), -Math.cos(lean)];
      const side = [Math.cos(lean), Math.sin(lean)];
      const at = (o, v, k) => [o[0] + v[0] * k, o[1] + v[1] * k];
      const pelvis = [cx + p.sway * U, 0];
      const chest = at(pelvis, up, 2.3 * U);
      const limb = (origin, a, bend, len1, len2, dirOut, frame) => {
        const dir = (deg) => {
          const r = rad(deg);
          return frame ? [frame.down[0] * Math.cos(r) + frame.out[0] * Math.sin(r), frame.down[1] * Math.cos(r) + frame.out[1] * Math.sin(r)]
            : [dirOut * Math.sin(r), Math.cos(r)];
        };
        const mid = at(origin, dir(a), len1);
        return [origin, mid, at(mid, dir(a + bend), len2)];
      };
      const armFrame = (s) => ({ down: [-up[0], -up[1]], out: [side[0] * s, side[1] * s] });
      const shoulderL = at(at(chest, side, -0.9 * U), up, -0.15 * U);
      const shoulderR = at(at(chest, side, 0.9 * U), up, -0.15 * U);
      const armL = limb(shoulderL, p.la[0], p.la[1], 1.45 * U, 1.3 * U, 0, armFrame(-1));
      const armR = limb(shoulderR, p.ra[0], p.ra[1], 1.45 * U, 1.3 * U, 0, armFrame(1));
      const hipL = [pelvis[0] - 0.55 * U, 0], hipR = [pelvis[0] + 0.55 * U, 0];
      const legL = limb(hipL, p.ll[0] + bounce, p.ll[1] - bounce * 1.6, 1.9 * U, 1.85 * U, -1);
      const legR = limb(hipR, p.rl[0] + bounce, p.rl[1] - bounce * 1.6, 1.9 * U, 1.85 * U, 1);
      const lift = floor - 0.12 * U - Math.max(legL[2][1], legR[2][1]);
      const move = (pt) => [pt[0], pt[1] + lift];
      const tilt = rad(p.head);
      const headUp = [Math.sin(lean + tilt), -Math.cos(lean + tilt)];
      const neck = at(chest, up, 0.3 * U);
      const head = at(neck, headUp, 0.55 * U);
      return {
        U, up, side,
        pelvis: move(pelvis), chest: move(chest), neck: move(neck), head: move(head),
        bun: move(at(head, headUp, 0.62 * U)),
        shoulderL: move(shoulderL), shoulderR: move(shoulderR),
        armL: armL.map(move), armR: armR.map(move), legL: legL.map(move), legR: legR.map(move),
      };
    };

    const line = (pts, width) => {
      lctx.lineWidth = width;
      lctx.beginPath();
      lctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) lctx.lineTo(pts[i][0], pts[i][1]);
      lctx.stroke();
    };
    const dot = (pt, r) => { lctx.beginPath(); lctx.arc(pt[0], pt[1], r, 0, Math.PI * 2); lctx.fill(); };

    const draw = (p, bounce) => {
      ctx.clearRect(0, 0, w, h);
      const narrow = w < 760;
      const U = Math.min((Math.min(h, fold) * (narrow ? 0.4 : 0.66)) / 7.6, (w * (narrow ? 0.3 : 0.22)) / 4.6);
      const cx = w * (narrow ? 0.8 : 0.82);
      const floor = Math.min(h * (narrow ? 0.97 : 0.9), fold - (narrow ? 24 : 48));
      const s = skeleton(p, U, cx, floor, bounce);

      // A soft spotlight and a pool of light on the floor.
      const glow = ctx.createRadialGradient(cx, floor - 3.8 * U, 0, cx, floor - 3.8 * U, 5.5 * U);
      glow.addColorStop(0, 'rgba(255, 90, 54, 0.16)');
      glow.addColorStop(1, 'rgba(255, 90, 54, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255, 210, 63, 0.07)';
      ctx.beginPath();
      ctx.ellipse(s.pelvis[0], floor, 2.2 * U, 0.34 * U, 0, 0, Math.PI * 2);
      ctx.fill();

      // One colour for every part, so the limbs merge into a single silhouette.
      const paint = lctx.createLinearGradient(0, floor - 7.6 * U, 0, floor);
      paint.addColorStop(0, '#ff4fa3');
      paint.addColorStop(1, '#ff5a36');
      lctx.clearRect(0, 0, w, h);
      lctx.fillStyle = paint; lctx.strokeStyle = paint;
      lctx.lineCap = 'round'; lctx.lineJoin = 'round';

      const { up, side } = s;
      const at = (o, v, k) => [o[0] + v[0] * k, o[1] + v[1] * k];
      const waist = at(s.pelvis, up, 0.9 * U);
      lctx.beginPath();
      [at(s.chest, side, -0.8 * U), at(s.chest, side, 0.8 * U), at(waist, side, 0.62 * U), at(s.pelvis, side, 0.72 * U),
        at(s.pelvis, side, -0.72 * U), at(waist, side, -0.62 * U)].forEach((pt, i) => (i ? lctx.lineTo(...pt) : lctx.moveTo(...pt)));
      lctx.closePath(); lctx.fill();
      lctx.lineWidth = 0.3 * U; lctx.stroke();

      line([s.shoulderL, s.shoulderR], 0.62 * U);
      line([s.chest, s.neck], 0.38 * U);
      dot(s.head, 0.52 * U);
      dot(s.bun, 0.22 * U);
      for (const arm of [s.armL, s.armR]) {
        line([arm[0], arm[1]], 0.44 * U);
        line([arm[1], arm[2]], 0.36 * U);
        dot(arm[2], 0.26 * U);
      }
      for (const [leg, dir] of [[s.legL, -1], [s.legR, 1]]) {
        line([leg[0], leg[1]], 0.64 * U);
        line([leg[1], leg[2]], 0.48 * U);
        line([leg[2], [leg[2][0] + dir * 0.42 * U, leg[2][1] + 0.1 * U]], 0.34 * U);
      }
      ctx.globalAlpha = narrow ? 0.3 : 0.55;
      ctx.drawImage(layer, 0, 0, w, h);
      ctx.globalAlpha = 1;
    };

    const frame = (now) => {
      const beats = now / 1000 / BEAT;
      const i = Math.floor(beats) % routine.length;
      const f = beats - Math.floor(beats);
      const p = blend(routine[i], routine[(i + 1) % routine.length], ease(Math.min(1, f * 1.7)));
      draw(p, 7 * (0.5 - 0.5 * Math.cos(f * Math.PI * 2)));
      requestAnimationFrame(frame);
    };

    resize();
    addEventListener('resize', () => { resize(); if (reduced) draw(discoRight, 0); });
    reduced ? draw(discoRight, 0) : requestAnimationFrame(frame);
  }

  const chips = document.querySelectorAll('.filters .chip');
  chips.forEach((chip) => chip.addEventListener('click', () => {
    chips.forEach((c) => c.classList.toggle('is-on', c === chip));
    const f = chip.dataset.filter;
    document.querySelectorAll('.card').forEach((card) => {
      card.classList.toggle('is-hidden', f !== 'all' && card.dataset.group !== f);
    });
  }));

  const box = document.querySelector('.lightbox');
  if (box) {
    const img = box.querySelector('img');
    document.querySelectorAll('.shot').forEach((a) => a.addEventListener('click', (ev) => {
      ev.preventDefault();
      img.src = a.href;
      box.showModal();
    }));
    box.addEventListener('click', () => box.close());
  }
})();
