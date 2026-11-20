// Real-app runtime verification for Plan 34 (Copy to…, Mount as folder, file
// index, tags on the remote, Settings › Rules, write-back). Drives a
// `--features virtualfs` build of Faro over WebView2's DevTools port, with
// throwaway connections to two lab servers in its own data dir:
//   1. Copy to…: right-click a folder on the SFTP lab › Copy to… › the S3 lab;
//      preview shows the plan, the run lands every byte, a re-run skips all.
//   2. Rules: create a rule set in Settings › Rules; Copy to… with it renames.
//   3. Mount as folder: right-click the S3 lab › Mount as folder… with Index
//      files and Upload on; the folder lists the bucket, a file opens with the
//      right bytes, a file saved there uploads.
//   4. Index + tags: the bucket is indexed (EXIF read from a real JPEG); the
//      Indexed files search finds it by camera; Tags… stores the tag in the
//      object's metadata.
//   5. Unmount from Settings › Sync clears the placeholders.
// Env: CDP (default http://127.0.0.1:9334), OUT_DIR, MOUNT_DIR, S3 (endpoint),
// S3_BUCKET, S3_KEY, S3_SECRET, SFTP_PORT. Exit 0 = every check passed.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const OUT = path.resolve(process.env.OUT_DIR || ".");
const MOUNT = path.resolve(process.env.MOUNT_DIR || path.join(OUT, "mount-r2"));
const S3 = process.env.S3 || "http://127.0.0.1:9300";
const BUCKET = process.env.S3_BUCKET || "media";
const KEY = process.env.S3_KEY || "faroadmin";
const SECRET = process.env.S3_SECRET || "farosecret123";
const SFTP_PORT = Number(process.env.SFTP_PORT || 2232);
mkdirSync(OUT, { recursive: true });
/** Unique folders per run, so a re-run never sees the last run's copies. */
const RUN = `e2e-${Date.now()}`;

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const s3 = (method, key, extra = []) =>
  execFileSync("curl", ["-s", "--aws-sigv4", "aws:amz:us-east-1:s3", "--user", `${KEY}:${SECRET}`, "-X", method, ...extra, `${S3}/${BUCKET}/${key}`], {
    encoding: "utf8",
  });
const s3head = (key) => s3("HEAD", key, ["-I"]);
const s3get = (key) => s3("GET", key);
const cmd = (...args) => {
  try {
    return execFileSync("cmd", ["/C", ...args], { encoding: "utf8" });
  } catch (e) {
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
};

const browser = await puppeteer.connect({ browserURL: process.env.CDP || "http://127.0.0.1:9334", defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().includes("devtools"));
const invoke = (c, a = {}) => page.evaluate((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), c, a);
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

async function waitFor(fn, ms = 20000, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* keep waiting */
    }
    await sleep(every);
  }
  return null;
}

/** Click the first enabled element under `root` whose text starts with `label`. */
async function clickText(label, root = "body", sel = "button,[role=menuitem],[role=option]") {
  const ok = await waitFor(
    () =>
      page.evaluate(
        (label, root, sel) => {
          const roots = [...document.querySelectorAll(root)];
          const el = roots
            .flatMap((r) => [...r.querySelectorAll(sel)])
            .find((b) => b.textContent.trim().startsWith(label) && !b.disabled && b.offsetParent !== null);
          if (el) el.click();
          return !!el;
        },
        label,
        root,
        sel
      ),
    10000
  );
  if (!ok) throw new Error(`nothing enabled labelled "${label}" in ${root}`);
}

/** Set a React-controlled input's value. */
async function setInput(selector, value) {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.evaluate(
    (selector, value) => {
      const el = document.querySelector(selector);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    selector,
    value
  );
}

async function rightClick(selector) {
  const el = await page.waitForSelector(selector, { timeout: 15000 });
  await el.click({ button: "right" });
}

const dialog = '[role="dialog"]';

/** Connect the SFTP lab from the rail (unless a restored session already is)
 *  and wait for its home folder in the remote pane. */
async function ensureSftp() {
  if (await page.$('[data-file-pane="remote"] [data-path="/home/faro/lib"]')) return;
  await page.keyboard.press("Escape");
  await rightClick('[data-rail-profile-id="plan34-sftp"]');
  const connected = await page.evaluate(() =>
    [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].some((b) => b.textContent.trim().startsWith("Disconnect"))
  );
  if (connected) {
    await page.keyboard.press("Escape");
    await page.click('[data-rail-profile-id="plan34-sftp"]');
  } else {
    await clickText("Connect", '[role="menu"]');
  }
  // Host key: accept once (never write ~/.ssh/known_hosts).
  const prompt = await waitFor(
    () => page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("Accept once"))),
    8000
  );
  if (prompt) await clickText("Accept once");
  await waitFor(() => page.$('[data-file-pane="remote"] [data-path="/home/faro/lib"]'), 30000);
}

