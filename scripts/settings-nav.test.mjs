import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

function load(rel) {
  const source = ts.transpileModule(readFileSync(new URL(rel, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const nav = await load("../src/lib/settingsNav.ts");

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("every settings section has a stable id, label, and command", () => {
  const ids = nav.SETTINGS_SECTIONS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(nav.DEFAULT_SETTINGS_SECTION, "appearance");
  assert.ok(ids.includes("appearance"));
  assert.ok(ids.includes("sync"));
  assert.ok(ids.includes("remoteControl"));
  for (const sec of nav.SETTINGS_SECTIONS) {
    assert.equal(typeof sec.label, "string");
    assert.ok(sec.label.length > 0);
    assert.equal(nav.settingsCommandId(sec.id), `settings:${sec.id}`);
    assert.equal(nav.isSettingsSectionId(sec.id), true);
    assert.deepEqual(nav.normalizeSettingsTarget(sec.id), { section: sec.id });
  }
  assert.equal(nav.isSettingsSectionId("not-a-section"), false);
  assert.equal(nav.normalizeSettingsTarget("not-a-section"), null);
  assert.equal(nav.normalizeSettingsTarget(""), null);
  assert.equal(nav.normalizeSettingsTarget(null), null);
  assert.equal(nav.normalizeSettingsTarget({ section: "nope", focus: "x" }), null);
});

test("named entry points open a real section, and a focus id when the control is a field", () => {
  const expected = {
    statusBarSync: { section: "sync" },
    folderSyncError: { section: "sync" },
    inviteCloudflare: { section: "cloudflare", focus: nav.SETTINGS_FOCUS.cloudflareAccount },
    moveToCloudflare: { section: "cloudflare", focus: nav.SETTINGS_FOCUS.cloudflareAccount },
    downloadFolder: { section: "transfers", focus: nav.SETTINGS_FOCUS.downloadFolder },
    cloudflaredUpdate: { section: "cloudflare", focus: nav.SETTINGS_FOCUS.cloudflared },
    profileCloudflareAccount: { section: "cloudflare", focus: nav.SETTINGS_FOCUS.cloudflareAccount },
    aboutCliInstall: { section: "cli" },
    keyboardCustomize: { section: "keyboard", focus: nav.SETTINGS_FOCUS.keyboardSearch },
    pairingRemoteControl: { section: "remoteControl", focus: nav.SETTINGS_FOCUS.showPairingCode },
  };
  assert.deepEqual(nav.SETTINGS_ENTRY_POINTS, expected);
  for (const [id, target] of Object.entries(expected)) {
    assert.deepEqual(nav.entryPointTarget(id), target);
    assert.deepEqual(nav.normalizeSettingsTarget(target), target);
  }
  assert.deepEqual(
    nav.normalizeSettingsTarget({ section: "transfers", focus: "  settings-download-folder  " }),
    { section: "transfers", focus: "settings-download-folder" },
  );
});

test("each entry point is wired in the UI, and generic settings still opens with no section", () => {
  const wired = {
    statusBarSync: "../src/App.tsx",
    folderSyncError: "../src/lib/notifications.ts",
    inviteCloudflare: "../src/components/InviteDialog.tsx",
    moveToCloudflare: "../src/components/MoveToCloudflareDialog.tsx",
    downloadFolder: "../src/components/FileBrowser.tsx",
    cloudflaredUpdate: "../src/components/AuthPromptModal.tsx",
    profileCloudflareAccount: "../src/components/ProfileEditor.tsx",
    pairingRemoteControl: "../src/components/ProfileEditor.tsx",
    aboutCliInstall: "../src/components/AboutSettings.tsx",
    keyboardCustomize: "../src/components/KeyboardShortcutsDialog.tsx",
  };
  for (const [id, file] of Object.entries(wired)) {
    const src = read(file);
    assert.match(
      src,
      new RegExp(`SETTINGS_ENTRY_POINTS\\.${id}\\b|entry="${id}"`),
      `${file} should use ${id}`,
    );
  }
  const commands = read("../src/lib/commands.tsx");
  assert.match(commands, /SETTINGS_SECTIONS\.map/);
  assert.match(commands, /openSettings\(sec\.id\)/);
  assert.match(commands, /openDialog\("settings"\)/);
  const titleBar = read("../src/components/TitleBar.tsx");
  assert.equal([...titleBar.matchAll(/openDialog\("settings"\)/g)].length, 2);
  assert.doesNotMatch(titleBar, /openSettings\(/);
});
