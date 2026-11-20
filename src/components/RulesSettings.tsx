import { useEffect, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Plus, Trash2 } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/cn";
import { useConnections } from "@/stores/connectionsStore";
import { useRules } from "@/stores/rulesStore";
import { toast } from "@/stores/toastStore";
import { Dropdown } from "./ui/Dropdown";
import { Btn, Empty, List, ListRow, Note, Segmented, SubHeading, inputClass } from "./settings/kit";
import { LOCAL_SESSION } from "@/lib/types";
import type { RenameOp, Rule, RuleKind, RuleSample, RuleSet } from "@/lib/types";

const KINDS = ["image", "video", "audio", "document", "archive", "other"];

const TEMPLATE_HINT: Record<RuleKind, string> = {
  rename: "{taken:yyyy-MM-dd}_{name}{ext}",
  sort: "{taken:yyyy}/{taken:MM}",
  view: "Client {tag}",
};

const KIND_HELP: Record<RuleKind, string> = {
  rename: "Gives matching files a new name. The first matching rename rule wins.",
  sort: "Puts matching files in a folder. The first matching sort rule wins.",
  view: "Shows matching files in a folder without moving them (a mount's Views folder, and the Indexed files search).",
};

function newRule(kind: RuleKind): Rule {
  return {
    id: "",
    kind,
    enabled: true,
    when: {},
    template: TEMPLATE_HINT[kind],
    cleanup: kind === "view" ? undefined : { lowercaseExt: true, stripIllegal: true },
  };
}

/// Settings › Rules: rule sets of rename, sort and view rules. Used by Copy
/// to…, mounts (view folders) and "Apply to a folder" below.
export function RulesSettings() {
  const sets = useRules((s) => s.sets);
  const [editing, setEditing] = useState<RuleSet | null>(null);

  useEffect(() => {
    void useRules.getState().load();
  }, []);

  if (editing) return <RuleSetEditor initial={editing} onDone={() => setEditing(null)} />;

  const add = (
    <Btn variant="primary" size="sm" icon={<Plus size={12} />} onClick={() => setEditing({ id: "", name: "New rule set", rules: [newRule("rename")] })}>
      New rule set
    </Btn>
  );

  return (
    <div className="space-y-3" data-rules="">
      {sets.length === 0 ? (
        <Empty action={add}>No rule sets yet.</Empty>
      ) : (
        <>
          <SubHeading
            title="Rule sets"
            help="Pick a rule set in Copy to…, on a mount (view folders), or apply it to a folder in place."
            actions={add}
          />
          <List data-rule-sets="">
            {sets.map((s) => (
              <ListRow
                key={s.id}
                data-rule-set={s.name}
                title={s.name}
                detail={
                  <span>
                    {s.rules.filter((r) => r.enabled).length} of {s.rules.length} rules on ·{" "}
                    {(["rename", "sort", "view"] as const)
                      .map((k) => `${s.rules.filter((r) => r.kind === k).length} ${k}`)
                      .join(", ")}
                  </span>
                }
                actions={
                  <>
                    <Btn size="sm" onClick={() => setEditing(structuredClone(s))}>
                      Edit
                    </Btn>
                    <Btn
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 size={12} />}
                      aria-label={`Delete ${s.name}`}
                      title="Delete rule set"
                      className="w-6 px-0 hover:text-danger"
                      onClick={() => void useRules.getState().remove(s.id)}
                    />
                  </>
                }
              />
            ))}
          </List>
        </>
      )}
    </div>
  );
}