// ---------- setup: two lab connections ----------
const sftp = {
  id: "plan34-sftp",
  name: "labsftp",
  protocol: "sftp",
  host: "127.0.0.1",
  port: SFTP_PORT,
  username: "faro",
  auth: { kind: "password", password: "faropass" },
  defaultRemotePath: "/home/faro",
};
const r2 = {
  id: "plan34-s3",
  name: "labr2",
  protocol: "s3",
  host: "127.0.0.1",
  port: 9300,
  username: KEY,
  auth: { kind: "password", password: SECRET },
  bucket: BUCKET,
  region: "us-east-1",
  endpoint: S3,
  defaultRemotePath: "/",
};

// A real JPEG with EXIF (camera + date) in the bucket, for the index.
const jpg = path.join(OUT, "exif.jpg");
execFileSync("python", [
  "-c",
  `from PIL import Image
img = Image.new("RGB", (64, 48), (200, 120, 40))
ex = Image.Exif()
ex[0x010F] = "Canon"; ex[0x0110] = "Canon EOS R6"
ex.get_ifd(0x8769)[0x9003] = "2024:06:01 12:30:00"
img.save(r"${jpg}", exif=ex)`,
]);
s3("PUT", "photos/shoot/IMG_0001.jpg", ["--data-binary", `@${jpg}`]);

