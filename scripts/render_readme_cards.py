"""Draw every README card as an animated SVG from data/contributions.json.
STATIC=1 python scripts/render_readme_cards.py  -> final frame, no animation."""
import base64, json, os, textwrap
from datetime import date, timedelta
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "cards"
OUT.mkdir(exist_ok=True)
STATIC = os.environ.get("STATIC") == "1"

BG, CARD, LINE = "#0d1117", "#11171f", "#263040"
INK, MUTED, ACCENT = "#e6edf3", "#8b98a9", "#5bcdec"
YELLOW, CORAL = "#f2c94c", "#ff7a70"
LEVELS = ["#1b2430", "#12475a", "#1f7f9d", "#3ab0d3", "#5bcdec"]


def font(name, file):
    b = base64.b64encode((ROOT / "fonts" / file).read_bytes()).decode()
    return (f"@font-face{{font-family:'{name}';font-weight:{'700' if '700' in file else '400'};"
            f"src:url(data:font/woff;base64,{b}) format('woff')}}")

FONTS = font("SG", "sg-400.woff") + font("SG", "sg-700.woff") + font("JB", "jb-400.woff")
SANS = "SG,'Segoe UI',Helvetica,Arial,sans-serif"
MONO = "JB,Consolas,Menlo,monospace"

KEYFRAMES = """
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes pop{from{opacity:0;transform:scale(0)}to{opacity:1;transform:scale(1)}}
@keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes swing{0%{opacity:0;transform:translateY(46px) rotate(-5deg)}60%{opacity:1;transform:translateY(-6px) rotate(1.2deg)}80%{transform:translateY(2px) rotate(-.4deg)}100%{opacity:1;transform:none}}
@keyframes pulse{0%{transform:scale(1);opacity:.9}100%{transform:scale(2.6);opacity:0}}
@keyframes nudge{0%,100%{transform:translateX(0)}50%{transform:translateX(5px)}}
@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
@keyframes ring{from{transform:scale(.4);opacity:.7}to{transform:scale(2.2);opacity:0}}
.fo{transform-box:fill-box}
.rise{animation:rise .7s cubic-bezier(.2,.8,.2,1) both}
.fade{animation:fade .6s ease both}
.pop{transform-origin:center;animation:pop .35s cubic-bezier(.3,1.6,.5,1) both}
.grow{transform-origin:bottom;animation:grow .7s cubic-bezier(.2,.8,.2,1) both}
.swing{animation:swing .9s cubic-bezier(.2,.8,.2,1) both}
.pulse{transform-origin:center;animation:pulse 2s ease-out infinite}
.nudge{animation:nudge 1.6s ease-in-out infinite}
.blink{animation:blink 1.1s steps(1) infinite}
.ring{transform-origin:center;animation:ring 2.4s ease-out infinite}
.final{display:none}
@media (prefers-reduced-motion:reduce){*{animation:none!important}.frame,.shine{display:none!important}.final{display:inline!important}}
"""


def svg(w, h, body, defs=""):
    css = FONTS + ("" if STATIC else KEYFRAMES)
    if STATIC:
        css += ".final{display:inline}.frame,.shine{display:none}"
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'font-family="{SANS}"><style>{css}</style><defs>{defs}</defs>'
            f'<rect x=".5" y=".5" width="{w-1}" height="{h-1}" rx="18" fill="{CARD}" stroke="{LINE}"/>{body}</svg>')


def a(cls, delay):
    """animation class + delay, nothing in STATIC mode"""
    return "" if STATIC else f' class="{cls} fo" style="animation-delay:{delay:.2f}s"'


def text(x, y, s, size=16, fill=INK, weight=400, family=None, extra=""):
    fam = f' font-family="{family}"' if family else ""
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" font-weight="{weight}"{fam} {extra}>{escape(str(s))}</text>'


def counter(x, y, value, begin, size, fill, weight=700, anchor="start", suffix=""):
    """Count up from 0 with SMIL set frames. A final text shows under reduced motion."""
    final = f'<text class="final" x="{x}" y="{y}" font-size="{size}" fill="{fill}" font-weight="{weight}" text-anchor="{anchor}">{value:,}{suffix}</text>'
    if STATIC:
        return final
    steps = 18
    out = []
    for i in range(1, steps + 1):
        v = round(value * (1 - (1 - i / steps) ** 3))
        last = i == steps
        t = begin + i * 0.045
        tail = 'fill="freeze"' if last else f'dur="0.045s"'
        out.append(f'<text class="frame" display="none" x="{x}" y="{y}" font-size="{size}" fill="{fill}" '
                   f'font-weight="{weight}" text-anchor="{anchor}">{v:,}{suffix}'
                   f'<set attributeName="display" to="inline" begin="{t:.3f}s" {tail}/></text>')
    return final + "".join(out)


