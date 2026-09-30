"""Builds the static site from projects.py. Run: python3 build.py"""
import hashlib
from html import escape
from pathlib import Path

from projects import GROUPS, PROJECTS

ROOT = Path(__file__).parent
SITE = "https://joshuakernich.com"
EMAIL = "joshua.kernich@gmail.com"
PHONE = "+61 430 568 985"
LINKEDIN = "https://www.linkedin.com/in/joshua-kernich-79158431"
CV = "cv/Joshua-Kernich-CV.pdf"
# Changes whenever the CSS or JS changes, so browsers fetch the new files.
VERSION = hashlib.md5((ROOT / "assets/style.css").read_bytes() + (ROOT / "assets/site.js").read_bytes()).hexdigest()[:8]

e = escape


def page(title, description, body, root, path=""):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(description)}">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:url" content="{SITE}/{path}">
<link rel="icon" href="{root}assets/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Press+Start+2P&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{root}assets/style.css?v={VERSION}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav">
  <a class="brand" href="{root}"><span class="brand-block" aria-hidden="true"></span>Joshua Kernich</a>
  <nav>
    <a href="{root}#levels">Projects</a>
    <a href="{root}#about">About</a>
    <a href="{root}#contact">Contact</a>
    <a class="btn btn-small" href="{root}{CV}" download>CV ↓</a>
  </nav>
</header>
<main id="main">
{body}
</main>
<footer class="footer">
  <p>© Joshua Kernich · <a href="mailto:{EMAIL}">{EMAIL}</a></p>
  <p class="pixel small">Thanks for playing</p>
</footer>
<script src="{root}assets/site.js?v={VERSION}" defer></script>
</body>
</html>
"""


def card(p, i):
    img = (f'<img src="assets/img/{p["hero"]}" alt="" loading="lazy">' if p["hero"]
           else f'<div class="placeholder"><span>{e(p["title"])}</span></div>')
    status = f'<span class="badge">{e(p["status"])}</span>' if p.get("status") else ""
    return f"""<a class="card c-{p['colour']}" href="projects/{p['slug']}/" data-group="{p['group']}">
  <div class="card-img">{img}{status}</div>
  <div class="card-body">
    <span class="pixel level">LV {i:02d}</span>
    <h3>{e(p.get('short', p['title']))}</h3>
    <p>{e(p['summary'])}</p>
    <span class="card-client">{e(p['client'])}</span>
  </div>
</a>"""


def home():
    cards = "\n".join(card(p, i + 1) for i, p in enumerate(PROJECTS))
    filters = "".join(f'<button class="chip" data-filter="{k}">{e(v)}</button>' for k, v in GROUPS.items())
    body = f"""
<section class="hero">
  <canvas class="blocks" aria-hidden="true"></canvas>
  <div class="hero-inner">
    <p class="pixel eyebrow">Player 1 · Experience Designer</p>
    <h1>I design games you play with your <span class="hl">whole body</span>.</h1>
    <p class="lede">I'm Joshua Kernich, an experience designer, technologist and storyteller. For 15 years I've made games and installations with motion tracking, LiDAR, AR, lasers, MIDI instruments, smart lights and live theatre. Most recently I've been Director of Experience Design at Immersive Gamebox.</p>
    <div class="cta">
      <a class="btn" href="#levels"><span class="blink">▶</span> Press start</a>
      <a class="btn btn-ghost" href="{CV}" download>Download CV</a>
    </div>
    <ul class="stats">
      <li><b>7</b><span>Gamebox games designed</span></li>
      <li><b>15</b><span>years designing play</span></li>
      <li><b>6</b><span>players per room, no controllers</span></li>
    </ul>
  </div>
</section>

<section class="levels" id="levels">
  <div class="section-head">
    <h2><span class="pixel">Level select</span></h2>
    <div class="filters" role="group" aria-label="Filter projects">
      <button class="chip is-on" data-filter="all">All</button>{filters}
    </div>
  </div>
  <div class="grid">
{cards}
  </div>
</section>

<section class="about" id="about">
  <div class="about-photo"><img src="assets/img/me.jpg" alt="Joshua Kernich" loading="lazy"></div>
  <div class="about-text">
    <h2><span class="pixel">About the player</span></h2>
    <p>I bring storytelling, game design, music and technology together to make experiences people play with each other, not just with a screen.</p>
    <p>At Immersive Gamebox I led the development team and ran the whole creative process for each game, from storyboards and prototypes to launch in venues internationally. Before that, I designed products and learning experiences at Orbit29, Movember, Gripable and McGraw Hill. I also make my own installations and shows.</p>
    <h3 class="pixel small">Inventory</h3>
    <ul class="inventory">
      <li>Game design</li><li>Narrative</li><li>UI / HUD</li><li>Storyboards</li><li>Hi-fi prototypes</li><li>Playtesting</li><li>Art direction</li><li>Unity</li><li>Figma</li><li>Photoshop</li><li>Illustrator</li><li>HTML / CSS / JS</li><li>DMX &amp; MIDI</li><li>LiDAR &amp; motion tracking</li>
    </ul>
    <h3 class="pixel small">Save points</h3>
    <ul class="timeline">
      <li><b>Immersive Gamebox</b><span>Director of Experience Design · 2023–now</span></li>
      <li><b>Orbit29</b><span>Senior Product Designer · 2021–2023</span></li>
      <li><b>Movember</b><span>Learning Experience Designer · 2019–2021</span></li>
      <li><b>Gripable</b><span>Senior UX Designer · 2018–2021</span></li>
      <li><b>McGraw Hill</b><span>Learning Experience Designer &amp; Programmer · 2017–2019</span></li>
      <li><b>Macquarie University</b><span>Master of Education (Technology in Education) · 2016–2017</span></li>
    </ul>
  </div>