function RuleSetEditor({ initial, onDone }: { initial: RuleSet; onDone: () => void }) {
  const [set, setSet] = useState<RuleSet>(initial);
  const [saving, setSaving] = useState(false);
  const update = (i: number, patch: Partial<Rule>) =>
    setSet((s) => ({ ...s, rules: s.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const move = (i: number, d: -1 | 1) =>
    setSet((s) => {
      const rules = [...s.rules];
      const j = i + d;
      if (j < 0 || j >= rules.length) return s;
      [rules[i], rules[j]] = [rules[j], rules[i]];
      return { ...s, rules };
    });

  const save = async () => {
    setSaving(true);
    try {
      await useRules.getState().save(set);
      toast.success("Rule set saved", set.name);
      onDone();
    } catch (e) {
      toast.error("Couldn't save the rule set", String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 text-[12px]" data-rule-editor="">
      <div className="flex items-center gap-2">
        <input
          aria-label="Rule set name"
          value={set.name}
          onChange={(e) => setSet({ ...set, name: e.target.value })}
          className={cn(inputClass, "flex-1 font-semibold")}
        />
        <Btn size="sm" onClick={onDone}>
          Cancel
        </Btn>
        <Btn size="sm" variant="primary" busy={saving} onClick={() => void save()}>
          Save
        </Btn>
      </div>
      <Note>
        Tokens: <code>{"{name}"}</code> <code>{"{ext}"}</code> <code>{"{taken:yyyy-MM-dd}"}</code>{" "}
        <code>{"{date:yyyy}"}</code> (taken, else modified) <code>{"{camera}"}</code> <code>{"{seq:3}"}</code>{" "}
        <code>{"{parent}"}</code> <code>{"{tag}"}</code> <code>{"{kind}"}</code>. Date and camera come from the file index
        for remote files, or the file itself on this PC.
      </Note>

      {set.rules.map((r, i) => (
        <div key={i} className="space-y-2 rounded border border-border p-2" data-rule={r.kind}>
          <div className="flex items-center gap-2">
            <Segmented<RuleKind>
              value={r.kind}
              onChange={(kind) => update(i, { kind, template: TEMPLATE_HINT[kind] })}
              options={[
                { value: "rename", label: "Rename" },
                { value: "sort", label: "Sort" },
                { value: "view", label: "View" },
              ]}
            />
            <label className="flex items-center gap-1 text-text-muted">
              <input type="checkbox" checked={r.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
              On
            </label>
            <span className="flex-1 text-[11px] text-text-dim">{KIND_HELP[r.kind]}</span>
            <button aria-label="Move up" onClick={() => move(i, -1)} className="text-text-dim hover:text-text">
              <ArrowUp size={12} />
            </button>
            <button aria-label="Move down" onClick={() => move(i, 1)} className="text-text-dim hover:text-text">
              <ArrowDown size={12} />
            </button>
            <button
              aria-label="Remove rule"
              onClick={() => setSet((s) => ({ ...s, rules: s.rules.filter((_, j) => j !== i) }))}
              className="text-text-dim hover:text-danger"
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div className="grid grid-cols-[7rem_1fr] items-center gap-x-2 gap-y-1.5">
            <span className="text-text-muted">{r.kind === "rename" ? "New name" : r.kind === "sort" ? "Folder" : "View folder"}</span>
            <input
              aria-label="Template"
              value={r.template}
              onChange={(e) => update(i, { template: e.target.value })}
              className={cn(inputClass, "font-mono")}
              spellCheck={false}
            />
            <span className="text-text-muted">If missing</span>
            <input
              aria-label="Fallback"
              value={r.fallback ?? ""}
              placeholder={r.kind === "sort" ? "unsorted" : r.kind === "view" ? "other" : "(empty)"}
              onChange={(e) => update(i, { fallback: e.target.value || undefined })}
              className={inputClass}
            />
            <span className="text-text-muted">Kinds</span>
            <div className="flex flex-wrap gap-1">
              {KINDS.map((k) => {
                const on = r.when.kinds?.includes(k) ?? false;
                return (
                  <button
                    key={k}
                    aria-pressed={on}
                    onClick={() =>
                      update(i, {
                        when: { ...r.when, kinds: on ? r.when.kinds?.filter((x) => x !== k) : [...(r.when.kinds ?? []), k] },
                      })
                    }
                    className={cn(
                      "rounded border px-1.5 py-0.5 capitalize",
                      on ? "border-accent text-text" : "border-border text-text-muted hover:text-text"
                    )}
                  >
                    {k}
                  </button>
                );
              })}
            </div>
            <span className="text-text-muted">Name matches</span>
            <input
              aria-label="Name glob"
              value={r.when.nameGlob ?? ""}
              placeholder="any (e.g. IMG_*.jpg, *.png)"
              onChange={(e) => update(i, { when: { ...r.when, nameGlob: e.target.value || undefined } })}
              className={inputClass}
            />
            <span className="text-text-muted">Tag / camera</span>
            <div className="flex gap-1.5">
              <input
                aria-label="Tag"
                value={r.when.tag ?? ""}
                placeholder="tag"
                onChange={(e) => update(i, { when: { ...r.when, tag: e.target.value || undefined } })}
                className={cn(inputClass, "flex-1")}
              />
              <input
                aria-label="Camera"
                value={r.when.camera ?? ""}
                placeholder="camera contains"
                onChange={(e) => update(i, { when: { ...r.when, camera: e.target.value || undefined } })}
                className={cn(inputClass, "flex-1")}
              />
            </div>
            <span className="text-text-muted">Taken</span>
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                aria-label="Taken from"
                value={r.when.takenFrom ?? ""}
                onChange={(e) => update(i, { when: { ...r.when, takenFrom: e.target.value || undefined } })}
                className={inputClass}
              />
              <span className="text-text-dim">to</span>
              <input
                type="date"
                aria-label="Taken to"
                value={r.when.takenTo ?? ""}
                onChange={(e) => update(i, { when: { ...r.when, takenTo: e.target.value || undefined } })}
                className={inputClass}
              />
            </div>
            {r.kind !== "view" && (
              <>
                <span className="text-text-muted">Clean up</span>
                <div className="flex flex-wrap gap-3 text-text-muted">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={r.cleanup?.lowercaseExt ?? false}
                      onChange={(e) => update(i, { cleanup: { ...r.cleanup, lowercaseExt: e.target.checked } })}
                    />
                    Lower-case extension
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={!!r.cleanup?.spacesTo}
                      onChange={(e) => update(i, { cleanup: { ...r.cleanup, spacesTo: e.target.checked ? "_" : undefined } })}
                    />
                    Spaces to _
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={r.cleanup?.stripIllegal ?? false}
                      onChange={(e) => update(i, { cleanup: { ...r.cleanup, stripIllegal: e.target.checked } })}
                    />
                    Remove characters Windows can't use
                  </label>
                </div>
              </>
            )}
          </div>
        </div>
      ))}

      <div className="flex gap-1.5">
        {(["rename", "sort", "view"] as const).map((k) => (
          <Btn key={k} size="sm" icon={<Plus size={12} />} onClick={() => setSet((s) => ({ ...s, rules: [...s.rules, newRule(k)] }))}>
            {k === "rename" ? "Rename rule" : k === "sort" ? "Sort rule" : "View rule"}
          </Btn>
        ))}
      </div>

      <RuleTester set={set} />
    </div>
  );
}

/// Live test + "Apply to this folder": run the (unsaved) set over files in a
/// folder on any open connection or this PC.
function RuleTester({ set }: { set: RuleSet }) {
  const sessions = useConnections((s) => s.sessions);
  const profiles = useConnections((s) => s.profiles);
  const [sessionId, setSessionId] = useState<string>(LOCAL_SESSION);
  const [path, setPath] = useState("");
  const [samples, setSamples] = useState<RuleSample[] | null>(null);
  const [ops, setOps] = useState<RenameOp[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = [
    { value: LOCAL_SESSION, label: "This PC" },
    ...sessions.map((s) => ({ value: s.sessionId, label: profiles.find((p) => p.id === s.profileId)?.name ?? s.sessionId })),
  ];

  const run = async <T,>(f: () => Promise<T>, then: (v: T) => void) => {
    setBusy(true);
    setError(null);
    try {
      then(await f());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-border pt-3" data-rule-tester="">
      <SubHeading title="Try it on a folder" help="Shows what each file would become. Nothing changes until you apply." />
      <div className="flex items-center gap-1.5">
        <Dropdown aria-label="Test on" value={sessionId} options={options} onChange={setSessionId} className="w-44" />
        <input
          aria-label="Folder to test"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={sessionId === LOCAL_SESSION ? "C:\\Users\\me\\Pictures" : "/photos"}
          className={cn(inputClass, "flex-1 font-mono")}
          spellCheck={false}
        />
        <Btn size="sm" disabled={!path || busy} onClick={() => void run(() => ipc.rulesTest(set, sessionId, path), (v) => (setSamples(v), setOps(null)))}>
          Test
        </Btn>
        <Btn
          size="sm"
          disabled={!path || !set.id || busy}
          title={set.id ? "Rename files in this folder now (preview first)" : "Save the rule set first"}
          onClick={() => void run(() => ipc.rulesPlanInPlace(set.id, sessionId, path), (v) => (setOps(v), setSamples(null)))}
        >
          Apply to this folder…
        </Btn>
      </div>
      {error && <Note tone="danger">{error}</Note>}
      {samples && (
        <div className="max-h-64 overflow-auto rounded border border-border bg-bg-subtle px-2 py-1 font-mono text-[11px]" data-rule-samples="">
          {samples.length === 0 && <div className="text-text-dim">No files there.</div>}
          {samples.map((s) => (
            <div key={s.from} className="flex items-center gap-2 leading-5">
              <span className="min-w-0 flex-1 truncate" title={s.from}>
                {s.from}
              </span>
              <ArrowRight size={10} className="shrink-0 text-text-dim" />
              <span className={cn("min-w-0 flex-1 truncate", s.to !== s.from && "text-accent")} title={s.to}>
                {s.to}
              </span>
              {s.views.length > 0 && <span className="shrink-0 text-text-dim">views: {s.views.join(", ")}</span>}
            </div>
          ))}
        </div>
      )}
      {ops && (
        <div className="space-y-1.5" data-rule-apply="">
          <div>{ops.length === 0 ? "Already in order — nothing to rename." : `${ops.length} file${ops.length === 1 ? "" : "s"} will be renamed or moved:`}</div>
          {ops.length > 0 && (
            <>
              <div className="max-h-48 overflow-auto rounded border border-border bg-bg-subtle px-2 py-1 font-mono text-[11px]">
                {ops.slice(0, 500).map((o) => (
                  <div key={o.from} className="flex items-center gap-2 leading-5">
                    <span className="min-w-0 flex-1 truncate">{o.from}</span>
                    <ArrowRight size={10} className="shrink-0 text-text-dim" />
                    <span className="min-w-0 flex-1 truncate text-accent">{o.to}</span>
                  </div>
                ))}
              </div>
              <Btn
                size="sm"
                variant="primary"
                busy={busy}
                onClick={() =>
                  void run(
                    () => ipc.rulesApplyInPlace(set.id, sessionId, path),
                    (r) => {
                      setOps(null);
                      if (r.errors?.length) toast.error(`Renamed ${r.renamed}; ${r.errors.length} failed`, r.errors.slice(0, 3).join("\n"));
                      else toast.success("Renamed", `${r.renamed} file${r.renamed === 1 ? "" : "s"}.`);
                    }
                  )
                }
              >
                Rename {ops.length} file{ops.length === 1 ? "" : "s"}
              </Btn>
            </>
          )}
        </div>
      )}
    </div>
  );
}