# ---------------- data ----------------
data = json.loads((ROOT / "data" / "contributions.json").read_text())
days = data["days"]
total = sum(d["count"] for d in days)
active = sum(1 for d in days if d["count"] > 0)
busiest = max(days, key=lambda d: d["count"])
longest = cur = 0
for d in days:
    cur = cur + 1 if d["count"] else 0
    longest = max(longest, cur)
streak = 0
for d in reversed(days):
    if d["count"]:
        streak += 1
    elif d is days[-1]:
        continue  # today may not have started yet
    else:
        break
months = {}
for d in days:
    months.setdefault(d["date"][:7], 0)
    months[d["date"][:7]] += d["count"]
month_keys = sorted(months)[-12:]
MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# ---------------- hero ----------------
def hero():
    grad = (f'<linearGradient id="sh" gradientUnits="userSpaceOnUse" x1="-260" y1="0" x2="-60" y2="0">'
            f'<stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".95"/>'
            f'<stop offset="1" stop-color="#fff" stop-opacity="0"/>'
            + ("" if STATIC else '<animateTransform attributeName="gradientTransform" type="translate" '
               'values="0 0;0 0;760 0" keyTimes="0;.15;1" dur="5s" begin="1.6s" repeatCount="indefinite"/>')
            + '</linearGradient>')
    name_x = 48
    b = (f'<g{a("fade", .1)}>' + text(name_x, 52, "~/sarang-cmd", 14, MUTED, family=MONO)
         + f'<rect class="{"blink" if not STATIC else ""}" x="162" y="40" width="9" height="16" fill="{ACCENT}"/></g>')
    b += f'<g{a("rise", .25)}>' + text(name_x, 128, "Sarang", 72, INK, 700, extra='letter-spacing="-2"')
    b += text(name_x + 262, 128, "Batra", 72, ACCENT, 700, extra='letter-spacing="-2"')
    b += f'<text class="shine" x="{name_x + 262}" y="128" font-size="72" font-weight="700" letter-spacing="-2" fill="url(#sh)">Batra</text></g>'
    b += f'<g{a("rise", .6)}>' + text(name_x, 172, "Aspiring CS student and agentic engineer.", 22, INK, 400)
    b += text(name_x, 204, "I started coding when I was 7. I build study tools, browser extensions and AI projects.", 15, MUTED, 400) + "</g>"
    b += f'<g{a("fade", 1.0)}><circle cx="852" cy="52" r="5" fill="{ACCENT}"/>' + (
        "" if STATIC else f'<circle class="pulse" cx="852" cy="52" r="5" fill="{ACCENT}"/>') + "</g>"
    b += text(836, 57, "Open to collaborate", 13, MUTED, family=MONO, extra='text-anchor="end"')
    return svg(900, 236, b, grad)


# ---------------- contribution graph (blue) ----------------
def graph():
    first = date.fromisoformat(days[0]["date"])
    pad = (first.weekday() + 1) % 7  # Sunday = 0
    x0, y0, s, gap = 48, 64, 12, 3
    b = text(48, 38, "Contributions in the last year", 16, INK, 700)
    b += text(852, 38, f"{total:,} total", 14, MUTED, family=MONO, extra='text-anchor="end"')
    cells = []
    for i, d in enumerate(days):
        col, row = (i + pad) // 7, (i + pad) % 7
        delay = 1.2 + col * 0.012 + row * 0.01
        cells.append(f'<rect{a("pop", delay)} x="{x0 + col * (s + gap)}" y="{y0 + row * (s + gap)}" width="{s}" height="{s}" rx="3" fill="{LEVELS[d["level"]]}"/>')
    b += "".join(cells)
    lx = 852 - 5 * 16 - 70
    ly = y0 + 7 * (s + gap) + 14
    b += text(lx, ly + 10, "Less", 12, MUTED, family=MONO)
    for i, c in enumerate(LEVELS):
        b += f'<rect x="{lx + 38 + i * 16}" y="{ly}" width="12" height="12" rx="3" fill="{c}"/>'
    b += text(lx + 38 + 5 * 16 + 4, ly + 10, "More", 12, MUTED, family=MONO)
    return svg(900, 218, b)


