"""Erzeugt die Logo-Assets von Ecclium als SVG.

Warum ein Skript statt Handarbeit: Alle Varianten entstehen aus derselben
Konstruktion (Raster 64, Aussenradius 25,5, Wand 9, Innenwand 7, Oeffnung
12,5 bis 60 Grad). So bleiben hell, dunkel, einfarbig und Icons exakt gleich,
und eine spaetere Korrektur passiert an genau einer Stelle.
"""
import json, os, pathlib

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent; (OUT/"logo").mkdir(parents=True, exist_ok=True); (OUT/"icon").mkdir(exist_ok=True)

# Farben der Marke (siehe tokens.json). Messing hell ist die Variante fuer dunklen Grund.
GRAPHIT, KALK, MESSING, MESSING_HELL = "#1E2124", "#F3F3EF", "#A57C2C", "#C9A55A"

# Zeichen im 64er-Raster. Die Innenwand wird zuerst gezeichnet, die Aussenwand
# darueber, damit die Stoesse sauber unter der Wand verschwinden.
def mark(wall, bar):
    return (f'<rect x="14" y="28.5" width="35" height="7" fill="{bar}"/>'
            f'<path d="M52.5 36.55A21 21 0 1 0 42.5 50.19" fill="none" stroke="{wall}" stroke-width="9"/>')

word = open(HERE/"wordmark-path.txt").read()
meta = json.load(open(HERE/"wordmark-meta.json"))
wx0, wtop, wx1, wbot = meta["bounds"]

# Kombination in Schrifteinheiten (1000 pro Geviert):
# Zeichendurchmesser 900, Mitte auf Hoehe des e-Querstrichs der Wortmarke (y = -276),
# dadurch schliesst das Zeichen oben buendig mit der Oberlaenge des l ab.
D, CY, GAP = 900, -276, 270
S = D / 51            # Aussendurchmesser 51 im 64er-Raster
CX = D / 2
WORD_DX = D + GAP - wx0
TOP, BOTTOM = CY - D/2, CY + D/2
W = WORD_DX + wx1

def lockup(wall, bar, ink):
    g = f'<g transform="translate({CX} {CY}) scale({S:.4f}) translate(-32 -32)">{mark(wall, bar)}</g>'
    t = f'<path transform="translate({WORD_DX:.1f} 0)" d="{word}" fill="{ink}"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {TOP:.0f} {W:.0f} {D}" '
            f'width="{W/10:.0f}" height="{D/10:.0f}" role="img" aria-label="Ecclium">{g}{t}</svg>\n')

# Gestapelte Variante: Zeichen zentriert ueber der Wortmarke, Abstand = Wandstaerke x 2
def stacked(wall, bar, ink):
    ww = wx1 - wx0
    D2 = 1400; S2 = D2 / 51
    total_w = max(ww, D2)
    gap = 2 * 9 * S2
    mark_cx = total_w/2; mark_cy = D2/2
    word_top = D2 + gap
    word_dy = word_top - wtop            # wtop ist negativ (Oberlaenge)
    word_dx = (total_w - ww)/2 - wx0
    h = word_dy + wbot
    g = f'<g transform="translate({mark_cx:.1f} {mark_cy}) scale({S2:.4f}) translate(-32 -32)">{mark(wall, bar)}</g>'
    t = f'<path transform="translate({word_dx:.1f} {word_dy:.1f})" d="{word}" fill="{ink}"/>'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total_w:.0f} {h:.0f}" '
            f'width="{total_w/10:.0f}" height="{h/10:.0f}" role="img" aria-label="Ecclium">{g}{t}</svg>\n')

def mark_svg(wall, bar):
    # enge viewBox um den Aussenkreis (32 +/- 25,5)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="6.5 6.5 51 51" width="51" height="51" '
            f'role="img" aria-label="Ecclium">{mark(wall, bar)}</svg>\n')

