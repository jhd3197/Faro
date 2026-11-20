// Screenshot every Settings section in the mock build, dark and light.
//   node scripts/shoot-settings.mjs <out-dir> [port]
// Also fails (exit 1) if a section throws or renders a banned class
// (see docs/plans/settings-ui-rules.md, rule 97) when SETTINGS_LINT=1.
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2];
const PORT = Number(process.argv[3] || 1437);
if (!OUT) {
  console.error("usage: node scripts/shoot-settings.mjs <out-dir> [port]");
  process.exit(2);
}
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => p && existsSync(p));

const BANNED = [
  /text-\[1[01](\.5)?px\]/,
  /rounded-(lg|xl|2xl)\b/,
  /backdrop-blur/,
  /\b(bg|text|border)-(red|emerald|amber|green|yellow)-\d{3}/,
];

process.env.VITE_UI_LOCALE = "en";
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  mode: "mock",
  logLevel: "error",
  server: { host: "127.0.0.1", port: PORT, strictPort: true, hmr: false, watch: { ignored: ["**/*"] } },
});
let browser;
let failures = 0;
try {
  await server.listen();
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox"],
    defaultViewport: { width: 1440, height: 920 },
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    failures++;
    console.log("pageerror:", e.message);
  });
  for (let i = 0; i < 5; i++) {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(() => window.__demo?.useSettings && document.body.innerText.includes("Faro"), { timeout: 20000 });
      break;
    } catch {
      if (i === 4) throw new Error("demo never booted");
    }
  }
  const sections = await page.evaluate(async () => {
    const m = await import("/src/lib/settingsNav.ts");
    return m.SETTINGS_SECTIONS.map((s) => s.id);
  });
  for (const mode of ["dark", "light"]) {
    await page.evaluate((m) => window.__demo.useSettings.getState().setThemeMode(m), mode);
    await new Promise((r) => setTimeout(r, 500));
    for (const id of sections) {
      await page.evaluate((s) => window.__demo.useLayout.getState().openSettings(s), id);
      await page.waitForFunction(
        (s) => document.querySelector("[data-settings-heading]")?.dataset.settingsHeading === s,
        { timeout: 5000 },
        id,
      );
      await new Promise((r) => setTimeout(r, 450));
      await page.screenshot({ path: `${OUT}/${mode}-${id}.png` });
      if (process.env.SETTINGS_LINT === "1" && mode === "dark") {
        const bad = await page.evaluate((src) => {
          const res = src.map((s) => new RegExp(s));
          const dlg = document.querySelector('[role="dialog"]');
          const hits = new Set();
          for (const el of dlg.querySelectorAll("[class]")) {
            const c = el.getAttribute("class");
            for (const r of res) {
              const m = c.match(r);
              if (m) hits.add(m[0]);
            }
          }
          return [...hits];
        }, BANNED.map((r) => r.source));
        if (bad.length) {
          failures++;
          console.log(`lint ${id}: ${bad.join(", ")}`);
        }
      }
    }
  }
  // Search across every section.
  await page.evaluate(() => window.__demo.useSettings.getState().setThemeMode("dark"));
  await page.evaluate(() => window.__demo.useLayout.getState().openSettings("appearance"));
  for (const term of ["pass", "theme"]) {
    await page.click("[data-settings-search]", { clickCount: 3 });
    await page.type("[data-settings-search]", term);
    await new Promise((r) => setTimeout(r, 700));
    await page.screenshot({ path: `${OUT}/search-${term}.png` });
  }
  console.log(`shots: ${OUT} (${sections.length * 2 + 2})`);
} finally {
  await browser?.close();
  await server.close();
}
process.exit(failures ? 1 : 0);
