// Falling Tetriminos behind the hero, project filters, and a screenshot lightbox.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const canvas = document.querySelector('.blocks');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const colours = ['#ff5a36', '#ffd23f', '#38d4e8', '#3ddc84', '#ff4fa3', '#a06bff', '#4d7cff'];
    const shapes = [
      [[0, 0], [1, 0], [2, 0], [3, 0]], [[0, 0], [1, 0], [0, 1], [1, 1]],
      [[0, 0], [1, 0], [2, 0], [1, 1]], [[0, 0], [0, 1], [1, 1], [2, 1]],
      [[2, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [2, 0], [0, 1], [1, 1]],
      [[0, 0], [1, 0], [1, 1], [2, 1]],
    ];
    const cell = 22;
    let pieces = [];
    let w = 0, h = 0;

    const spawn = (y) => ({
      shape: shapes[Math.floor(Math.random() * shapes.length)],
      colour: colours[Math.floor(Math.random() * colours.length)],
      x: Math.floor(Math.random() * (w / cell)) * cell,
      y: y ?? -cell * 4,
      speed: 0.25 + Math.random() * 0.6,
    });

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      pieces = Array.from({ length: Math.round(w / 90) }, () => spawn(Math.random() * h));
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of pieces) {
        ctx.fillStyle = p.colour;
        for (const [cx, cy] of p.shape) {
          ctx.globalAlpha = 0.35;
          ctx.fillRect(p.x + cx * cell, Math.round(p.y) + cy * cell, cell - 3, cell - 3);
        }
      }
      ctx.globalAlpha = 1;
    };

    const tick = () => {
      for (let i = 0; i < pieces.length; i++) {
        pieces[i].y += pieces[i].speed;
        if (pieces[i].y > h + cell) pieces[i] = spawn();
      }
      draw();
      requestAnimationFrame(tick);
    };

    resize();
    addEventListener('resize', resize);
    reduced ? draw() : requestAnimationFrame(tick);
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
