// Real-app check for Plans 36 and 37: drives a running Faro build over CDP
// and calls the new commands through the real IPC layer, so argument names,
// serialisation and the AppHandle-bound paths are exercised, not just the
// functions behind them.
//
//   CDP_PORT   WebView2 remote-debugging port of the build under test (9334)
//   LAB        host:port:user:pass of an SSH host with tmux (the Docker lab:
//              127.0.0.1:2225:admin:lab-pass). Unset = local checks only.
//   LAB_EXEC   command prefix that runs a shell line on that host as the user
//              (default: docker exec -u admin scripts-host-1 sh -c)
//
// Launch the build as scripts/CAPTURE notes describe: its own identifier, and
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<CDP_PORT>.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const PORT = Number(process.env.CDP_PORT || 9334);
const LAB = process.env.LAB ? process.env.LAB.split(":") : null;
const PROFILE_ID = "verify-plans-36-37";

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().includes("devtools"));
const invoke = (cmd, args = {}) => page.evaluate((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), cmd, args);
const fails = (cmd, args) =>
  page.evaluate(
    (c, a) => window.__TAURI_INTERNALS__.invoke(c, a).then(() => null, (e) => e),
    cmd,
    args
  );

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`  FAIL ${name}\n       ${String(e.message ?? e).split("\n").join("\n       ")}`);
  }
}

