// Rastert die SVG-Assets und die Social-Bilder von Ecclium zu PNG.
//
// Warum Chromium statt eines SVG-Konverters: Die Social-Bilder brauchen die
// variable Schrift Archivo mit Breitenachse (wdth 108). Nur ein echter Browser
// setzt sie genau so wie später Website und Doku. Für die Icons nehmen wir
// denselben Weg, damit alle PNG aus einer Quelle und einem Renderer stammen.
//
// Aufruf aus dem Ordner brand/:  node src/render_png.js
// Voraussetzung: Node.js und das Paket «playwright» mit Chromium.
// Zuerst `python3 src/generate_logos.py` laufen lassen, falls sich das Logo geändert hat.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Alle Pfade relativ zu brand/, damit das Skript im Repository von überall läuft.
const ROOT = path.resolve(__dirname, '..');
const p = (...parts) => path.join(ROOT, ...parts);

// Seitenverhältnis der Kombination: viewBox 4896 × 900 (siehe generate_logos.py).
const LOGO_H = Math.round(1200 * 900 / 4896);

// [Quelle SVG, Ziel PNG, Breite, Höhe]
// Favicons klein werden direkt aus der Kachel gerendert und nicht herunterskaliert,
// weil Chromium jede Grösse neu rastert und die Wand so bei 16 px scharf bleibt.
const svgJobs = [
  ['icon/ecclium-app-icon.svg', 'png/ecclium-app-icon-512.png', 512, 512],
  ['icon/ecclium-app-icon.svg', 'png/ecclium-app-icon-192.png', 192, 192],
  ['icon/ecclium-app-icon.svg', 'png/apple-touch-icon-180.png', 180, 180],
  ['icon/ecclium-app-icon.svg', 'png/favicon-48.png', 48, 48],
  ['icon/ecclium-app-icon.svg', 'png/favicon-32.png', 32, 32],
  ['icon/ecclium-app-icon.svg', 'png/favicon-16.png', 16, 16],
  ['icon/ecclium-github-avatar.svg', 'png/ecclium-github-avatar-500.png', 500, 500],
  ['logo/ecclium-logo.svg', 'png/ecclium-logo-1200.png', 1200, LOGO_H],
  ['logo/ecclium-logo-negativ.svg', 'png/ecclium-logo-negativ-1200.png', 1200, LOGO_H],
  ['logo/ecclium-zeichen.svg', 'png/ecclium-zeichen-512.png', 512, 512],
];

// [Quelle HTML, Ziel PNG, Breite, Höhe]
// 1280 × 640 ist das Format von GitHub für die Social Preview eines Repositorys,
// 1200 × 630 das übliche Open-Graph-Format für Links auf Website und Doku.
const htmlJobs = [
  ['src/social/social-1280.html', 'social/ecclium-social-preview-1280x640.png', 1280, 640],
  ['src/social/og-1200.html', 'social/ecclium-og-1200x630.png', 1200, 630],
];

(async () => {
  fs.mkdirSync(p('png'), { recursive: true });
  fs.mkdirSync(p('social'), { recursive: true });
  const browser = await chromium.launch();

  for (const [src, dst, w, h] of svgJobs) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    // Das SVG als Bild einbetten statt direkt öffnen: So skaliert Chromium auf
    // genau w × h, und der Hintergrund bleibt transparent.
    const svg = fs.readFileSync(p(src));
    await page.setContent(
      `<html><body style="margin:0;background:transparent">` +
      `<img style="display:block;width:${w}px;height:${h}px" ` +
      `src="data:image/svg+xml;base64,${svg.toString('base64')}"></body></html>`
    );
    await page.screenshot({ path: p(dst), omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
    await page.close();
  }

  for (const [src, dst, w, h] of htmlJobs) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.goto('file://' + p(src));
    // Warten, bis die selbst gehosteten Schriften geladen sind. Ohne diesen
    // Schritt kann der erste Screenshot noch die Ersatzschrift zeigen.
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: p(dst), clip: { x: 0, y: 0, width: w, height: h } });
    await page.close();
  }

  await browser.close();
  console.log(`ok: ${svgJobs.length + htmlJobs.length} Dateien`);
})();
