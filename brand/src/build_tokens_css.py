"""Erzeugt tokens/tokens.css aus tokens/tokens.json.

Warum tokens.json die Quelle ist: Dieselbe Datei liegt im Designsystem «Ecclium»
und beschreibt jeden Wert mit seinem Einsatz. Die CSS-Datei ist nur die
Übersetzung für Website, Doku und Oberflächen. Wer eine Farbe ändert, ändert
sie in tokens.json und lässt dieses Skript laufen, damit beide nie auseinanderlaufen.

Aufruf aus dem Ordner brand/:  python3 src/build_tokens_css.py
Keine Abhängigkeiten ausser Python 3.
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
tokens = json.loads((ROOT / "tokens" / "tokens.json").read_text(encoding="utf-8"))

# Das erste Thema ist das Grundthema (:root), alle weiteren werden als
# Überschreibung ausgegeben. So verlangt es auch das Designsystem.
themes = [t["id"] for t in tokens["color"]["themes"]]
base, others = themes[0], themes[1:]

# Familien, deren Werte je Thema verschieden sein können.
THEMED = ["color", "shadow"]
# Familien mit einem Wert für alle Themen, in dieser Reihenfolge ausgegeben.
# motion (seit 1.2) enthält Dauer und Kurve der Bewegung aus Kapitel 8.
PLAIN = ["spacing", "radius", "stroke", "layout", "motion"]

# Eine Familie, die in tokens.json steht, hier aber fehlt, käme sonst
# stillschweigend nicht in tokens.css. Das Designsystem zeigt sie trotzdem an,
# und Website und Designsystem liefen auseinander. Deshalb bricht das Skript
# ab, statt sie zu übergehen.
KNOWN = {"name", "version", "type", *THEMED, *PLAIN}
unknown = sorted(set(tokens) - KNOWN)
if unknown:
    raise SystemExit(f"Unbekannte Familie in tokens.json: {', '.join(unknown)}. "
                     "In THEMED oder PLAIN eintragen, damit sie in tokens.css erscheint.")


def css_value(value):
    """Übersetzt einen Tokenwert nach CSS. Ein Alias «{accent}» wird zu var(--accent),
    damit er im dunklen Thema automatisch den dunklen Wert von accent übernimmt."""
    alias = re.fullmatch(r"\{([A-Za-z0-9_.-]+)\}", value)
    return f"var(--{alias.group(1)})" if alias else value


def themed_value(token, theme):
    value = token["value"]
    if isinstance(value, dict):
        # Fehlt ein Thema, gilt der Wert des Grundthemas (wie im Designsystem).
        return value.get(theme, value[base])
    return value


def block(theme, indent):
    lines = []
    for family in THEMED:
        for t in tokens.get(family, {}).get("tokens", []):
            lines.append(f"{indent}--{t['name']}: {css_value(themed_value(t, theme))};")
    return lines


out = [f"/* {tokens['name']} Design-Tokens v{tokens['version']}.0, erzeugt aus tokens.json "
       "mit src/build_tokens_css.py. Nicht von Hand ändern. */"]

# Schriften: Pfade relativ zu tokens/, weil tokens.css dort liegt.
# Archivo ist eine variable Schrift mit Breitenachse. font-stretch gibt den
# Bereich an, damit Browser die Breiten 108 und 112 nicht künstlich verzerren.
for f in tokens["type"]["fonts"]:
    stretch = " font-stretch: 62% 125%;" if f["family"] == "Archivo" else ""
    out.append(f'@font-face {{ font-family: "{f["family"]}"; src: url("../{f["file"]}") format("woff2"); '
               f'font-weight: {f["weight"]};{stretch} font-display: swap; }}')

out += ["", ":root {", f"  color-scheme: {base};"]
out += block(base, "  ")
for family in PLAIN:
    for t in tokens[family]["tokens"]:
        out.append(f"  --{t['name']}: {t['value']};")
for key, stack in tokens["type"]["families"].items():
    out.append(f"  --font-{key}: {stack};")
out.append("}")

# Jedes weitere Thema zweimal: einmal nach Systemeinstellung, ausser die Seite
# erzwingt hell, und einmal, wenn die Seite es mit data-theme ausdrücklich wählt.
# Annahme: Es gibt genau ein weiteres Thema, das dunkle. Ein drittes Thema
# bräuchte eine eigene Regel, weil die Systemeinstellung nur hell und dunkel kennt.
for theme in others:
    out += ["@media (prefers-color-scheme: dark) {", f'  :root:not([data-theme="{base}"]) {{',
            f"    color-scheme: {theme};"]
    out += block(theme, "    ")
    out += ["  }", "}", f':root[data-theme="{theme}"] {{', f"  color-scheme: {theme};"]
    out += block(theme, "  ")
    out.append("}")

(ROOT / "tokens" / "tokens.css").write_text("\n".join(out) + "\n", encoding="utf-8")
print("ok: tokens/tokens.css")
