// Frames the real app screenshots in docs/screenshots/ for the README.
//
//   node scripts/generate-readme-frames.mjs
//
// Each screenshot is composed, unmodified, onto the Faro backdrop: night background,
// gold dust, a dotted wave, the lighthouse mark top-left, and a title above a framed
// window. Nothing is redrawn or regenerated, so the UI shown is exactly what
// `npm run shots` captured. Output: docs/images/readme/frames/<name>.webp.
//
// Uses an installed Chrome/Edge through puppeteer-core (already a dev dependency),
// like scripts/capture-screenshots.mjs. Set CHROME_PATH to override the lookup.
// The title font is Bricolage Grotesque when installed, then common system sans fonts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { markPath, markRect } from './faro-mark.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'docs', 'screenshots');
const out = path.join(root, 'docs', 'images', 'readme', 'frames');
mkdirSync(out, { recursive: true });

const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(p => p && existsSync(p));
if (!chrome) {
  console.error('No Chrome/Edge found. Install one or set CHROME_PATH.');
  process.exit(1);
}

// name = file in docs/screenshots (without .png); title = the large heading on the frame.
// crop = optional [x, y, width, height] region of the screenshot, in screenshot pixels.
const frames = [
  { name: 'overview', title: 'Side by side' },
  { name: 'terminal', title: 'Terminal where you work' },
  { name: 'disk-usage', title: 'Disk usage' },
  { name: 'transfers', title: 'Transfer queue' },
  { name: 'sync', title: 'Directory sync' },
  { name: 'object-storage', title: 'Object storage' },
  // The rail capture is a tall, narrow strip. Show its top part at full resolution.
  { name: 'server-rail', title: 'Connection rail', crop: [0, 0, 600, 780] },
  { name: 'agent-bridge', title: 'Agent Bridge' },
  { name: 'agent-bridge-approve', title: 'Command approval' },
  { name: 'new-connection', title: 'New connection' },
  { name: 'settings', title: 'Settings' },
  { name: 'context-menu', title: 'File actions' },
];

const W = 1600, H = 1100;      // canvas
const WIN_W = 1344, WIN_H = 840, WIN_TOP = 170; // framed window for 16:10 captures

const markSvg = `<svg viewBox="383 262 254 567" width="100%" height="100%"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#17120a"/><stop offset=".45" stop-color="#b9831f"/><stop offset=".8" stop-color="#f5c463"/><stop offset="1" stop-color="#fff1c9"/></linearGradient></defs><rect x="${markRect[0]}" y="${markRect[1]}" width="${markRect[2]}" height="${markRect[3]}" fill="url(#g)"/><path fill="#e8eaee" fill-rule="evenodd" d="${markPath}"/></svg>`;

function page({ title, dataUri, crop }) {
  const cw = crop ? crop[2] : WIN_W;
  const ch = crop ? crop[3] : WIN_H;
  const left = Math.round((W - cw) / 2);
  const top = WIN_TOP + Math.round((WIN_H - ch) / 2);
  const img = crop
    ? `<img src="${dataUri}" style="position:absolute;left:${-crop[0]}px;top:${-crop[1]}px" />`
    : `<img src="${dataUri}" style="width:100%;display:block" />`;
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:${W}px;height:${H}px;background:#0d0e11;position:relative;overflow:hidden;font-family:'Bricolage Grotesque','Segoe UI','Helvetica Neue',Arial,sans-serif}
canvas{position:absolute;inset:0}
h1{position:absolute;left:0;right:0;top:46px;text-align:center;font-size:78px;line-height:96px;font-weight:700;letter-spacing:-.02em;color:#f4f5f7;text-shadow:0 2px 24px rgba(0,0,0,.6)}
.tile{position:absolute;left:44px;top:42px;width:88px;height:88px;border-radius:20px;background:#111317;border:1px solid #262a33;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden}
.tile .m{position:absolute;left:24px;top:14px;width:25px;height:60px}
.tile .beam{position:absolute;left:46px;top:20px;width:42px;height:22px;background:linear-gradient(90deg,rgba(240,166,60,.75),rgba(240,166,60,0));clip-path:polygon(0 38%,100% 0,100% 100%,0 62%)}
.win{position:absolute;left:${left}px;top:${top}px;width:${cw}px;height:${ch}px;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.16);background:#0d0e11;
box-shadow:0 36px 90px rgba(0,0,0,.7),0 0 0 1px rgba(0,0,0,.55),0 0 80px rgba(240,166,60,.10)}
</style>
<canvas id="bg" width="${W}" height="${H}"></canvas>
<div class="tile"><div class="beam"></div><div class="m">${markSvg}</div></div>
<h1>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</h1>
<div class="win">${img}</div>
<script>{
// Deterministic backdrop: seeded dust and a dotted wave in the lamp amber.
let s = 20260101; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
const c = document.getElementById('bg').getContext('2d'), W = ${W}, H = ${H};
let g = c.createRadialGradient(W * .12, 0, 0, W * .12, 0, 700); g.addColorStop(0, 'rgba(240,166,60,.16)'); g.addColorStop(1, 'rgba(240,166,60,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
g = c.createRadialGradient(W * .5, H, 0, W * .5, H, 900); g.addColorStop(0, 'rgba(240,166,60,.12)'); g.addColorStop(1, 'rgba(240,166,60,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
// dotted wave
for (let r = 0; r < 46; r++) {
  const t = r / 45, base = H - 380 + Math.pow(t, 1.5) * 380;
  for (let x = -20; x < W + 20; x += 14 + (1 - t) * 10) {
    const y = base + Math.sin(x * .006 + r * .45) * (16 + 44 * t) + Math.cos(x * .013 - r * .3) * 8 * t;
    const a = (.08 + .5 * t) * (.55 + .45 * Math.sin(x * .004 + 1));
    c.fillStyle = 'rgba(240,166,60,' + a.toFixed(3) + ')';
    c.beginPath(); c.arc(x, y, .6 + 1.5 * t, 0, 7); c.fill();
  }
}
// dust
for (let i = 0; i < 160; i++) {
  const x = rnd() * W, y = rnd() * H, a = .1 + rnd() * .5, r = .5 + rnd() * 1.6;
  c.fillStyle = 'rgba(246,186,106,' + a.toFixed(2) + ')'; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
}
for (let i = 0; i < 6; i++) {
  const x = rnd() * W, y = rnd() * H, gr = c.createRadialGradient(x, y, 0, x, y, 26);
  gr.addColorStop(0, 'rgba(240,166,60,.35)'); gr.addColorStop(1, 'rgba(240,166,60,0)'); c.fillStyle = gr; c.fillRect(x - 26, y - 26, 52, 52);
}
}</script>`;
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args: ['--force-color-profile=srgb', '--hide-scrollbars'],
});
try {
  const tab = await browser.newPage();
  for (const f of frames) {
    const file = path.join(shots, `${f.name}.png`);
    if (!existsSync(file)) { console.warn(`skip ${f.name}: ${file} not found`); continue; }
    const dataUri = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
    await tab.setContent(page({ title: f.title, dataUri, crop: f.crop }), { waitUntil: 'load' });
    await tab.evaluate(() => document.fonts.ready);
    const buf = await tab.screenshot({ type: 'webp', quality: 94 });
    writeFileSync(path.join(out, `${f.name}.webp`), buf);
    console.log(`${f.name}.webp  ${(buf.length / 1024).toFixed(0)} KB`);
  }
} finally {
  await browser.close();
}