def wordmark_svg(ink):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{wx0:.0f} {wtop:.0f} {wx1-wx0:.0f} {wbot-wtop:.0f}" '
            f'width="{(wx1-wx0)/10:.0f}" height="{(wbot-wtop)/10:.0f}" role="img" aria-label="Ecclium">'
            f'<path d="{word}" fill="{ink}"/></svg>\n')

# App-Icon: Graphit-Kachel, Zeichen auf 62 Prozent der Kachel. Eckradius 22 Prozent.
def app_icon(size=512):
    s = size * 0.62 / 51
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-label="Ecclium">'
            f'<rect width="{size}" height="{size}" rx="{size*0.22:.0f}" fill="{GRAPHIT}"/>'
            f'<g transform="translate({size/2} {size/2}) scale({s:.4f}) translate(-32 -32)">{mark(KALK, MESSING_HELL)}</g></svg>\n')

# Quadratischer Avatar ohne Eckradius (GitHub rundet selbst ab)
def avatar(size=500):
    s = size * 0.58 / 51
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">'
            f'<rect width="{size}" height="{size}" fill="{GRAPHIT}"/>'
            f'<g transform="translate({size/2} {size/2}) scale({s:.4f}) translate(-32 -32)">{mark(KALK, MESSING_HELL)}</g></svg>\n')

# Favicon als SVG: ohne Kachel, passt sich per prefers-color-scheme dem hellen oder dunklen Browser an
FAVICON = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="6.5 6.5 51 51">'
           '<style>.w{stroke:#1E2124}.b{fill:#A57C2C}@media (prefers-color-scheme:dark){.w{stroke:#F3F3EF}.b{fill:#C9A55A}}</style>'
           '<rect class="b" x="14" y="28.5" width="35" height="7"/>'
           '<path class="w" d="M52.5 36.55A21 21 0 1 0 42.5 50.19" fill="none" stroke-width="9"/></svg>\n')

files = {
  "logo/ecclium-logo.svg": lockup(GRAPHIT, MESSING, GRAPHIT),
  "logo/ecclium-logo-negativ.svg": lockup(KALK, MESSING_HELL, KALK),
  "logo/ecclium-logo-einfarbig-graphit.svg": lockup(GRAPHIT, GRAPHIT, GRAPHIT),
  "logo/ecclium-logo-einfarbig-weiss.svg": lockup("#FFFFFF", "#FFFFFF", "#FFFFFF"),
  "logo/ecclium-logo-currentcolor.svg": lockup("currentColor", "currentColor", "currentColor"),
  "logo/ecclium-logo-gestapelt.svg": stacked(GRAPHIT, MESSING, GRAPHIT),
  "logo/ecclium-logo-gestapelt-negativ.svg": stacked(KALK, MESSING_HELL, KALK),
  "logo/ecclium-zeichen.svg": mark_svg(GRAPHIT, MESSING),
  "logo/ecclium-zeichen-negativ.svg": mark_svg(KALK, MESSING_HELL),
  "logo/ecclium-zeichen-einfarbig-graphit.svg": mark_svg(GRAPHIT, GRAPHIT),
  "logo/ecclium-zeichen-einfarbig-weiss.svg": mark_svg("#FFFFFF", "#FFFFFF"),
  "logo/ecclium-zeichen-currentcolor.svg": mark_svg("currentColor", "currentColor"),
  "logo/ecclium-wortmarke.svg": wordmark_svg(GRAPHIT),
  "logo/ecclium-wortmarke-negativ.svg": wordmark_svg(KALK),
  "icon/ecclium-app-icon.svg": app_icon(512),
  "icon/ecclium-github-avatar.svg": avatar(500),
  "icon/favicon.svg": FAVICON,
}
for p, c in files.items():
    (OUT/p).write_text(c, encoding="utf-8")
print(json.dumps({"W": round(W), "D": D, "TOP": TOP, "files": len(files)}))