# ---------------- activity: monthly bars and stats ----------------
def activity():
    b = text(48, 38, "Contributions per month", 16, INK, 700)
    top = max(months[k] for k in month_keys)
    best = max(month_keys, key=lambda k: months[k])
    base, maxh = 196, 110
    bw, gap, x0 = 34, 14, 48
    for i, k in enumerate(month_keys):
        v = months[k]
        h = max(4, round(v / top * maxh))
        x = x0 + i * (bw + gap)
        fill = ACCENT if k == best else "#2a3a4d"
        b += f'<rect{a("grow", 2.0 + i * 0.06)} x="{x}" y="{base - h}" width="{bw}" height="{h}" rx="6" fill="{fill}"/>'
        b += text(x + bw / 2, base + 20, MN[int(k[5:]) - 1], 12, MUTED, family=MONO, extra='text-anchor="middle"')
        if k == best:
            b += f'<g{a("pop", 2.0 + 12 * 0.06 + .2)}>' + text(x + bw / 2, base - h - 10, v, 14, ACCENT, 700, extra='text-anchor="middle"') + "</g>"
    # stats column
    sx = 690
    stats = [("Total", total, ""), ("Current streak", streak, " days"), ("Longest streak", longest, " days"),
             ("Active days", active, "")]
    for i, (label, val, suf) in enumerate(stats):
        y = 78 + i * 46
        b += text(sx, y, label, 12, MUTED, family=MONO)
        b += counter(sx, y + 26, val, 2.0 + i * 0.12, 26, INK if i else ACCENT, 700, suffix=suf)
    bd = date.fromisoformat(busiest["date"])
    b += text(sx, 78 + 4 * 46, "Busiest day", 12, MUTED, family=MONO)
    b += text(sx, 78 + 4 * 46 + 22, f'{busiest["count"]} on {MN[bd.month - 1]} {bd.day}', 18, INK, 700)
    return svg(900, 318, b)


# ---------------- tiles ----------------
def tile(fname, color, big, label, items, delay, suffix=""):
    w, h = 290, 214
    b = f'<g{a("swing", delay)}>'
    b += f'<rect x="0" y="0" width="{w}" height="6" fill="{color}"/>'.replace('x="0"', 'x="18"').replace(f'width="{w}"', f'width="{w - 36}"')
    b += text(24, 38, label.upper(), 12, color, 700, extra='letter-spacing="2"')
    if not STATIC:
        b += f'<circle class="ring" cx="256" cy="30" r="9" fill="none" stroke="{color}" stroke-width="2"/>'
    b += f'<circle cx="256" cy="30" r="5" fill="{color}"/>'
    b += counter(24, 100, big, delay + .5, 56, INK, 700, suffix=suffix)
    for i, it in enumerate(items):
        b += text(24, 134 + i * 22, it, 15, MUTED, 400)
    b += f'<g{" class=\"nudge\"" if not STATIC else ""}><path d="M246 190h22m-8-8 8 8-8 8" fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></g>'
    b += "</g>"
    (OUT / fname).write_text(svg(w, h, b))


# ---------------- repo cards ----------------
def repo(fname, color, title, desc, tag, delay):
    w, h = 440, 188
    lines = textwrap.wrap(desc, 52)[:3]
    b = f'<g{a("rise", delay)}>'
    b += f'<rect x="24" y="24" width="8" height="26" rx="4" fill="{color}"/>'
    b += text(44, 44, title, 20, INK, 700)
    for i, ln in enumerate(lines):
        b += text(24, 82 + i * 22, ln, 14.5, MUTED, 400)
    b += text(24, 164, tag, 12.5, color, 400, family=MONO)
    b += f'<g{" class=\"nudge\"" if not STATIC else ""}><path d="M392 160h22m-8-8 8 8-8 8" fill="none" stroke="{color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></g></g>'
    (OUT / fname).write_text(svg(w, h, b))


