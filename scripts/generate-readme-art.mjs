// Dependency-free README artwork. Run: node scripts/generate-readme-art.mjs
// Keep colors here so banners and cards share one palette.
import { markPath, markRect } from './faro-mark.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { artworkTranslations } from './readme-art-translations.mjs';

const out = new URL('../docs/images/readme/', import.meta.url);
mkdirSync(out, { recursive: true });
// Palette matches faroapp.dev: night background, lamp-amber accent, foam text.
const c = { bg: '#0d0e11', panel: '#111317', line: '#262a33', gold: '#f0a63c', hot: '#f6ba6a', ink: '#e8eaee', muted: '#a3aab7', dim: '#4f4023' };
// Deterministic gold dust so regenerating never changes the artwork.
function dust(w, h, count, seed) {
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: count }, () => {
    const x = (w * (0.58 + rand() * 0.4)).toFixed(1), y = (h * (0.06 + rand() * 0.5)).toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="${(0.6 + rand() * 1.2).toFixed(1)}" fill="${c.gold}" opacity="${(0.15 + rand() * 0.4).toFixed(2)}"/>`;
  }).join('');
}
// Small lit lighthouse mark at (x, y), height hgt.
const mk_rect = markRect;
const mark = (x, y, hgt) => {
  const sc = hgt / 567, w = 254 * sc;
  return `<g transform="translate(${x} ${y}) scale(${sc.toFixed(4)}) translate(-383 -262)">
<rect x="${mk_rect[0]}" y="${mk_rect[1]}" width="${mk_rect[2]}" height="${mk_rect[3]}" fill="url(#glass)"/>
<path fill="${c.ink}" fill-rule="evenodd" d="${markPath}"/></g>`;
};
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const text = (x, y, value, size = 24, fill = c.ink, weight = 400, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${escape(value)}</text>`;
const line = (x1, y1, x2, y2, color = c.line) => `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${color}"/>`;
function save(name, w, h, title, body, { dots = true, logo = null } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title">
<title id="title">${escape(title)}</title>
<defs>
<linearGradient id="glass" x1="0" x2="1"><stop offset="0" stop-color="#17120a"/><stop offset=".45" stop-color="#b9831f"/><stop offset=".8" stop-color="#f5c463"/><stop offset="1" stop-color="#fff1c9"/></linearGradient>
<radialGradient id="glow" cx="1" cy="0" r="1"><stop offset="0" stop-color="${c.gold}" stop-opacity=".16"/><stop offset="1" stop-color="${c.gold}" stop-opacity="0"/></radialGradient>
<filter id="soft" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
</defs>
<rect width="${w}" height="${h}" rx="16" fill="${c.bg}"/>
<rect width="${w}" height="${h}" rx="16" fill="url(#glow)"/>
${dots ? dust(w, h, Math.round(w * h / 5200), 7 + w) : ''}
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="15.5" fill="none" stroke="${c.line}"/>
${logo ? mark(logo[0], logo[1], logo[2]) : ''}
<g font-family="Segoe UI, Helvetica, Arial, sans-serif">${body}</g>
</svg>\n`;
  writeFileSync(new URL(`${name}.svg`, out), svg);
  for (const [index, locale] of ['es', 'pt', 'zh-CN'].entries()) {
    const translations = new Map(artworkTranslations.map(row => [escape(row[0]), escape(row[index + 1])]));
    let localized = svg.replace(/(<(?:text|title)\b[^>]*>)([^<]*)(<\/(?:text|title)>)/g,
      (_, open, value, close) => `${open}${translations.get(value) ?? value}${close}`);
    if (locale === 'zh-CN') {
      localized = localized.replace('Segoe UI, Helvetica, Arial, sans-serif', 'Segoe UI, Microsoft YaHei, Noto Sans CJK SC, sans-serif');
    }
    const dir = new URL(`${locale}/`, out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL(`${name}.svg`, dir), localized);
  }
}

save('hero', 1280, 390, 'Faro. Your files, wherever you work. File and Agent Remote Operations.', `
${text(56, 62, 'FILE & AGENT REMOTE OPERATIONS', 18, c.gold, 600, 'letter-spacing="3"')}
${text(50, 186, 'Faro', 120, c.ink, 650, 'letter-spacing="-6"')}
${text(56, 247, 'Your files, wherever you work.', 34, c.ink, 500)}
${text(56, 289, 'Servers, cloud storage, and remote machines.', 23, c.muted)}
${line(56, 326, 1224, 326)}
${text(56, 360, 'BROWSE  /  TRANSFER  /  AUTOMATE', 16, c.gold, 600, 'letter-spacing="2"')}
${text(1224, 360, 'WINDOWS · macOS · LINUX', 16, c.muted, 400, 'text-anchor="end"')}
<g fill="none" stroke="${c.line}" stroke-width="1.5">
<circle cx="820" cy="168" r="46"/><circle cx="820" cy="168" r="78"/>
<path d="M866 168H950V82H1008 M898 168H1008 M866 168H950V254H1008"/>
</g>
<circle cx="820" cy="168" r="7" fill="${c.gold}"/>
${[['SERVERS', 82], ['CLOUD', 168], ['MACHINES', 254]].map(([label, y]) => `
<rect x="1008" y="${y - 25}" width="216" height="50" rx="6" fill="${c.panel}" stroke="${c.line}"/>
<path d="M1027 ${y}h14" stroke="${c.gold}" stroke-width="2"/>
${text(1054, y + 6, label, 17, c.muted, 500, 'letter-spacing="1.5"')}`).join('')}
`);

save('hero-mobile', 600, 340, 'Faro. Your files, wherever you work. File and Agent Remote Operations.', `
${text(30, 43, 'FILE & AGENT REMOTE OPERATIONS', 19, c.gold, 600, 'letter-spacing="1"')}
${text(26, 150, 'Faro', 106, c.ink, 650, 'letter-spacing="-5"')}
${text(30, 207, 'Your files, wherever you work.', 30, c.ink, 500)}
${text(30, 247, 'Servers, cloud, and remote machines.', 24, c.muted)}
${line(30, 278, 570, 278)}
${text(30, 315, 'WINDOWS · macOS · LINUX', 21, c.gold, 500, 'letter-spacing="1"')}
`);

function card(name, value, label, detail) {
  save(name, 400, 210, `${value} ${label}. ${detail}`, `
${text(28, 87, value, 66, c.gold, 600, 'letter-spacing="-2"')}
${text(28, 130, label, 25, c.ink, 600)}
${line(28, 153, 372, 153)}
${text(28, 184, detail, 18, c.muted)}`, { logo: [352, 26, 44] });
}
card('backends', '17', 'connection types', 'Servers, buckets, drives, and CMS');
card('platforms', '3', 'desktop platforms', 'Windows, macOS, and Linux');
card('interfaces', 'GUI / CLI', 'plus an MCP bridge', 'Browse by hand. Script your work.');

save('pipeline', 600, 290, 'Up to 32 SFTP read requests in flight per range. An implementation limit, not a speed benchmark.', `
${text(32, 43, 'SFTP DOWNLOAD PIPELINE', 16, c.gold, 600, 'letter-spacing="2"')}
${text(30, 132, '32', 88, c.gold, 600)}
${text(160, 99, 'concurrent reads', 26, c.ink, 600)}
${text(160, 135, 'per range, maximum', 21, c.muted)}
${Array.from({length: 32}, (_, i) => `<rect x="${32 + i * 17}" y="169" width="11" height="29" rx="2" fill="${i < 16 ? c.gold : c.dim}"/>`).join('')}
${text(32, 238, 'Starts at 16 when server limits are unknown.', 20, c.muted)}
${text(32, 267, 'Concurrency limit; not a throughput result.', 18, c.muted)}
`, { logo: [548, 20, 44] });

save('resume', 600, 290, 'Resumable downloads. Keep completed ranges and retry missing bytes on supported sources.', `
${text(32, 43, 'RANGED DOWNLOADS', 16, c.gold, 600, 'letter-spacing="2"')}
${text(30, 124, 'Pick up where', 43, c.ink, 600)}
${text(30, 173, 'you left off.', 43, c.ink, 600)}
${Array.from({length: 12}, (_, i) => `<rect x="${32 + i * 45}" y="199" width="38" height="10" rx="2" fill="${i < 8 ? c.gold : c.line}"/>`).join('')}
${text(32, 250, 'Keep completed ranges. Retry missing bytes.', 20, c.muted)}
${text(32, 277, 'Resume support depends on the source.', 18, c.muted)}
`, { logo: [548, 20, 44] });

// MCP flow: agent -> Faro -> server. Text is unchanged so the translations keep matching.
const flowBox = (x, y, w, h, title, subtitle, hero, titleSize, subSize, dy1, dy2) => `
${hero ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${c.gold}" opacity=".35" filter="url(#soft)"/>` : ''}
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${c.panel}" stroke="${hero ? c.gold : c.line}" ${hero ? 'stroke-width="1.5"' : ''}/>
<rect x="${x + 22}" y="${y}" width="44" height="3" rx="1.5" fill="${c.gold}"/>
${text(x + 26, y + dy1, title, titleSize, c.gold, 600, 'letter-spacing="1.5"')}
${text(x + 26, y + dy2, subtitle, subSize, c.ink)}`;
// A wire with a lit node at each end and an arrowhead, like the site's Cloudflare route.
const wire = (x1, y1, x2, y2, vertical) => {
  const head = vertical ? `M${x2 - 8} ${y2 - 9}L${x2} ${y2}L${x2 + 8} ${y2 - 9}` : `M${x2 - 9} ${y2 - 8}L${x2} ${y2}L${x2 - 9} ${y2 + 8}`;
  return `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${c.gold}" stroke-width="2" stroke-linecap="round"/><path d="${head}" fill="none" stroke="${c.gold}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${x1}" cy="${y1}" r="4" fill="${c.hot}"/>`;
};
save('bridge', 1280, 180, 'Your local AI agent connects to Faro over localhost. Faro applies your approval policy before using your authenticated session.', `
${[['YOUR AI AGENT', 'MCP over localhost', 32, false], ['FARO', 'Your approval policy', 450, true], ['YOUR SERVER', 'Authenticated session', 868, false]].map(([title, subtitle, x, hero]) => flowBox(x, 30, 380, 120, title, subtitle, hero, 21, 22, 56, 94)).join('')}
${mark(450 + 380 - 52, 54, 52)}
${wire(420, 90, 442, 90)}${wire(838, 90, 860, 90)}
`);
save('bridge-mobile', 600, 470, 'Local AI agent to Faro approval policy to authenticated server session.', `
${[['YOUR AI AGENT', 'MCP over localhost', 24, false], ['FARO', 'Your approval policy', 184, true], ['YOUR SERVER', 'Authenticated session', 344, false]].map(([title, subtitle, y, hero]) => flowBox(24, y, 552, 102, title, subtitle, hero, 24, 26, 40, 76)).join('')}
${mark(576 - 56, 184 + 25, 52)}
${wire(300, 134, 300, 174, true)}${wire(300, 294, 300, 334, true)}
`);
console.log('Generated 9 README assets in each of 4 languages.');
