import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ArrowLeft, ArrowLeftRight, Trash2, Plus } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/lib/ipc";
import { useSync } from "@/stores/syncStore";
import { useConnections } from "@/stores/connectionsStore";
import { relTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Dropdown } from "./ui/Dropdown";
import { MountsSettings } from "./MountsSettings";
import {
  Advanced,
  Btn,
  Empty,
  Group,
  InfoTip,
  List,
  ListRow,
  Note,
  Row,
  Segmented,
  Status,
  SubHeading,
  Switch,
  TextInput,
  inputClass,
} from "./settings/kit";
import type {
  PairView,
  SyncDirection,
  SyncMode,
  SyncPair,
  SyncStrategy,
  TwoWayConflict,
} from "@/lib/types";

/// Settings → Folder Sync. Configure continuous, watched sync pairs: pick a
/// local folder + a saved connection + a remote path, choose a direction and
/// strategy, and the backend keeps them in sync in the background. The list of
/// pairs (and their live status) lives in the sync store, driven by the
/// "foldersync://changed" event.
export function SyncSettings() {
  const pairs = useSync((s) => s.pairs);
  const [adding, setAdding] = useState(false);

  // Make sure the store is populated even if the pill/App init hasn't run yet.
  useEffect(() => {
    void useSync.getState().refresh();
  }, []);

  const addBtn = (
    <Btn variant="primary" size="sm" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
      Add folder
    </Btn>
  );

  return (
    <div className="space-y-3">
      {adding && <PairForm onDone={() => setAdding(false)} />}

      {pairs.length === 0 ? (
        !adding && <Empty action={addBtn}>No folders syncing yet.</Empty>
      ) : (
        <>
          <SubHeading
            title="Folders"
            help="Sync runs while Faro is open. Each folder is watched and kept in step with its server path."
            actions={!adding && addBtn}
          />
          <List data-sync-pairs="">
            {pairs.map((p) => (
              <PairRow key={p.id} pair={p} />
            ))}
          </List>
        </>
      )}
      <MountsSettings />
    </div>
  );
}

function pairStatus(pair: PairView): { tone: "ok" | "warn" | "bad" | "off" | "busy"; text: string } {
  if (!pair.enabled) return { tone: "off", text: "Paused" };
  if (pair.state === "error") return { tone: "bad", text: "Error" };
  if (pair.mode === "onDemand") return { tone: "ok", text: "On demand" };
  if (pair.state === "syncing")
    return { tone: "busy", text: `Syncing${pair.inFlight > 0 ? ` · ${pair.inFlight}` : ""}` };
  const live = pair.running || pair.state === "idle";
  if (pair.lastSynced) return { tone: live ? "ok" : "off", text: `Synced ${relTime(pair.lastSynced)} ago` };
  return { tone: "off", text: "Never synced" };
}

