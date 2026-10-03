// A dancing figure behind the hero, project filters, and a screenshot lightbox.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The dancer is a sprite sheet (assets/dancer_sprites.js, baked by tools/make_dancer_sprites.mjs from
  // a 3D figure): each frame is the figure's silhouette, played stepped. It's filled in the page's own
  // background colour in front of a glow, so it only shows as a shape cut out of the light.
  const canvas = document.querySelector('.dancer');
  const sprites = window.DANCER_SPRITES;
  if (canvas && sprites) {
    const ctx = canvas.getContext('2d');
    const STILL = 4 * sprites.framesPerBeat;   // the disco point, for visitors who prefer no motion
    const bg = getComputedStyle(document.body).backgroundColor;

    // A frame's outlines are polyline-encoded (dx, dy) steps, separated by spaces. Each becomes a
    // smooth closed curve through the midpoints of its edges, with y flipped to point down.
    const paths = [];
    const pathOf = (index) => {
      if (paths[index]) return paths[index];
      const path = new Path2D();
      for (const outline of sprites.frames[index].split(' ')) {
        const pts = [];
        let x = 0, y = 0;
        for (let i = 0; i < outline.length;) {
          for (let k = 0; k < 2; k++) {
            let v = 0, shift = 0, c;
            do { c = outline.charCodeAt(i++) - 63; v |= (c & 31) << shift; shift += 5; } while (c >= 32);
            const d = v & 1 ? ~(v >> 1) : v >> 1;
            k ? (y -= d) : (x += d);
          }
          pts.push([x, y]);
        }
        const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        path.moveTo(...mid(pts[pts.length - 1], pts[0]));
        pts.forEach((p, i) => path.quadraticCurveTo(p[0], p[1], ...mid(p, pts[(i + 1) % pts.length])));
        path.closePath();
      }
      return (paths[index] = path);
    };

    let w = 0, h = 0, fold = 0, shown = -1;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // How much of the banner shows on first load, so the dancer's feet stay above the fold.
      fold = innerHeight - (canvas.getBoundingClientRect().top + scrollY);
      shown = -1;
    };

    const draw = (index) => {
      const narrow = w < 760;
      const view = fold > 160 ? Math.min(h, fold) : h;   // ignore the fold if the window had no real height yet
      const tall = Math.min(view * (narrow ? 0.4 : 0.58), w * (narrow ? 0.5 : 0.28));  // standing height, px
      const cx = w * (narrow ? 0.76 : 0.82);
      const floor = Math.min(h * (narrow ? 0.97 : 0.9), view - (narrow ? 24 : 48));
      ctx.clearRect(0, 0, w, h);
      if (tall < 1) return;

      // The light behind the dancer: brightest behind the chest, and a little taller than it is wide.
      ctx.save();
      ctx.translate(cx, floor - tall * 0.52);
      ctx.scale(1, 1.25);
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, tall * 0.82);
      glow.addColorStop(0, 'rgba(255, 112, 70, 0.66)');
      glow.addColorStop(0.4, 'rgba(255, 90, 54, 0.34)');
      glow.addColorStop(0.75, 'rgba(255, 79, 163, 0.09)');
      glow.addColorStop(1, 'rgba(255, 79, 163, 0)');
      ctx.fillStyle = glow;
      ctx.globalAlpha = narrow ? 0.6 : 1;      // softer behind the text on phones
      ctx.fillRect(-w, -h, 2 * w, 2 * h);
      ctx.restore();

      // The figure, in the background colour.
      ctx.save();
      ctx.translate(cx, floor);
      ctx.scale(tall / sprites.units, tall / sprites.units);
      ctx.fillStyle = bg;
      ctx.fill(pathOf(index), 'evenodd');
      ctx.restore();
    };

    const frame = (now) => {
      requestAnimationFrame(frame);
      const index = Math.floor((now / 1000) * sprites.fps) % sprites.frames.length;
      if (index !== shown) { shown = index; draw(index); }
    };

    resize();
    addEventListener('resize', () => { resize(); if (reduced) draw(STILL); });
    reduced ? draw(STILL) : requestAnimationFrame(frame);
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
