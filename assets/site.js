// A dancing figure behind the hero, project filters, and a screenshot lightbox.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The dancer is a sprite sheet (assets/dancer_sprites.js, baked by tools/make_dancer_sprites.mjs):
  // each frame is one closed outline of the whole figure, drawn as a single line and played stepped.
  const canvas = document.querySelector('.dancer');
  const sprites = window.DANCER_SPRITES;
  if (canvas && sprites) {
    const ctx = canvas.getContext('2d');
    const STILL = 4 * sprites.framesPerBeat;   // the disco point, for visitors who prefer no motion

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
      const pts = sprites.frames[index];
      const narrow = w < 760;
      const tall = Math.min(Math.min(h, fold) * (narrow ? 0.4 : 0.6), w * (narrow ? 0.5 : 0.3));  // standing height, px
      const cx = w * (narrow ? 0.76 : 0.82);
      const floor = Math.min(h * (narrow ? 0.97 : 0.9), fold - (narrow ? 24 : 48));
      const k = tall / sprites.units;
      ctx.clearRect(0, 0, w, h);

      // A soft spotlight and a pool of light on the floor.
      const glow = ctx.createRadialGradient(cx, floor - tall * 0.5, 0, cx, floor - tall * 0.5, tall * 0.75);
      glow.addColorStop(0, 'rgba(255, 90, 54, 0.13)');
      glow.addColorStop(1, 'rgba(255, 90, 54, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255, 210, 63, 0.06)';
      ctx.beginPath();
      ctx.ellipse(cx, floor, tall * 0.3, tall * 0.04, 0, 0, Math.PI * 2);
      ctx.fill();

      // The figure: one continuous line.
      const line = ctx.createLinearGradient(0, floor - tall * 1.2, 0, floor);
      line.addColorStop(0, '#ff4fa3');
      line.addColorStop(1, '#ff5a36');
      ctx.beginPath();
      ctx.moveTo(cx + pts[0] * k, floor - pts[1] * k);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(cx + pts[i] * k, floor - pts[i + 1] * k);
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.lineWidth = narrow ? 2 : 2.5;
      ctx.strokeStyle = line;
      ctx.shadowColor = 'rgba(255, 90, 54, 0.75)';
      ctx.shadowBlur = narrow ? 8 : 14;
      ctx.globalAlpha = narrow ? 0.45 : 0.95;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    };

    const frame = (now) => {
      const index = Math.floor((now / 1000) * sprites.fps) % sprites.frames.length;
      if (index !== shown) { shown = index; draw(index); }
      requestAnimationFrame(frame);
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
