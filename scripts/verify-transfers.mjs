// Headless runtime verification for Plan 17 (transfer queue depth). Spins up
// the mock Vite build (no Rust), drives the transfer panel via window.__demo
// plus the mock transfer engine (src/mock/transfers.ts, which records the
// commands the UI invokes), and asserts on the real rendered DOM:
// counts/positions, pause/resume, pause-all, retry, reorder, throttle, and the
// mid-auto-retry rendering. Exit code 0 = all checks passed.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT =
  process.env.SHOT_DIR ||
  "C:/Users/Juan/AppData/Local/Temp/claude/C--Users-Juan-Documents-GitHub-Faro/cbf0dfb0-7a23-418f-834f-25dcd5128966/scratchpad";
const PORT = 1425;
const URL = `http://localhost:${PORT}/`;

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("No Chrome/Edge found.");
  process.exit(2);
}
const isWin = process.platform === "win32";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function waitForServer(url, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`mock server never came up at ${url}`);
}
function killTree(child) {
  if (!child || child.killed) return;
  if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-child.pid, "SIGKILL"); } catch {}
}

async function main() {
  console.log("› starting mock Vite server…");
  const server = spawn("npm", ["run", "dev:mock"], {
    cwd: ROOT,
    shell: true,
    stdio: "ignore",
    detached: !isWin,
  });
  let browser;
  try {
    await waitForServer(URL);
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      args: ["--hide-scrollbars"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (e) => {
      console.log("  page error:", e.message);
      failures++;
    });

    const drive = (fn, ...a) => page.evaluate(fn, ...a);
    const shot = async (name) => {
      await page.screenshot({ path: path.join(OUT, `verify-transfers-${name}.png`) });
      console.log("    · shot", `verify-transfers-${name}.png`);
    };

    let booted = false;
    for (let attempt = 0; attempt < 5 && !booted; attempt++) {
      await page.goto(URL, { waitUntil: "networkidle0" });
      try {
        await page.waitForFunction(() => !!window.__demo?.seedTransfers, { timeout: 8_000 });
        booted = true;
      } catch {
        console.log(`    · boot attempt ${attempt + 1} missed __demo, reloading…`);
        await sleep(1500);
      }
    }
    if (!booted) throw new Error("app never exposed window.__demo");
    await sleep(800); // let App effects (loadInitial + initListeners) run

    // In-page helpers: locate a transfer row by its source path, click one of
    // its buttons by title, and read the recorded mock transfer calls.
    await drive(() => {
      window.__vt = {
        row(src) {
          const el = [...document.querySelectorAll(".font-mono")].find(
            (e) => e.textContent === src
          );
          return el?.closest("div.flex.items-center.gap-3") ?? null;
        },
        btn(src, title) {
          const r = window.__vt.row(src);
          return r?.querySelector(`button[title="${title}"]`) ?? null;
        },
        click(src, title) {
          window.__vt.btn(src, title)?.click();
        },
        clickHeader(title) {
          document.querySelector(`button[title="${title}"]`)?.click();
        },
        calls(cmd) {
          return window.__demo.transferCalls.filter((c) => c.cmd === cmd);
        },
      };
    });
    const rowText = (src) =>
      drive((s) => window.__vt.row(s)?.innerText ?? "", src);

    const SRC = {
      a1: "/srv/batch/a1.bin",
      a2: "/srv/batch/a2.bin",
      q1: "/srv/batch/q1.bin",
      q2: "/srv/batch/q2.bin",
      e1: "/srv/batch/e1.bin",
      r1: "/srv/batch/r1.bin",
    };
    const seedBatch = () =>
      drive((SRC) => {
        const mk = (id, status, extra = {}) => ({
          id,
          kind: "download",
          source: `/srv/batch/${id}.bin`,
          destination: `C:\\Users\\demo\\Downloads\\${id}.bin`,
          size: 1000,
          transferred: 400,
          status,
          startedAt: Date.now(),
          ...extra,
        });
        window.__demo.seedTransfers(
          [
            mk("a1", "transferring"),
            mk("a2", "transferring"),
            mk("q1", "queued", { transferred: 0 }),
            mk("q2", "queued", { transferred: 0 }),
            mk("e1", "error", { transferred: 0, error: "connection reset" }),
          ],
          { waiting: ["q1", "q2"], concurrency: 2, throttleKbps: 0 }
        );
        const st = window.__demo.useTransfers.getState();
        st.setPanelOpen(true);
        return st.loadInitial();
      }, SRC);

    // ---- 1. Seeded batch: header counts + queue positions ----
    await seedBatch();
    await sleep(400);
    const hdr = await drive(() => document.body.innerText);
    check(
      "header shows '2 active · 2 queued'",
      hdr.includes("2 active · 2 queued"),
      hdr.match(/\d+ active · \d+ queued/)?.[0] ?? "no badge"
    );
    check("first queued row shows '#1 in queue'", (await rowText(SRC.q1)).includes("#1 in queue"));
    check("second queued row shows '#2 in queue'", (await rowText(SRC.q2)).includes("#2 in queue"));
    await shot("1-batch");

    // ---- 2. Pause a transferring row → Paused; resume → transferring ----
    await drive((s) => window.__vt.click(s, "Pause"), SRC.a1);
    await sleep(300);
    let t = await rowText(SRC.a1);
    check("paused row shows Paused label", t.includes("Paused"), t.replace(/\n/g, " | "));
    check(
      "paused row offers Resume",
      await drive((s) => !!window.__vt.btn(s, "Resume"), SRC.a1)
    );
    check(
      "pause invoked transfer_pause on the mock",
      (await drive((s) => window.__vt.calls("transfer_pause").map((c) => c.args.transferId), SRC.a1)).includes("a1")
    );
    await drive((s) => window.__vt.click(s, "Resume"), SRC.a1);
    await sleep(300);
    t = await rowText(SRC.a1);
    check("resumed row is transferring again (0%)", t.includes("0%"), t.replace(/\n/g, " | "));
    check(
      "resume invoked transfer_resume on the mock",
      (await drive(() => window.__vt.calls("transfer_resume").map((c) => c.args.transferId))).includes("a1")
    );

    // ---- 3. Pause-all → header toggle flips; queued rows stay queued ----
    await drive(() => window.__vt.clickHeader("Pause all"));
    await sleep(300);
    check(
      "pause-all flips the header toggle to Resume all",
      await drive(() => !!document.querySelector('button[title="Resume all"]'))
    );
    check("queued rows stay queued under pause-all", (await rowText(SRC.q1)).includes("#1 in queue"));
    await shot("3-pause-all");
    await drive(() => window.__vt.clickHeader("Resume all"));
    await sleep(300);
    check(
      "resume-all flips the header toggle back to Pause all",
      await drive(() => !!document.querySelector('button[title="Pause all"]'))
    );

    // ---- 4. Retry an error row → transfer_retry recorded, row re-queued ----
    await drive((s) => window.__vt.click(s, "Retry"), SRC.e1);
    await sleep(300);
    check(
      "retry invoked transfer_retry on the mock",
      (await drive(() => window.__vt.calls("transfer_retry").map((c) => c.args.transferId))).includes("e1")
    );
    t = await rowText(SRC.e1);
    check("retried row returns to the queue tail (#3)", t.includes("#3 in queue"), t.replace(/\n/g, " | "));
    check("retried row no longer offers Retry", await drive((s) => !window.__vt.btn(s, "Retry"), SRC.e1));

    // ---- 5. Reorder: move q2 up; FIFO ends disable the buttons ----
    await drive((s) => window.__vt.click(s, "Move up"), SRC.q2);
    await sleep(300);
    const moveCalls = await drive(() => window.__vt.calls("transfer_move"));
    check(
      "move invoked transfer_move(up) on q2",
      moveCalls.some((c) => c.args.transferId === "q2" && c.args.direction === "up"),
      JSON.stringify(moveCalls)
    );
    check("q2 is now '#1 in queue'", (await rowText(SRC.q2)).includes("#1 in queue"));
    check(
      "Move up disabled at the FIFO head",
      await drive((s) => window.__vt.btn(s, "Move up")?.disabled === true, SRC.q2)
    );
    check(
      "Move down disabled at the FIFO tail",
      await drive((s) => window.__vt.btn(s, "Move down")?.disabled === true, SRC.e1)
    );
    await shot("5-reorder");

    // ---- 6. Throttle input commits → transfer_set_throttle ----
    await drive(() => {
      const input = document.querySelector('input[type="number"]');
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(input, "512");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
    });
    await sleep(300);
    const throttleCalls = await drive(() => window.__vt.calls("transfer_set_throttle"));
    check(
      "throttle commit invoked transfer_set_throttle(512)",
      throttleCalls.some((c) => c.args.kbps === 512),
      JSON.stringify(throttleCalls)
    );
    check(
      "store throttleKbps followed the queue event",
      (await drive(() => window.__demo.useTransfers.getState().throttleKbps)) === 512
    );

    // ---- 7. Mid-auto-retry row renders the 'retrying in Ns' text as warning ----
    await drive((SRC) => {
      window.__demo.seedTransfers(
        [
          {
            id: "r1",
            kind: "upload",
            source: SRC.r1,
            destination: "/srv/app/r1.bin",
            size: 2048,
            transferred: 512,
            status: "transferring",
            retryAttempt: 2,
            error: "retrying in 5s (attempt 2/3)",
            startedAt: Date.now(),
          },
        ],
        { waiting: [] }
      );
      return window.__demo.useTransfers.getState().loadInitial();
    }, SRC);
    await sleep(400);
    t = await rowText(SRC.r1);
    check("mid-auto-retry row renders the retrying text", t.includes("retrying in 5s (attempt 2/3)"), t.replace(/\n/g, " | "));
    check(
      "retrying text is styled as warning, not failure",
      await drive(
        (s) => !!window.__vt.row(s)?.querySelector(".text-warning"),
        SRC.r1
      )
    );
    await shot("7-retrying");

    // ---- 8. Plan 24: batched progress drives speed / ETA / stalled / notice ----
    await drive(() => {
      const mk = (id, extra = {}) => ({
        id,
        kind: "download",
        source: `/srv/big/${id}.iso`,
        destination: `C:\\Users\\demo\\Downloads\\${id}.iso`,
        size: 100 * 1024 * 1024,
        transferred: 0,
        status: "transferring",
        startedAt: Date.now(),
        ...extra,
      });
      window.__demo.seedTransfers([mk("s1"), mk("s2"), mk("s3")], { waiting: [] });
      return window.__demo.useTransfers.getState().loadInitial();
    });
    await sleep(300);
    // One batch event updates several rows at once.
    await drive(() => {
      const base = (id, extra) => ({
        ...window.__demo.useTransfers.getState().byId[id],
        ...extra,
      });
      window.__demo.emit("transfer://progress-batch", [
        base("s1", { transferred: 50 * 1024 * 1024, bytesPerSec: 5 * 1024 * 1024, etaSecs: 10, segments: 4 }),
        base("s2", { transferred: 10 * 1024 * 1024, bytesPerSec: 1024 * 1024, etaSecs: 90 }),
        base("s3", { transferred: 1024 * 1024, stalled: true, notice: "remote changed, restarted" }),
      ]);
    });
    await sleep(300);
    t = await rowText("/srv/big/s1.iso");
    check("batched row shows its speed", t.includes("5.0 MB/s"), t.replace(/\n/g, " | "));
    check("batched row shows its ETA", t.includes("10s"), t.replace(/\n/g, " | "));
    check("batched row shows 50%", t.includes("50%"), t.replace(/\n/g, " | "));
    check(
      "segment count is in the speed tooltip",
      await drive(() =>
        !!window.__vt.row("/srv/big/s1.iso")?.querySelector('[title="4 parallel connections"]')
      )
    );
    t = await rowText("/srv/big/s2.iso");
    check(
      "second row from the same batch updated",
      t.includes("1.0 MB/s") && t.includes("1m 30s"),
      t.replace(/\n/g, " | ")
    );
    t = await rowText("/srv/big/s3.iso");
    check("stalled row reads 'not responding'", t.includes("not responding"), t.replace(/\n/g, " | "));
    check("notice line renders", t.includes("remote changed, restarted"), t.replace(/\n/g, " | "));
    const hdr8 = await drive(() => document.body.innerText);
    check(
      "header shows the combined speed",
      hdr8.includes("6.0 MB/s"),
      hdr8.match(/[\d.]+ MB\/s/g)?.join(",") ?? "none"
    );
    await shot("8-speed-eta");

    // ---- 9. Plan 24: a row restored from the last session ----
    await drive(() => {
      window.__demo.seedTransfers(
        [
          {
            id: "old1",
            kind: "download",
            source: "/srv/big/old.iso",
            destination: "C:\\Users\\demo\\Downloads\\old.iso",
            size: 1000,
            transferred: 400,
            status: "paused",
            restored: true,
            startedAt: Date.now(),
          },
        ],
        { waiting: [] }
      );
      return window.__demo.useTransfers.getState().loadInitial();
    });
    await sleep(300);
    t = await rowText("/srv/big/old.iso");
    check("restored row shows Paused at its progress", t.includes("Paused") && t.includes("400 B"), t.replace(/\n/g, " | "));
    check("restored row explains it needs its connection", t.includes("Open its connection, then resume"), t.replace(/\n/g, " | "));
    check("restored row offers Resume", await drive(() => !!window.__vt.btn("/srv/big/old.iso", "Resume")));
    await drive(() => window.__vt.click("/srv/big/old.iso", "Resume"));
    await sleep(300);
    check(
      "Resume on a restored row invokes transfer_resume",
      (await drive(() => window.__vt.calls("transfer_resume").map((c) => c.args.transferId))).includes("old1")
    );
    await shot("9-restored");

    // ---- 10. Upload results are dismissible, with retained failure history ----
    await drive(() => window.__demo.useTransfers.setState({
      panelOpen: false, uploadReportsOpen: true,
      uploadReports: [{
        id: "report-close", sessionId: "test", destination: "/site", files: 1,
        directories: 1, verifiedDirectories: 0, bytes: 100, transferIds: [],
        errors: ["assets: permission denied"], retryItems: [], skipped: 0,
        canceled: false, preparing: false, validation: "error", directoryPaths: [],
      }],
    }));
    await page.waitForSelector('[aria-label="Hide upload results"]');
    check("upload preparation failure is visible", await drive(() =>
      document.querySelector('[aria-label="Upload results"]')?.textContent.includes("assets: permission denied")));
    await page.click('[aria-label="Hide upload results"]');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Upload results"]'));
    check("close button removes the upload panel", await drive(() =>
      !document.querySelector('[aria-label="Upload results"]')));
    check("closing preserves upload errors", await drive(() =>
      window.__demo.useTransfers.getState().uploadReports[0].errors[0] === "assets: permission denied"));
    await page.click('button[title="Transfer queue"]');
    await page.waitForSelector('[aria-label="Upload results"]');
    check("Transfers reopens retained upload results", await drive(() =>
      document.querySelector('[aria-label="Upload results"]')?.textContent.includes("assets: permission denied")));
    await page.click('button[title="Transfer queue"]');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Upload results"]'));
    check("Transfers toggle hides upload results with the queue", await drive(() =>
      !document.querySelector('[aria-label="Upload results"]')));

    if (failures === 0) console.log("\n✅ all transfer-queue checks passed");
    else console.log(`\n❌ ${failures} check(s) failed`);
  } finally {
    if (browser) await browser.close();
    killTree(server);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify crashed:", e);
  process.exit(3);
});
