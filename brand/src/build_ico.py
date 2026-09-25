"""Setzt icon/favicon.ico aus den gerenderten PNG 16, 32 und 48 px zusammen.

Warum ein eigener Schritt: Pillow würde beim Speichern einer ICO-Datei die
kleinen Grössen aus einem grossen Bild herunterrechnen. Dabei verschwimmt die
Wand des Zeichens bei 16 px. Deshalb nehmen wir jede Grösse so, wie Chromium
sie direkt gerastert hat (src/render_png.js), und hängen sie nur an.

Aufruf aus dem Ordner brand/:  python3 src/build_ico.py
Reihenfolge: generate_logos.py, dann render_png.js, dann dieses Skript.
Voraussetzung: Pillow (pip install pillow).
"""
import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SIZES = [16, 32, 48]

images = [Image.open(ROOT / "png" / f"favicon-{s}.png").convert("RGBA") for s in SIZES]
# Das grösste Bild ist die Basis, die übrigen werden unverändert beigelegt.
base, rest = images[-1], images[:-1]
base.save(ROOT / "icon" / "favicon.ico", format="ICO",
          sizes=[(s, s) for s in SIZES], append_images=rest)
print("ok: icon/favicon.ico mit", ", ".join(f"{s} px" for s in SIZES))