</section>

<section class="contact" id="contact">
  <p class="pixel eyebrow blink-slow">Player 2 wanted</p>
  <h2>Let's make something people play together.</h2>
  <div class="cta">
    <a class="btn" href="mailto:{EMAIL}">{EMAIL}</a>
    <a class="btn btn-ghost" href="tel:{PHONE.replace(' ', '')}">{PHONE}</a>
    <a class="btn btn-ghost" href="{LINKEDIN}">LinkedIn ↗</a>
    <a class="btn btn-ghost" href="{CV}" download>CV ↓</a>
  </div>
</section>
"""
    return page("Joshua Kernich · Experience Designer",
                "Experience designer, technologist and storyteller. Games and installations played with the whole body.",
                body, "")


def project_page(p, i):
    root = "../../"
    specs = [("Client", p["client"]), ("Role", p["role"])]
    if p.get("year"):
        specs.append(("Year", p["year"]))
    if p.get("players"):
        specs.append(("Players", p["players"]))
    if p.get("status"):
        specs.append(("Status", p["status"]))
    spec_html = "".join(f"<div><dt>{e(k)}</dt><dd>{e(v)}</dd></div>" for k, v in specs)
    tech = "".join(f"<li>{e(t)}</li>" for t in p["tech"])
    hero = (f'<img src="{root}assets/img/{p["hero"]}" alt="{e(p["title"])}">' if p["hero"]
            else f'<div class="placeholder big"><span>{e(p["title"])}</span></div>')
    about = "".join(f"<p>{e(x)}</p>" for x in p["about"])
    did = "".join(f"<li>{e(x)}</li>" for x in p["did"])
    award = f'<p class="award">🏆 {e(p["award"])}</p>' if p.get("award") else ""
    gallery = ""
    if p["gallery"]:
        items = "".join(
            f'<a class="shot" href="{root}assets/img/{g}"><img src="{root}assets/img/{g}" alt="{e(p["title"])} screenshot" loading="lazy"></a>'
            for g in p["gallery"])
        gallery = f'<section class="gallery"><h2 class="pixel small">Screenshots</h2><div class="shots">{items}</div></section>'
    links = "".join(f'<a class="btn{" btn-ghost" if n else ""}" href="{e(u)}">{e(t)} ↗</a>'
                    for n, (t, u) in enumerate(p["links"]))
    prev_p = PROJECTS[i - 1]
    next_p = PROJECTS[(i + 1) % len(PROJECTS)]
    body = f"""
<article class="project c-{p['colour']}">
  <a class="back" href="{root}#levels">◀ Level select</a>
  <div class="project-hero">{hero}</div>
  <div class="project-main">
    <p class="pixel level">LV {i + 1:02d}{' · ' + e(p['status']) if p.get('status') else ''}</p>
    <h1>{e(p['title'])}</h1>
    <dl class="specs">{spec_html}</dl>
    <ul class="tech">{tech}</ul>
    <p class="lede">{e(p['summary'])}</p>
    {award}
    <section><h2 class="pixel small">The game</h2>{about}</section>
    <section><h2 class="pixel small">What I did</h2><ul class="did">{did}</ul></section>
    <div class="cta">{links}</div>
  </div>
  {gallery}
  <nav class="pager" aria-label="More projects">
    <a href="{root}projects/{prev_p['slug']}/"><span class="pixel small">◀ Prev</span>{e(prev_p.get('short', prev_p['title']))}</a>
    <a href="{root}projects/{next_p['slug']}/" class="next"><span class="pixel small">Next ▶</span>{e(next_p.get('short', next_p['title']))}</a>
  </nav>
</article>
<dialog class="lightbox"><img alt=""><button class="close" aria-label="Close">✕</button></dialog>
"""
    return page(f"{p['title']} · Joshua Kernich", p["summary"], body, root, f"projects/{p['slug']}/")


def not_found():
    body = """
<section class="contact" style="min-height:60vh">
  <p class="pixel eyebrow">Game over</p>
  <h2>That page isn't in this level.</h2>
  <div class="cta"><a class="btn" href="/">▶ Continue</a></div>
</section>"""
    return page("Game over · Joshua Kernich", "Page not found", body, "/")


def main():
    (ROOT / "index.html").write_text(home())
    for i, p in enumerate(PROJECTS):
        out = ROOT / "projects" / p["slug"]
        out.mkdir(parents=True, exist_ok=True)
        (out / "index.html").write_text(project_page(p, i))
    (ROOT / "404.html").write_text(not_found())
    print(f"Built home, 404 and {len(PROJECTS)} project pages.")


if __name__ == "__main__":
    main()