// Terminal output arrives as events; collect it per terminal id.
await page.evaluate(async () => {
  window.__termOut = {};
  const handler = window.__TAURI_INTERNALS__.transformCallback((e) => {
    const { terminalId, data } = e.payload;
    window.__termOut[terminalId] = (window.__termOut[terminalId] ?? "") + data;
  });
  await window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
    event: "terminal://data",
    target: { kind: "Any" },
    handler,
  });
});
const termOut = (id) => page.evaluate((id) => window.__termOut[id] ?? "", id);
const allTermOut = () => page.evaluate(() => Object.values(window.__termOut).join(""));
async function waitFor(read, needle, ms = 20_000) {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = await read();
    if (last.includes(needle)) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(last.slice(-300))}`);
}

const scratch = mkdtempSync(path.join(os.tmpdir(), "faro-verify-3637-"));
console.log(`Plans 36/37 against the real app (CDP ${PORT})`);

// ---------- Plan 36: local shell ----------
await check("local shells are listed, the default first", async () => {
  const shells = await invoke("list_local_shells");
  assert.ok(Array.isArray(shells) && shells.length > 0, JSON.stringify(shells));
  for (const s of shells) assert.ok(s.id && s.name && s.program, JSON.stringify(s));
  if (process.platform === "win32") assert.ok(shells.some((s) => s.id === "cmd"));
});

await check("a local shell runs a command and reports its exit", async () => {
  const win = process.platform === "win32";
  // Output can arrive before the id is known; that is what the buffer above
  // is for.
  const id = await invoke("open_terminal", {
    sessionId: "local",
    cols: 100,
    rows: 30,
    shell: win ? "cmd" : null,
    cwd: scratch,
    persistName: null,
    scrollback: null,
  });
  if (win) {
    // ConPTY asks for the cursor position before starting the shell.
    await waitFor(allTermOut, "\x1b[6n", 10_000).catch(() => {});
    await invoke("terminal_write", { terminalId: id, data: "\x1b[1;1R" });
  }
  await invoke("terminal_write", { terminalId: id, data: win ? "set /a 4000+321\r\n" : "echo $((4000+321))\n" });
  await waitFor(() => termOut(id), "4321");
  await invoke("terminal_resize", { terminalId: id, cols: 120, rows: 40 });
  await invoke("terminal_write", { terminalId: id, data: win ? "cd\r\n" : "pwd\n" });
  await waitFor(() => termOut(id), path.basename(scratch));
  await invoke("close_terminal", { terminalId: id, endSession: true });
});

await check("a pasted image is saved locally and its path returned", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8Dwn4GBgQEADQEB/4o5HXMAAAAASUVORK5CYII=";
  const saved = await invoke("terminal_paste_image", { sessionId: "local", data: png, ext: "png" });
  assert.ok(existsSync(saved), saved);
  assert.equal(readFileSync(saved).toString("base64"), png);
  assert.equal(await invoke("read_image_file", { sessionId: "local", path: saved }), png, "the viewer reads it back");
  rmSync(saved, { force: true });
});

await check("terminal output can be written to a chosen file", async () => {
  const file = path.join(scratch, "output.txt");
  await invoke("write_text_file", { path: file, contents: "line one\nline two\n" });
  assert.equal(readFileSync(file, "utf8"), "line one\nline two\n");
});

await check("a single setting can be read back (workspace storage)", async () => {
  const key = "terminalWorkspace:verify";
  await invoke("settings_set", { key, value: JSON.stringify({ v: 1, tabs: [] }) });
  assert.equal(await invoke("settings_get", { key }), JSON.stringify({ v: 1, tabs: [] }));
  await invoke("settings_delete", { key });
  assert.equal(await invoke("settings_get", { key }), null);
});

// ---------- Plan 37: editor on a local file ----------
await check("the editor reads, saves, and refuses to overwrite a changed file", async () => {
  const file = path.join(scratch, "site.conf");
  writeFileSync(file, "listen 80;\n");
  const opened = await invoke("editor_read", { sessionId: "local", path: file });
  assert.equal(opened.text, "listen 80;\n");
  assert.ok(opened.stamp && typeof opened.stamp.size === "number", JSON.stringify(opened.stamp));

  const saved = await invoke("editor_write", { sessionId: "local", path: file, text: "listen 8080;\n", expected: opened.stamp, force: false });
  assert.equal(readFileSync(file, "utf8"), "listen 8080;\n");
  assert.notDeepEqual(saved, opened.stamp);

  await sleep(20);
  writeFileSync(file, "changed by someone else, and longer\n");
  const err = await fails("editor_write", { sessionId: "local", path: file, text: "mine\n", expected: saved, force: false });
  assert.equal(err?.kind, "conflict", JSON.stringify(err));
  assert.equal(readFileSync(file, "utf8"), "changed by someone else, and longer\n", "their change is intact");

  await invoke("editor_write", { sessionId: "local", path: file, text: "mine\n", expected: saved, force: true });
  assert.equal(readFileSync(file, "utf8"), "mine\n");

  writeFileSync(path.join(scratch, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  const binary = await fails("editor_read", { sessionId: "local", path: path.join(scratch, "blob.bin") });
  assert.equal(binary?.kind, "unsupported", JSON.stringify(binary));
});

// ---------- Against an SSH host ----------
if (LAB) {
  const [host, port, user, pass] = LAB;
  const labExec = (line) => {
    const prefix = (process.env.LAB_EXEC || "docker exec -u admin scripts-host-1 sh -c").split(" ");
    return execFileSync(prefix[0], [...prefix.slice(1), line], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  };
  let sessionId = null;

  await check("connects to the lab host", async () => {
    await invoke("save_profile", {
      profile: { id: PROFILE_ID, name: "verify 36/37", protocol: "sftp", host, port: Number(port), username: user, auth: { kind: "password", password: pass } },
    });
    const pending = page.evaluate((id) => window.__TAURI_INTERNALS__.invoke("connect", { profileId: id }), PROFILE_ID);
    // An unknown host key asks first. "Accept once" never writes known_hosts.
    const deadline = Date.now() + 20_000;
    let settled = false;
    pending.then(() => (settled = true), () => (settled = true));
    while (!settled && Date.now() < deadline) {
      const clicked = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Accept once");
        b?.click();
        return !!b;
      });
      if (clicked) break;
      await sleep(250);
    }
    sessionId = await pending;
    assert.ok(sessionId);
  });

  if (sessionId) {
    const name = "faro-verify3637";
    labExec(`tmux -L faro kill-session -t '=${name}' 2>/dev/null; true`);

    await check("a persistent shell survives closing the pane and is the same shell on return", async () => {
      const first = await invoke("open_terminal", { sessionId, cols: 100, rows: 30, shell: null, cwd: null, persistName: name, scrollback: 5000 });
      await sleep(700);
      await invoke("terminal_write", { terminalId: first, data: "export FARO_KEEP=still-here; seq 1 150; echo first-$((40+2))\n" });
      const out = await waitFor(() => termOut(first), "first-42");
      assert.ok(!out.includes("\x1b[?1049h"), "no alternate screen, so the output is in the scrollback");
      const listed = await invoke("terminal_persist_list", { sessionId });
      assert.ok(listed.some((s) => s.name === name), JSON.stringify(listed));

      // Detach, as a disconnect does.
      await invoke("close_terminal", { terminalId: first, endSession: false });
      await sleep(800);
      assert.match(labExec("tmux -L faro ls -F '#{session_name} #{session_attached}'"), new RegExp(`${name} 0`), "still there, detached");

      const second = await invoke("open_terminal", { sessionId, cols: 100, rows: 30, shell: null, cwd: null, persistName: name, scrollback: 5000 });
      // The history is replayed before the live screen.
      await waitFor(() => termOut(second), "\r\n57\r\n", 10_000);
      await sleep(700);
      await invoke("terminal_write", { terminalId: second, data: "echo keep=$FARO_KEEP\n" });
      await waitFor(() => termOut(second), "keep=still-here");

      // Closing by hand ends it.
      await invoke("close_terminal", { terminalId: second, endSession: true });
      await sleep(800);
      assert.ok(!labExec("tmux -L faro ls -F '#{session_name}' 2>/dev/null; true").includes(name), "ended");
    });

    await check("a persistent pane's session name must be one of Faro's", async () => {
      const err = await fails("open_terminal", { sessionId, cols: 80, rows: 24, shell: null, cwd: null, persistName: "main; rm -rf /", scrollback: 100 });
      assert.match(String(err), /invalid persistent session name/);
      const kill = await fails("terminal_persist_kill", { sessionId, name: "main" });
      assert.match(String(kill), /Not a Faro session name/);
    });

    await check("a pasted image lands on the host, readable by its owner only", async () => {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8Dwn4GBgQEADQEB/4o5HXMAAAAASUVORK5CYII=";
      const remote = await invoke("terminal_paste_image", { sessionId, data: png, ext: "png" });
      assert.match(remote, /\/\.cache\/faro\/pastes\/paste-.*\.png$/);
      const stat = labExec(`stat -c '%a %s' '${remote}'; base64 -w0 '${remote}'; rm -f '${remote}'`).split("\n");
      assert.equal(stat[0], `600 ${Buffer.from(png, "base64").length}`);
      assert.equal(stat[1].trim(), png);
    });

    await check("the editor saves to the host and a server-side change blocks the next save", async () => {
      const file = `/tmp/faro-verify-${Date.now()}.conf`;
      labExec(`printf 'listen 80;\\n' > ${file} && chmod 640 ${file}`);
      const opened = await invoke("editor_read", { sessionId, path: file });
      assert.equal(opened.text, "listen 80;\n");
      const saved = await invoke("editor_write", { sessionId, path: file, text: "listen 8080;\n", expected: opened.stamp, force: false });
      assert.equal(labExec(`cat ${file}; stat -c '%a' ${file}`), "listen 8080;\n640\n", "content saved, mode kept");
      labExec(`printf 'changed on the server, and longer\\n' > ${file}`);
      const err = await fails("editor_write", { sessionId, path: file, text: "mine\n", expected: saved, force: false });
      assert.equal(err?.kind, "conflict", JSON.stringify(err));
      assert.equal(labExec(`cat ${file}`), "changed on the server, and longer\n");
      labExec(`rm -f ${file}`);
    });

    const waitTransfers = async (ids, ms = 60_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const rows = (await invoke("list_transfers")).filter((t) => ids.includes(t.id));
        if (rows.length === ids.length && rows.every((t) => ["done", "error", "canceled", "skipped"].includes(t.status))) return rows;
        await sleep(200);
      }
      throw new Error("transfers did not finish");
    };
    const countFiles = (dir) => {
      let n = 0;
      for (const e of readdirSync(dir)) {
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) n += countFiles(p);
        else n++;
      }
      return n;
    };
    const remoteDir = `/tmp/faro-verify-tar-${Date.now()}`;

    await check("a folder of small files downloads as one stream, complete", async () => {
      labExec(`mkdir -p ${remoteDir}/site/a/b '${remoteDir}/site/empty dir' && cd ${remoteDir}/site && i=0; while [ $i -lt 120 ]; do printf 'file %s\\n' $i > "a/f $i.txt"; printf '%s' $i > "a/b/g$i.bin"; i=$((i+1)); done; printf 'root' > index.html`);
      const dest = path.join(scratch, "down");
      mkdirSync(dest);
      const ids = await invoke("start_directory_download", { sessionId, remoteDir: `${remoteDir}/site`, localDir: dest, overwritePolicy: "overwrite" });
      assert.equal(ids.length, 1, "one row for the whole folder");
      const [row] = await waitTransfers(ids);
      assert.equal(row.status, "done", JSON.stringify(row));
      assert.equal(row.files, 241);
      assert.equal(countFiles(path.join(dest, "site")), 241);
      assert.equal(readFileSync(path.join(dest, "site", "a", "f 7.txt"), "utf8"), "file 7\n");
      assert.equal(readFileSync(path.join(dest, "site", "index.html"), "utf8"), "root");
      assert.ok(statSync(path.join(dest, "site", "empty dir")).isDirectory());
    });

    await check("the same folder uploads as one stream, and the row adds up for the upload report", async () => {
      const src = path.join(scratch, "down", "site");
      const ids = await invoke("start_directory_upload", { sessionId, localDir: src, remoteDir: `${remoteDir}/up`, overwritePolicy: "overwrite", expectedFingerprint: null });
      assert.equal(ids.length, 1);
      const [row] = await waitTransfers(ids);
      assert.equal(row.status, "done", JSON.stringify(row));
      assert.equal(row.files, 241);
      assert.equal(row.transferred, row.size);
      const remote = labExec(`cd ${remoteDir}/up/site && find . -type f | wc -l && test -d 'empty dir' && echo dir && cat 'a/f 7.txt'`).split("\n");
      assert.equal(remote[0].trim(), "241");
      assert.equal(remote[1], "dir");
      assert.equal(remote[2], "file 7");
    });

    await check("with the setting off, the same download goes file by file", async () => {
      await invoke("transfer_set_tar_folders", { enabled: false });
      const dest = path.join(scratch, "plain");
      mkdirSync(dest);
      const ids = await invoke("start_directory_download", { sessionId, remoteDir: `${remoteDir}/site`, localDir: dest, overwritePolicy: "overwrite" });
      assert.equal(ids.length, 241, "one row per file");
      const rows = await waitTransfers(ids, 120_000);
      assert.ok(rows.every((t) => t.status === "done"), JSON.stringify(rows.find((t) => t.status !== "done")));
      assert.equal(countFiles(path.join(dest, "site")), 241);
      await invoke("transfer_set_tar_folders", { enabled: true });
    });

    await check("change permissions keeps the file's content", async () => {
      const file = `${remoteDir}/perm.txt`;
      labExec(`printf 'keep these bytes' > ${file} && chmod 644 ${file}`);
      await invoke("chmod_path", { sessionId, path: file, mode: 0o600 });
      assert.equal(labExec(`stat -c '%a %s' ${file}; cat ${file}`), "600 16\nkeep these bytes");
    });

    labExec(`rm -rf ${remoteDir}`);
    await invoke("disconnect", { sessionId }).catch(() => {});
  }
  await invoke("delete_profile", { id: PROFILE_ID }).catch(() => {});
}

rmSync(scratch, { recursive: true, force: true });
const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${LAB ? "" : " (local checks only; set LAB for the SSH ones)"}`);
await browser.disconnect();
process.exit(failed.length ? 1 : 0);