function PairRow({ pair }: { pair: PairView }) {
  const profiles = useConnections((s) => s.profiles);
  const setEnabled = useSync((s) => s.setEnabled);
  const remove = useSync((s) => s.remove);
  const syncNow = useSync((s) => s.syncNow);
  const [conflicts, setConflicts] = useState<TwoWayConflict[]>([]);
  const [resolving, setResolving] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  useEffect(() => {
    if (pair.twoWay)
      void ipc.folderSyncConflicts(pair.id).then(setConflicts).catch((e) => setConflictError(String(e)));
  }, [pair.id, pair.twoWay, pair.state, pair.lastError, pair.lastSynced]);
  async function resolveConflict(conflict: TwoWayConflict, local: boolean) {
    setResolving(true);
    setConflictError(null);
    try {
      await ipc.folderSyncResolve(pair.id, conflict, local);
      await syncNow(pair.id);
      setConflicts(await ipc.folderSyncConflicts(pair.id));
    } catch (e) {
      setConflictError(String(e));
    } finally {
      setResolving(false);
    }
  }
  const [freeing, setFreeing] = useState(false);

  const profile = profiles.find((p) => p.id === pair.profileId);
  const Arrow = pair.twoWay ? ArrowLeftRight : pair.direction === "localToRemote" ? ArrowRight : ArrowLeft;
  const syncing = pair.state === "syncing";
  const isOnDemand = pair.mode === "onDemand";
  const st = pairStatus(pair);

  const freeUpSpace = async () => {
    setFreeing(true);
    try {
      await ipc.virtualFsFreeUpSpace(pair.id);
    } catch {
      // best-effort; the OS "Free up space" also works from Explorer
    } finally {
      setFreeing(false);
    }
  };

  const how = isOnDemand
    ? "On demand: files download when opened"
    : `${pair.twoWay ? "Both directions" : pair.direction === "localToRemote" ? "Upload" : "Download"} · ${
        pair.strategy === "mirror" ? "Sync deletions" : "Keep extra files"
      }`;
  const excludes = pair.exclude?.length
    ? `\nExcludes: ${pair.exclude.join(", ")}`
    : "";
  const showConflicts = pair.twoWay && conflicts.length > 0;
  const hasExtra = !!pair.lastError || !!conflictError || showConflicts;

  return (
    <ListRow
      data-sync-pair={pair.id}
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{pair.name}</span>
          <span className="shrink-0 text-xs text-text-dim">{profile?.name ?? "unknown server"}</span>
        </span>
      }
      detail={
        <span
          className="flex min-w-0 items-center gap-1.5 font-mono"
          title={`${pair.localRoot}\n${pair.remoteRoot}\n${how}${excludes}`}
        >
          <span className="min-w-0 truncate">{pair.localRoot}</span>
          <Arrow size={11} className="shrink-0" />
          <span className="min-w-0 truncate">{pair.remoteRoot}</span>
        </span>
      }
      status={<Status tone={st.tone}>{st.text}</Status>}
      actions={
        <>
          {isOnDemand ? (
            <Btn
              size="sm"
              onClick={freeUpSpace}
              busy={freeing}
              disabled={!pair.enabled}
              title="Evict downloaded files back to placeholders"
            >
              Free up space
            </Btn>
          ) : (
            <Btn size="sm" onClick={() => syncNow(pair.id)} disabled={!pair.enabled || syncing} title="Sync now">
              Sync now
            </Btn>
          )}
          <Switch checked={pair.enabled} onChange={(v) => setEnabled(pair.id, v)} label={`Sync ${pair.name}`} />
          <Btn
            variant="ghost"
            size="sm"
            onClick={() => remove(pair.id)}
            title="Remove this sync pair"
            aria-label="Remove this sync pair"
            className="w-6 px-0 hover:text-danger"
            icon={<Trash2 size={12} />}
          />
        </>
      }
    >
      {hasExtra ? (
        <div className="space-y-1">
          {pair.lastError && (
            <Note tone="danger">
              <span className="break-all">{pair.lastError}</span>
            </Note>
          )}
          {conflictError && <Note tone="danger">{conflictError}</Note>}
          {showConflicts && (
            <div data-sync-conflicts="" className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-warning">
                {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}
                <InfoTip text="Choose a version for each file. The other version goes to recovery. Choices are rechecked before applying." />
              </div>
              {conflicts.map((conflict) => (
                <div key={conflict.relative} className="flex min-h-7 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted" title={conflict.relative}>
                    {conflict.relative}
                  </span>
                  {([true, false] as const).map((local) => {
                    const file = local ? conflict.state.local : conflict.state.remote;
                    return (
                      <Btn
                        key={String(local)}
                        size="sm"
                        disabled={resolving || !pair.enabled}
                        onClick={() => void resolveConflict(conflict, local)}
                      >
                        Use {local ? "local" : "remote"} {file ? `(${file.size} bytes)` : "deletion"}
                      </Btn>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : undefined}
    </ListRow>
  );
}

function PairForm({ onDone }: { onDone: () => void }) {
  const profiles = useConnections((s) => s.profiles);
  const upsert = useSync((s) => s.upsert);

  const profileOptions = useMemo(
    () => profiles.map((p) => ({ value: p.id, label: p.name })),
    [profiles]
  );

  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [localRoot, setLocalRoot] = useState("");
  const [remoteRoot, setRemoteRoot] = useState(
    profiles[0]?.defaultRemotePath ?? ""
  );
  const [twoWay, setTwoWay] = useState(false);
  const [direction, setDirection] = useState<SyncDirection>("localToRemote");
  const [strategy, setStrategy] = useState<SyncStrategy>("additive");
  const [mode, setMode] = useState<SyncMode>("mirror");
  const [vfsSupported, setVfsSupported] = useState(false);
  const [pollIntervalSecs, setPollIntervalSecs] = useState(60);
  const [excludeText, setExcludeText] = useState("");
  const [mirrorDeleteCap, setMirrorDeleteCap] = useState(100);
  const [busy, setBusy] = useState(false);

  // On-demand placeholders are Windows-only (and gated behind the `virtualfs`
  // build); only offer the mode where it actually works.
  useEffect(() => {
    ipc.virtualFsSupported().then(setVfsSupported).catch(() => setVfsSupported(false));
  }, []);

  const pickProfile = (id: string) => {
    setProfileId(id);
    // Seed the remote path from the profile's default when it's still blank.
    const prof = profiles.find((p) => p.id === id);
    if (prof?.defaultRemotePath && !remoteRoot) setRemoteRoot(prof.defaultRemotePath);
  };

  const browse = async () => {
    const picked = await open({ directory: true, title: "Choose a local folder" });
    if (typeof picked === "string") {
      setLocalRoot(picked);
      if (!name) {
        const base = picked.split(/[/\\]/).filter(Boolean).pop();
        if (base) setName(base);
      }
    }
  };

  const canSubmit =
    name.trim() !== "" &&
    profileId !== "" &&
    localRoot.trim() !== "" &&
    remoteRoot.trim() !== "";

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const pair: SyncPair = {
      id: "",
      name: name.trim(),
      localRoot: localRoot.trim(),
      profileId,
      remoteRoot: remoteRoot.trim(),
      direction,
      twoWay: mode === "mirror" && twoWay,
      strategy,
      mode,
      enabled: true,
      pollIntervalSecs,
      exclude: parseExclude(excludeText),
      mirrorDeleteCap,
    };
    try {
      await upsert(pair);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const deletedNote =
    strategy === "additive"
      ? twoWay
        ? "Deleted files come back from the other side."
        : "Extra files stay in the destination."
      : "Deleted files go to recovery.";

  return (
    <Group
      title="Add folder"
      actions={
        <Btn variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Btn>
      }
    >
      <Row label="Name">
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My project"
          aria-label="Name"
          className="w-56"
        />
      </Row>

      <Row label="Connection">
        {profileOptions.length === 0 ? (
          <span className="text-sm text-text-dim">No saved connections yet.</span>
        ) : (
          <Dropdown<string>
            value={profileId}
            onChange={pickProfile}
            options={profileOptions}
            searchable={profileOptions.length > 8}
            aria-label="Connection"
            className="h-7 w-56 py-0"
          />
        )}
      </Row>

      <Row label="Local folder">
        <TextInput
          value={localRoot}
          onChange={(e) => setLocalRoot(e.target.value)}
          placeholder="C:\path\to\folder"
          aria-label="Local folder"
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Btn onClick={browse}>Browse…</Btn>
      </Row>

      <Row label="Remote path">
        <TextInput
          value={remoteRoot}
          onChange={(e) => setRemoteRoot(e.target.value)}
          placeholder="/home/user/folder"
          aria-label="Remote path"
          className="min-w-0 flex-1 font-mono text-xs"
        />
      </Row>

      {vfsSupported && (
        <Row
          label="Mode"
          help="On demand: files show as placeholders and download only when opened. Free up space turns them back into placeholders. Direction, deletions and excludes don't apply."
        >
          <Segmented<SyncMode>
            value={mode}
            onChange={setMode}
            label="Mode"
            options={[
              { value: "mirror", label: "Copy files" },
              { value: "onDemand", label: "On demand" },
            ]}
          />
        </Row>
      )}

      {mode === "mirror" && (
        <>
          <Row label="Direction" help={twoWay ? "If both copies change, you choose which to keep." : undefined}>
            <Dropdown<string>
              value={twoWay ? "both" : direction}
              onChange={(value) => {
                setTwoWay(value === "both");
                if (value !== "both") setDirection(value as SyncDirection);
              }}
              options={[
                { value: "localToRemote", label: "Upload to server" },
                { value: "remoteToLocal", label: "Download from server" },
                { value: "both", label: "Both directions" },
              ]}
              aria-label="Direction"
              className="h-7 w-56 py-0"
            />
          </Row>
          <Row label="Deleted files" note={deletedNote}>
            <Dropdown<string>
              value={strategy}
              onChange={(value) => setStrategy(value as SyncStrategy)}
              options={[
                { value: "additive", label: "Keep extra files" },
                { value: "mirror", label: "Sync deletions" },
              ]}
              aria-label="Deleted files"
              className="h-7 w-56 py-0"
            />
          </Row>

          <Advanced>
            {strategy === "mirror" && (
              <Row
                label="Max deletes per sync"
                help="Limits how many files one sync can move to recovery. An empty source always asks for review first."
                note="0 = no limit"
              >
                <TextInput
                  type="number"
                  min={0}
                  max={100000}
                  value={mirrorDeleteCap}
                  onChange={(e) =>
                    setMirrorDeleteCap(Math.max(0, Math.min(100000, parseInt(e.target.value) || 0)))
                  }
                  aria-label="Max deletes per sync"
                  className="w-[72px] text-right tabular-nums"
                />
              </Row>
            )}

            <Row
              label="Exclude patterns"
              help="One gitignore-style pattern per line (commas work too). Matches are never uploaded or mirror-deleted."
            >
              <textarea
                value={excludeText}
                onChange={(e) => setExcludeText(e.target.value)}
                placeholder={"node_modules\n.git\n*.tmp\n/dist"}
                rows={3}
                spellCheck={false}
                aria-label="Exclude patterns"
                className={cn(inputClass, "h-auto w-full resize-y py-1.5 font-mono text-xs leading-relaxed")}
              />
            </Row>

            <Row label="Check every (seconds)">
              <TextInput
                type="number"
                min={5}
                max={86400}
                value={pollIntervalSecs}
                onChange={(e) =>
                  setPollIntervalSecs(Math.max(5, Math.min(86400, parseInt(e.target.value) || 60)))
                }
                aria-label="Check for changes every (seconds)"
                className="w-[72px] text-right tabular-nums"
              />
            </Row>
          </Advanced>
        </>
      )}

      <Row label="">
        <Btn variant="primary" onClick={submit} busy={busy} disabled={!canSubmit}>
          Start syncing
        </Btn>
      </Row>
    </Group>
  );
}

/** Split the exclude textarea into clean patterns (newline- or comma-separated,
 *  blanks and `#` comments dropped). Mirrors the backend's tolerant parsing. */
function parseExclude(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("#"));
}