# ---------------- currently working on ----------------
def working():
    rows = [("Sarang.md", "IB Maths AA HL/SL study space", False),
            ("LM Subs", "Synced captions for NotebookLM Video Overviews", False),
            ("Study With Sarang", "Calm focus studio for students", False),
            ("Perplexity Autorename", "Renames Perplexity threads to short titles", False),
            ("Flow", "White noise and device blocking. GitHub release coming soon", True)]
    b = text(48, 40, "Currently working on", 16, INK, 700)
    for i, (n, d, dev) in enumerate(rows):
        y = 82 + i * 38
        g = f'<g{a("rise", 4.6 + i * 0.12)}>'
        g += f'<circle cx="54" cy="{y - 5}" r="5" fill="{YELLOW if dev else ACCENT}"/>'
        if not STATIC:
            g += f'<circle class="pulse" cx="54" cy="{y - 5}" r="5" fill="{YELLOW if dev else ACCENT}"/>'
        g += text(76, y, n, 17, INK, 700)
        g += text(76 + 9.6 * len(n) + 16, y, d, 14.5, MUTED, 400)
        if dev:
            g += text(852, y, "In development", 12, YELLOW, family=MONO, extra='text-anchor="end"')
        b += g + "</g>"
    y = 82 + 5 * 38 + 14
    b += f'<g{a("fade", 5.4)}><line x1="48" y1="{y - 24}" x2="852" y2="{y - 24}" stroke="{LINE}"/>'
    b += text(48, y + 4, "Learning: deep learning fundamentals, from linear algebra to backprop to transformers.", 14.5, MUTED) + "</g>"
    return svg(900, y + 36, b)


# ---------------- tech stack ----------------
STACK = [
    ("Languages", ACCENT, ["C", "C++", "C#", "Python", "JavaScript", "TypeScript", "Bash", "PHP", "HTML", "CSS", "Scratch"]),
    ("Frameworks, cloud and tools", YELLOW, ["React", "React Native", "Next.js", "Vue", "Vite", "Tailwind", "Node.js", ".NET", "Electron",
                                              "PyTorch", "TensorFlow", "Firebase", "Google Cloud", "Git", "Zapier"]),
    ("AI tools", CORAL, ["Claude", "Claude Code", "ChatGPT", "Gemini", "Google AI Studio", "Antigravity", "DeepSeek", "GLM / Z.ai",
                         "Grok", "Qwen", "Manus", "Perplexity", "Ollama"]),
    ("Design, 3D and hardware", "#9be28f", ["Figma", "Illustrator", "Photoshop", "Premiere Pro", "Media Encoder", "Blender", "SketchUp", "Unity", "Arduino"]),
]


def stack():
    b = text(48, 40, "Languages and tools", 16, INK, 700)
    y, n = 76, 0
    for title, color, chips in STACK:
        b += text(48, y, title.upper(), 11.5, color, 700, extra='letter-spacing="1.8"')
        y += 14
        x = 48
        for c in chips:
            w = round(8.1 * len(c) + 26)
            if x + w > 852:
                x, y = 48, y + 36
            b += (f'<g{a("pop", 5.0 + n * 0.025)}><rect x="{x}" y="{y}" width="{w}" height="28" rx="14" fill="none" stroke="{color}" stroke-opacity=".55"/>'
                  + text(x + w / 2, y + 19, c, 13.5, INK, 400, extra='text-anchor="middle"') + "</g>")
            x += w + 8
            n += 1
        y += 36 + 24
    return svg(900, y - 4, b)


(OUT / "hero.svg").write_text(hero())
(OUT / "graph.svg").write_text(graph())
(OUT / "activity.svg").write_text(activity())
(OUT / "working.svg").write_text(working())
(OUT / "stack.svg").write_text(stack())
tile("build.svg", ACCENT, 5, "Build", ["Sarang.md", "LM Subs", "Study With Sarang"], 3.0, "")
tile("learn.svg", YELLOW, 336, "Learn", ["Road to Stanford CS336", "Math, PyTorch, transformers"], 3.15)
tile("connect.svg", CORAL, 4, "Connect", ["GitHub and LinkedIn", "Instagram and Gmail"], 3.3)
repo("sarang-md.svg", ACCENT, "Sarang.md", "IB Mathematics AA HL/SL study space with 83 syllabus lessons, 1,069 practice questions, mark schemes and a signed Windows app.", "Vite  React  TypeScript  Tailwind", 3.8)
repo("lm-subs.svg", YELLOW, "LM Subs", "Chrome extension with synced captions for NotebookLM Video Overviews. 12 BYOK speech providers and SRT, WebVTT, TXT and JSON export.", "Manifest V3  Neon sync", 3.95)
repo("cs336.svg", CORAL, "Road to Stanford CS336", "Free self-study roadmap from high school math to Stanford's graduate LLM course. Covers math, PyTorch, Karpathy and beyond.", "Math  PyTorch  LLMs", 4.1)
repo("study.svg", "#9be28f", "Study With Sarang", "Calm focus studio for students with ambient sound, a goal-first timer, mindful breaks and a Windows app with voice commands.", "Windows  Web", 4.25)
print("cards:", sorted(p.name for p in OUT.iterdir()))
