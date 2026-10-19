// Dependency-free README artwork. Run: node scripts/generate-readme-art.mjs
// Keep colors here so banners and cards share one palette.
import { mkdirSync, writeFileSync } from 'node:fs';
import { artworkTranslations } from './readme-art-translations.mjs';

const out = new URL('../docs/images/readme/', import.meta.url);
mkdirSync(out, { recursive: true });
const c = { bg: '#10141c', panel: '#181e28', line: '#343b47', gold: '#e9bd69', ink: '#f4f1ea', muted: '#b2bac7' };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const text = (x, y, value, size = 24, fill = c.ink, weight = 400, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${escape(value)}</text>`;
const line = (x1, y1, x2, y2, color = c.line) => `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${color}"/>`;
function save(name, w, h, title, body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title">
<title id="title">${escape(title)}</title>
<rect width="${w}" height="${h}" rx="16" fill="${c.bg}"/>
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
${text(28, 184, detail, 18, c.muted)}`);
}
card('backends', '17', 'connection types', 'Servers, buckets, drives, and CMS');
card('platforms', '3', 'desktop platforms', 'Windows, macOS, and Linux');
card('interfaces', 'GUI / CLI', 'plus an MCP bridge', 'Browse by hand. Script your work.');

save('pipeline', 600, 290, 'Up to 32 SFTP read requests in flight per range. An implementation limit, not a speed benchmark.', `
${text(32, 43, 'SFTP DOWNLOAD PIPELINE', 16, c.gold, 600, 'letter-spacing="2"')}
${text(30, 132, '32', 88, c.gold, 600)}
${text(160, 99, 'concurrent reads', 26, c.ink, 600)}
${text(160, 135, 'per range, maximum', 21, c.muted)}
${Array.from({length: 32}, (_, i) => `<rect x="${32 + i * 17}" y="169" width="11" height="29" rx="2" fill="${i < 16 ? c.gold : '#695638'}"/>`).join('')}
${text(32, 238, 'Starts at 16 when server limits are unknown.', 20, c.muted)}
${text(32, 267, 'Concurrency limit; not a throughput result.', 18, c.muted)}
`);

save('resume', 600, 290, 'Resumable downloads. Keep completed ranges and retry missing bytes on supported sources.', `
${text(32, 43, 'RANGED DOWNLOADS', 16, c.gold, 600, 'letter-spacing="2"')}
${text(30, 124, 'Pick up where', 43, c.ink, 600)}
${text(30, 173, 'you left off.', 43, c.ink, 600)}
${Array.from({length: 12}, (_, i) => `<rect x="${32 + i * 45}" y="199" width="38" height="10" rx="2" fill="${i < 8 ? c.gold : c.line}"/>`).join('')}
${text(32, 250, 'Keep completed ranges. Retry missing bytes.', 20, c.muted)}
${text(32, 277, 'Resume support depends on the source.', 18, c.muted)}
`);

save('bridge', 1280, 180, 'Your local AI agent connects to Faro over localhost. Faro applies your approval policy before using your authenticated session.', `
${[['YOUR AI AGENT', 'MCP over localhost', 32], ['FARO', 'Your approval policy', 450], ['YOUR SERVER', 'Authenticated session', 868]].map(([title, subtitle, x]) => `
<rect x="${x}" y="30" width="380" height="120" rx="8" fill="${c.panel}" stroke="${c.line}"/>
${text(x + 26, 77, title, 21, c.gold, 600, 'letter-spacing="1.5"')}
${text(x + 26, 115, subtitle, 22, c.ink)}`).join('')}
<path d="M412 90h30m-8-6 8 6-8 6M830 90h30m-8-6 8 6-8 6" fill="none" stroke="${c.gold}" stroke-width="2"/>
`);
save('bridge-mobile', 600, 470, 'Local AI agent to Faro approval policy to authenticated server session.', `
${[['YOUR AI AGENT', 'MCP over localhost', 24], ['FARO', 'Your approval policy', 184], ['YOUR SERVER', 'Authenticated session', 344]].map(([title, subtitle, y]) => `
<rect x="24" y="${y}" width="552" height="102" rx="8" fill="${c.panel}" stroke="${c.line}"/>
${text(50, y + 40, title, 24, c.gold, 600, 'letter-spacing="1.5"')}
${text(50, y + 76, subtitle, 26, c.ink)}`).join('')}
<path d="M300 134v40m-8-8 8 8 8-8M300 294v40m-8-8 8 8 8-8" fill="none" stroke="${c.gold}" stroke-width="2"/>
`);
console.log('Generated 9 README assets in each of 4 languages.');