try {
  for (const p of [sftp, r2]) await invoke("save_profile", { profile: p });
  await page.reload();
  await waitFor(() => page.evaluate(() => !!document.querySelector('[data-rail-profile-id="plan34-sftp"]')), 30000);

  // ---------- 1. Copy to… ----------
  console.log("1. Copy to…");
  await ensureSftp();
  await rightClick('[data-file-pane="remote"] [data-path="/home/faro/lib"]');
  await clickText("Copy to…", '[role="menu"]');
  await page.waitForSelector('[data-testid="copy-to-dialog"]');
  await page.click('[aria-label="Destination connection"]');
  await clickText("labr2", "body", '[role="option"],[role="menuitem"],button');
  await setInput("#copy-to-folder", `/${RUN}`);
  await clickText("Preview", dialog);
  const planText = await waitFor(() => page.evaluate(() => document.querySelector('[data-testid="copy-plan"]')?.innerText), 30000);
  check("Copy to… previews a plan", /3 to copy/.test(planText ?? ""), (planText ?? "").split("\n")[0]);
  await shot("1-copy-plan");
  await clickText("Copy 3 files", dialog);
  const job = await waitFor(async () => (await invoke("copyto_jobs")).find((j) => j.state !== "running"), 60000);
  check("Copy job finishes without errors", job?.state === "done" && job.done === 3, JSON.stringify(job && { state: job.state, done: job.done, failed: job.failed }));
  const sftpBytes = execFileSync("docker", ["exec", "faro34-sftp", "md5sum", "/home/faro/lib/a.jpg"], { encoding: "utf8" }).split(" ")[0];
  const s3Bytes = execFileSync("python", ["-c", `import hashlib,sys;print(hashlib.md5(sys.stdin.buffer.read()).hexdigest())`], {
    input: execFileSync("curl", ["-s", "--aws-sigv4", "aws:amz:us-east-1:s3", "--user", `${KEY}:${SECRET}`, `${S3}/${BUCKET}/${RUN}/lib/a.jpg`]),
    encoding: "utf8",
  })
    .match(/[0-9a-f]{32}/)?.[0];
  check("Copied bytes match the source", sftpBytes === s3Bytes, `${sftpBytes} vs ${s3Bytes}`);
  check("CSV report written", !!job?.report && existsSync(job.report), job?.report);
  await invoke("copyto_clear");
  // Same copy again: the preview says everything is already there.
  await rightClick('[data-file-pane="remote"] [data-path="/home/faro/lib"]');
  await clickText("Copy to…", '[role="menu"]');
  await page.waitForSelector('[data-testid="copy-to-dialog"]');
  await page.click('[aria-label="Destination connection"]');
  await clickText("labr2", "body", '[role="option"],[role="menuitem"],button');
  await setInput("#copy-to-folder", `/${RUN}`);
  await clickText("Preview", dialog);
  const againText = await waitFor(() => page.evaluate(() => document.querySelector('[data-testid="copy-plan"]')?.innerText), 30000);
  check("A second Copy to… skips what landed", /0 to copy .* 3 already there/.test(againText ?? ""), (againText ?? "").split("\n")[0]);
  await page.keyboard.press("Escape");

  // ---------- 2. Rules ----------
  console.log("2. Rules");
  await invoke("rules_save", {
    set: {
      id: "",
      name: "E2E tidy",
      rules: [{ id: "", kind: "rename", enabled: true, when: { nameGlob: "*.txt" }, template: "note_{name}{ext}", cleanup: { lowercaseExt: true } }],
    },
  });
  await page.keyboard.down("Control");
  await page.keyboard.press(",");
  await page.keyboard.up("Control");
  await sleep(500);
  const settingsOpen = await waitFor(() => page.evaluate(() => [...document.querySelectorAll("button,a")].some((b) => b.textContent.trim() === "Rules")), 5000);
  if (settingsOpen) {
    await clickText("Rules", '[role="dialog"]', "button,a");
    const listed = await waitFor(() => page.evaluate(() => !!document.querySelector('[data-rule-set="E2E tidy"]')), 8000);
    check("Settings › Rules lists the rule set", !!listed);
    await shot("2-rules");
    await page.keyboard.press("Escape");
  } else {
    check("Settings opens with Ctrl+,", false);
  }
  await page.reload();
  await waitFor(() => page.evaluate(() => !!document.querySelector('[data-rail-profile-id="plan34-sftp"]')), 30000);
  await ensureSftp();
  await rightClick('[data-file-pane="remote"] [data-path="/home/faro/lib"]');
  await clickText("Copy to…", '[role="menu"]');
  await page.waitForSelector('[data-testid="copy-to-dialog"]');
  await page.click('[aria-label="Destination connection"]');
  await clickText("labr2", "body", '[role="option"],[role="menuitem"],button');
  await setInput("#copy-to-folder", `/${RUN}-rules`);
  await page.click('[aria-label="Rename with rules"]');
  await clickText("E2E tidy", "body", '[role="option"],[role="menuitem"],button');
  await clickText("Preview", dialog);
  const rulesPlan = await waitFor(() => page.evaluate(() => document.querySelector('[data-testid="copy-plan"]')?.innerText), 30000);
  check("Copy to… with rules renames in the preview", /note_b\.txt/.test(rulesPlan ?? "") && /1 renamed/.test(rulesPlan ?? ""), (rulesPlan ?? "").split("\n")[0]);
  await shot("2-copy-rules");
  await clickText("Copy", dialog);
  await waitFor(async () => (await invoke("copyto_jobs")).find((j) => j.state === "done"), 60000);
  check("Renamed file landed", s3get(`${RUN}-rules/lib/2024/note_b.txt`).trim() === "hello");

  // ---------- 3. Mount as folder ----------
  console.log("3. Mount as folder");
  check("Mount folder starts absent", !existsSync(MOUNT), MOUNT);
  await rightClick('[data-rail-profile-id="plan34-s3"]');
  await clickText("Mount as folder…", '[role="menu"]');
  await page.waitForSelector('[data-testid="mount-dialog"]');
  await setInput("#mount-local", MOUNT);
  await page.evaluate(() => {
    for (const label of ["Index files", "Upload files I save here"]) {
      const box = [...document.querySelectorAll('[data-testid="mount-dialog"] label')].find((l) => l.textContent.includes(label))?.querySelector("input");
      if (box && !box.checked) box.click();
    }
  });
  await shot("3-mount-dialog");
  await clickText("Mount", dialog);
  const listed = await waitFor(() => {
    const out = cmd("dir", "/B", MOUNT);
    return out.includes(RUN) && /photos/.test(out) ? out : null;
  }, 30000);
  check("Mounted folder lists the bucket", !!listed, (listed ?? "").replace(/\r?\n/g, ", "));
  const opened = await waitFor(() => readFileSync(path.join(MOUNT, RUN, "lib", "2024", "b.txt"), "utf8"), 30000);
  check("A file opens with the right bytes (downloaded on open)", opened?.trim() === "hello", JSON.stringify(opened));
  writeFileSync(path.join(MOUNT, "saved-here.txt"), "written in Explorer");
  const uploaded = await waitFor(() => s3get("saved-here.txt").includes("written in Explorer"), 30000, 1000);
  check("A file saved in the mount uploads", !!uploaded);

  // ---------- 4. Index + tags ----------
  console.log("4. Index + tags");
  const root = await waitFor(async () => (await invoke("index_roots")).find((r) => r.connectionId === "plan34-s3" && !r.running && r.files > 0), 60000, 1000);
  check("The mount's bucket is indexed", !!root, root && `${root.files} files`);
  const hits = await invoke("index_search", { query: { camera: "Canon EOS R6" } });
  check("Index read EXIF from the JPEG header", hits.length === 1 && hits[0].width === 64 && hits[0].height === 48, JSON.stringify(hits[0] && { camera: hits[0].camera, w: hits[0].width, h: hits[0].height, taken: hits[0].takenMs }));
  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await page.keyboard.type("Search indexed files");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="index-search"]', { timeout: 10000 });
  // The camera filter appears once the facets load.
  await (await page.waitForSelector('[aria-label="Camera"]', { timeout: 10000 })).click();
  await clickText("Canon EOS R6", "body", '[role="option"],[role="menuitem"],button');
  const onlyOne = await waitFor(
    () => page.evaluate(() => document.querySelectorAll("[data-index-result]").length === 1),
    10000
  );
  const card = await page.$('[data-index-result="/photos/shoot/IMG_0001.jpg"]');
  check("Indexed files search narrows to the photo by camera", !!onlyOne && !!card);
  const thumb = await waitFor(() => page.evaluate(() => !!document.querySelector('[data-index-result="/photos/shoot/IMG_0001.jpg"] img')), 15000);
  check("Its thumbnail shows", !!thumb);
  await shot("4-index-search");
  const contentType = (h) => /content-type:\s*([^\r\n]+)/i.exec(h ?? "")?.[1]?.trim();
  const typeBefore = contentType(s3head("photos/shoot/IMG_0001.jpg"));
  await card.click();
  await clickText("Tags…", '[data-testid="index-search"]');
  await page.waitForSelector('[data-testid="tags-dialog"]');
  await setInput('[aria-label="Add tags"]', "client-x, Hero");
  await clickText("Save", '[data-testid="tags-dialog"]');
  const head = await waitFor(() => {
    const h = s3head("photos/shoot/IMG_0001.jpg");
    return /x-amz-meta-faro-tags:\s*client-x,hero/i.test(h) ? h : null;
  }, 15000, 500);
  check("Tags are stored in the object's metadata", !!head);
  const typeAfter = contentType(head);
  check("…and the object keeps its content type", !!typeBefore && typeBefore === typeAfter, `${typeBefore} → ${typeAfter}`);
  const tagged = await invoke("index_search", { query: { tag: "hero" } });
  check("Search by tag finds it", tagged.length === 1);
  await page.keyboard.press("Escape");

  // ---------- 5. Unmount ----------
  console.log("5. Unmount");
  const mounts = await invoke("virtualfs_mounts");
  const m = mounts.find((x) => x.profileId === "plan34-s3");
  check("Mount is running", !!m?.running, JSON.stringify(m && { running: m.running, err: m.lastError }));
  if (m) await invoke("virtualfs_mount_remove", { id: m.id });
  const left = existsSync(MOUNT) ? readdirSync(MOUNT) : [];
  check("Unmount leaves only files with local data", left.every((n) => n === "saved-here.txt") , left.join(", "));
} catch (e) {
  failures++;
  console.log(`  ✗ FAIL  ${e.message}`);
  await shot("error").catch(() => {});
} finally {
  // Throwaway state: profiles (and their keychain secrets), rule sets, index roots.
  for (const id of ["plan34-sftp", "plan34-s3"]) await invoke("delete_profile", { id }).catch(() => {});
  for (const s of await invoke("rules_list").catch(() => [])) await invoke("rules_delete", { id: s.id }).catch(() => {});
  for (const r of await invoke("index_roots").catch(() => [])) await invoke("index_forget", { connectionId: r.connectionId, root: r.root }).catch(() => {});
  for (const m of await invoke("virtualfs_mounts").catch(() => [])) await invoke("virtualfs_mount_remove", { id: m.id }).catch(() => {});
  await browser.disconnect();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
