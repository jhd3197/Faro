import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

function load(rel) {
  const source = ts.transpileModule(readFileSync(new URL(rel, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const sync = await load("../src/lib/syncBrowse.ts");
const local = await load("../src/lib/localFolder.ts");

function harness(state) {
  let current = state;
  const listed = [];
  return {
    get state() { return current; },
    listed,
    navigate(side, path, otherPath, list = async () => []) {
      return sync.runMirror({
        getState: () => current,
        setState: (next) => { current = next; },
        side,
        path,
        otherPath,
        listDirectory: async (counterpart) => {
          listed.push(counterpart);
          return list(counterpart);
        },
      });
    },
    toggle(on, localPath, remotePath, sessionId) {
      current = sync.toggleSync(current, on, localPath, remotePath, sessionId);
    },
    rebase(localPath, remotePath, sessionId) {
      current = sync.rebaseSync(current, localPath, remotePath, sessionId);
    },
    retarget(sessionId, localPath, remotePath) {
      current = sync.retargetSession(current, sessionId, localPath, remotePath);
    },
  };
}

function paired() {
  const h = harness(sync.initialSyncState());
  h.toggle(true, "/proj", "/var/www", "sess-a");
  return h;
}

describe("synchronized browsing and local folder memory", { concurrency: false }, () => {

test("local subfolder moves the remote pane to the same relative folder", async () => {
  const h = paired();
  const result = await h.navigate("local", "/proj/src/components", "/var/www");
  assert.equal(result.stale, false);
  assert.deepEqual(result.apply, { side: "remote", path: "/var/www/src/components" });
  assert.deepEqual(h.listed, ["/var/www/src/components"]);
});

test("remote subfolder moves the local pane to the same relative folder", async () => {
  const h = paired();
  const result = await h.navigate("remote", "/var/www/uploads/2024", "/proj");
  assert.deepEqual(result.apply, { side: "local", path: "/proj/uploads/2024" });
});

test("going up keeps the relative structure on either side", async () => {
  const h = paired();
  h.rebase("/proj/src", "/var/www/src", "sess-a");
  const upLocal = await h.navigate("local", "/proj", "/var/www/src");
  assert.deepEqual(upLocal.apply, { side: "remote", path: "/var/www" });
  h.rebase("/proj/src/components", "/var/www/src/components", "sess-a");
  const upRemote = await h.navigate("remote", "/var/www/src", "/proj/src/components");
  assert.deepEqual(upRemote.apply, { side: "local", path: "/proj/src" });
});

test("windows local paths mirror onto a posix remote and back", () => {
  assert.equal(
    sync.mapRelative("C:\\Users\\me\\proj", "C:\\Users\\me\\proj\\src", "/var/www"),
    "/var/www/src"
  );
  assert.equal(
    sync.mapRelative("/var/www", "/var/www", "C:\\Users\\me\\proj\\src"),
    "C:\\Users\\me\\proj\\src"
  );
  assert.equal(
    sync.mapRelative("C:\\Users\\me\\proj\\src", "C:\\Users\\me\\proj", "/var/www/src"),
    "/var/www"
  );
  assert.equal(sync.pathsEqual("C:/Users/me/proj", "c:\\users\\me\\proj"), true);
});

test("relative remote bases stay relative, including the SFTP home", () => {
  assert.equal(sync.mapRelative(".", "./public_html", "/srv/site"), "/srv/site/public_html");
  assert.equal(sync.mapRelative("./public_html", "./public_html/wp-content", "/srv/site"), "/srv/site/wp-content");
  assert.equal(sync.mapRelative("./public_html", ".", "/srv/site/public_html"), "/srv/site");
  assert.equal(sync.mapRelative("/srv/site", "/srv/site/wp", "."), "./wp");
});

test("a missing counterpart on either side keeps the current path and explains why", async () => {
  const missing = new Error("No such file or directory");
  for (const side of ["local", "remote"]) {
    const h = paired();
    const path = side === "local" ? "/proj/missing" : "/var/www/missing";
    const other = side === "local" ? "/var/www" : "/proj";
    const result = await h.navigate(side, path, other, async () => { throw missing; });
    assert.equal(result.apply, undefined);
    assert.equal(result.hint.title, "No matching folder");
    assert.match(result.hint.message, /stayed put/);
    assert.equal(h.state.echo, null);
  }
});

test("permission denied does not jump and names the reason", async () => {
  const h = paired();
  const result = await h.navigate("local", "/proj/secret", "/var/www", async () => {
    throw { kind: "permission", message: "Permission denied (os error 13)" };
  });
  assert.equal(result.apply, undefined);
  assert.equal(result.hint.title, "Can't open the matching folder");
  assert.match(result.hint.message, /permission denied/);
  assert.equal(sync.classifyListingError("Access is denied"), "denied");
});

test("a dropped connection does not jump", async () => {
  const h = paired();
  const result = await h.navigate("remote", "/var/www/logs", "/proj", async () => {
    throw new Error("session sess-a not found");
  });
  assert.equal(result.apply, undefined);
  assert.equal(result.hint.title, "Connection dropped");
  assert.equal(sync.classifyListingError({ kind: "network", message: "Connection reset" }), "disconnected");
  assert.equal(sync.classifyListingError("operation timed out"), "disconnected");
});

test("an older existence check cannot overwrite a newer navigation", async () => {
  const h = paired();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = h.navigate("local", "/proj/a", "/var/www", () => gate);
  const second = h.navigate("local", "/proj/a/b", "/var/www", async () => ["ok"]);
  const fresh = await second;
  assert.deepEqual(fresh.apply, { side: "remote", path: "/var/www/a/b" });
  release();
  const late = await first;
  assert.equal(late.stale, true);
  assert.equal(late.apply, undefined);
  assert.deepEqual(h.state.echo, { side: "remote", path: "/var/www/a/b" });
});

test("an echo of a synchronized jump is not treated as a user navigation", async () => {
  const h = paired();
  const moved = await h.navigate("local", "/proj/src", "/var/www");
  assert.equal(moved.apply.path, "/var/www/src");
  const before = h.listed.length;
  const echo = await h.navigate("remote", "/var/www/src", "/proj/src", async () => {
    throw new Error("echo must not list");
  });
  assert.equal(echo.apply, undefined);
  assert.equal(echo.hint, undefined);
  assert.equal(h.listed.length, before);
  assert.equal(h.state.echo, null);
});

test("clearing an unconsumed echo does not drop a newer one", () => {
  const armed = { side: "remote", path: "/var/www/src" };
  const newer = { ...sync.initialSyncState(), echo: { side: "local", path: "/proj/other" } };
  assert.equal(sync.clearMatchingEcho(newer, armed).echo, newer.echo);
  const same = { ...sync.initialSyncState(), echo: armed };
  assert.equal(sync.clearMatchingEcho(same, armed).echo, null);
});

test("switching servers re-bases and drops the previous offset", async () => {
  const h = paired();
  await h.navigate("local", "/proj/src", "/var/www");
  h.retarget("sess-b", "/proj/src", "/srv/app");
  assert.deepEqual(h.state.base, { local: "/proj/src", remote: "/srv/app", sessionId: "sess-b" });
  const next = await h.navigate("local", "/proj/src/lib", "/srv/app");
  assert.equal(next.apply.path, "/srv/app/lib");
  assert.notEqual(next.apply.path, "/srv/app/src/lib");
});

test("disconnecting clears the base so nothing is applied", async () => {
  const h = paired();
  h.retarget(null, "/proj", "/var/www");
  const result = await h.navigate("local", "/proj/src", "/var/www", async () => {
    throw new Error("must not list");
  });
  assert.equal(result.listed, false);
  assert.equal(result.apply, undefined);
  assert.equal(h.listed.length, 0);
});

test("turning sync off leaves both panes independent and cancels an in-flight check", async () => {
  const h = paired();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = h.navigate("local", "/proj/src", "/var/www", () => gate);
  h.toggle(false, "/proj/src", "/var/www", "sess-a");
  release();
  const late = await pending;
  assert.equal(late.stale, true);
  assert.equal(late.apply, undefined);
  const after = await h.navigate("local", "/proj/other", "/var/www", async () => {
    throw new Error("must not list");
  });
  assert.equal(after.listed, false);
  assert.equal(after.apply, undefined);
  assert.equal(h.state.enabled, false);
});

test("re-basing uses the current pair and cancels a probe from the old base", async () => {
  const h = paired();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = h.navigate("local", "/proj/src", "/var/www", () => gate);
  h.rebase("/tmp/work", "/srv/app", "sess-a");
  release();
  assert.equal((await pending).stale, true);
  const next = await h.navigate("remote", "/srv/app/dist", "/tmp/work");
  assert.equal(next.apply.path, "/tmp/work/dist");
});

test("a path on another drive is not forced across and does not list", async () => {
  const h = harness(sync.initialSyncState());
  h.toggle(true, "C:\\work", "/var/www", "sess-a");
  const result = await h.navigate("local", "D:\\other", "/var/www", async () => {
    throw new Error("must not list");
  });
  assert.equal(result.listed, false);
  assert.equal(h.listed.length, 0);
  assert.equal(result.apply, undefined);
  assert.equal(result.hint.title, "Can't mirror that folder");
});

test("climbing above the other root stays put", async () => {
  const h = harness(sync.initialSyncState());
  h.toggle(true, "/proj", "/", "sess-a");
  const result = await h.navigate("local", "/", "/", async () => {
    throw new Error("must not list");
  });
  assert.equal(result.listed, false);
  assert.equal(result.hint.title, "Can't mirror that folder");
});

test("synchronized browsing issues only a directory listing", async () => {
  const issued = [];
  const backend = new Proxy({}, {
    get(_target, prop) {
      return () => {
        issued.push(String(prop));
        if (prop !== "list_directory") throw new Error(`forbidden command ${String(prop)}`);
        return Promise.resolve([]);
      };
    },
  });
  const h = paired();
  const ok = await h.navigate("local", "/proj/src", "/var/www", (path) => backend.list_directory(path));
  assert.equal(ok.apply.path, "/var/www/src");
  await h.navigate("local", "/proj/gone", "/var/www/src", () => {
    issued.push("list_directory");
    return Promise.reject(new Error("No such file or directory"));
  });
  assert.deepEqual(issued, ["list_directory", "list_directory"]);
  const sources = [
    "../src/lib/syncBrowse.ts",
    "../src/lib/localFolder.ts",
    "../src/hooks/useSyncedPanes.tsx",
    "../src/hooks/useRememberedLocalPath.ts",
  ].map((rel) => readFileSync(new URL(rel, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(sources, /enqueueUploads|enqueueDownloads|delete_path|deletePath|create_directory|rename_path/);
  assert.match(readFileSync(new URL("../src/hooks/useSyncedPanes.tsx", import.meta.url), "utf8"), /listDirectory/);
  assert.match(readFileSync(new URL("../src/hooks/useRememberedLocalPath.ts", import.meta.url), "utf8"), /listDirectory/);
});

test("default local path and site shortcuts win over the remembered folder", () => {
  assert.equal(local.resolveLaunchLocalPath({
    defaultLocalPath: "/clients/acme",
    remembered: "/home/yesterday",
    rememberedAccessible: true,
    osRoot: "/",
  }), "/clients/acme");
  assert.equal(local.resolveLaunchLocalPath({
    remembered: "/home/yesterday",
    rememberedAccessible: true,
    osRoot: "/",
  }), "/home/yesterday");
  const notes = [];
  assert.equal(local.resolveLaunchLocalPath({
    remembered: "/home/deleted",
    rememberedAccessible: false,
    osRoot: "/",
  }), "/");
  assert.deepEqual(notes, []);
  assert.equal(local.resolveLaunchRemotePath({
    sitePath: "/var/www/acme",
    serverPath: "/var/www",
    defaultRemotePath: "/",
  }), "/var/www/acme");
  assert.equal(local.resolveLaunchRemotePath({
    serverPath: "/var/www",
    defaultRemotePath: "/",
  }), "/var/www");
});

test("the injected snapshot is the first-frame local folder", () => {
  const previous = globalThis.__FARO_SETTINGS__;
  local.forgetSessionLocalPath();
  globalThis.__FARO_SETTINGS__ = { lastLocalPath: "/home/me/proj" };
  try {
    assert.equal(local.initialLocalPath("Linux"), "/home/me/proj");
    assert.equal(local.osRoot("Mozilla/5.0 (Windows NT 10.0)"), "C:\\");
    assert.equal(local.osRoot("Linux"), "/");
  } finally {
    globalThis.__FARO_SETTINGS__ = previous;
    local.forgetSessionLocalPath();
  }
});

test("a stored path that is not JSON is ignored", () => {
  assert.equal(local.parseStoredLocalPath(JSON.stringify("/tmp/work")), "/tmp/work");
  assert.equal(local.parseStoredLocalPath("not json"), null);
  assert.equal(local.parseStoredLocalPath(JSON.stringify("  ")), null);
  assert.equal(local.parseStoredLocalPath(undefined), null);
});

test("rapid navigation persists only the latest local folder", () => {
  const writes = [];
  let scheduled = null;
  const memory = local.createLocalPathMemory((path) => writes.push(path), 300, (fn) => {
    scheduled = fn;
    return { cancel() { if (scheduled === fn) scheduled = null; } };
  });
  try {
    memory.update("/a");
    memory.update("/a/b");
    memory.update("/a/b/c");
    assert.deepEqual(writes, []);
    assert.equal(local.peekSessionLocalPath(), "/a/b/c");
    scheduled();
    assert.deepEqual(writes, ["/a/b/c"]);
    memory.update("/a/b/c/d");
    memory.flush();
    assert.deepEqual(writes, ["/a/b/c", "/a/b/c/d"]);
    memory.update("/a/b/c/d");
    memory.flush();
    assert.deepEqual(writes, ["/a/b/c", "/a/b/c/d"]);
  } finally {
    local.forgetSessionLocalPath();
  }
});

test("UNC parents stay on the share root", () => {
  assert.equal(
    sync.mapRelative("\\\\server\\share\\a", "\\\\server\\share\\a\\b", "/data"),
    "/data/b"
  );
  assert.equal(sync.mapRelative("\\\\server\\share\\a", "\\\\server\\share", "/data/a"), "/data");
  assert.equal(sync.mapRelative("\\\\server\\share", "\\\\other\\share", "/data"), null);
});

});
