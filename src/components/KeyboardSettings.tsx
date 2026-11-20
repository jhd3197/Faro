import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useCommands } from "@/lib/commands";
import { useBindings } from "@/stores/bindingsStore";
import { effectiveCombo } from "@/lib/keybindings";
import { FILE_BROWSER_KEYS, FILE_BROWSER_GROUP } from "@/lib/fileBrowserKeys";
import { SCOPED_KEYS, FOCUS_GROUP } from "@/lib/bindingCatalog";
import { keyCombo, formatCombo, isMac } from "@/lib/shortcuts";
import {
  LOCK_KEYS,
  MODIFIER_KEYS,
  modifierDraft,
  validateCombo,
} from "@/lib/comboRules";
import { SETTINGS_FOCUS } from "@/lib/settingsNav";
import { cn } from "@/lib/cn";
import { Btn, Checkbox, Empty, InfoTip, List, TextInput } from "./settings/kit";

// Settings → Keyboard (Plan 15 Phase 2). A searchable, grouped list of every
// remappable binding — the app commands that carry a default combo, the
// focused-item keys and the file-browser action catalog — each with a
// click-to-record capture field, conflict detection, per-row reset, and reset
// all. Overrides live in the shared bindings store (persisted as `shortcut.*`
// rows in faro.db), next to the master on/off switch.

interface KeyEntry {
  id: string;
  title: string;
  group: string;
  defaultCombo: string;
  /** Conflict scope: command shortcuts (global + terminal, they share the
   *  window) never collide with pane-local file-browser keys or with keys that
   *  only act on a focused row. */
  scope: "cmd" | "fb" | "focus";
}

interface Recording {
  id: string;
  /** What has been pressed so far (may be modifiers only, "mod+shift+"). */
  draft: string;
  /** Why the draft can't be saved; it stays visible until the next press. */
  error: string | null;
  /** The draft is valid and waits for the first key release to be saved. */
  ready: boolean;
}

/** A draft may be modifiers only ("mod+shift+"): show it as "Ctrl+Shift+…". */
const labelFor = (c: string) => formatCombo(c.endsWith("+") ? c + "…" : c);

export function KeyboardSettings() {
  const commands = useCommands();
  const overrides = useBindings((s) => s.overrides);
  const setOverride = useBindings((s) => s.setOverride);
  const clearOverride = useBindings((s) => s.clearOverride);
  const resetAll = useBindings((s) => s.resetAll);
  const enabled = useBindings((s) => s.enabled);
  const setEnabled = useBindings((s) => s.setEnabled);

  const [q, setQ] = useState("");
  const [rec, setRec] = useState<Recording | null>(null);
  const recRef = useRef(rec);
  recRef.current = rec;
  // The row that was just rebound flashes briefly so the change is visible.
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const [conflict, setConflict] = useState<{
    targetId: string;
    combo: string;
    otherTitle: string;
    otherId: string;
  } | null>(null);

  const entries = useMemo<KeyEntry[]>(() => {
    const list: KeyEntry[] = [];
    const seen = new Set<string>();
    for (const c of commands) {
      if (!c.combo && !c.bindable && !(c.id in overrides)) continue;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      list.push({
        id: c.id,
        title: c.title,
        group: c.group,
        defaultCombo: c.combo ?? "",
        scope: "cmd",
      });
    }
    for (const k of SCOPED_KEYS) {
      list.push({
        id: k.id,
        title: k.title,
        group: k.scope === "cmd" ? "General" : FOCUS_GROUP,
        defaultCombo: k.defaultCombo,
        scope: k.scope,
      });
    }
    for (const k of FILE_BROWSER_KEYS) {
      list.push({
        id: k.id,
        title: k.title,
        group: FILE_BROWSER_GROUP,
        defaultCombo: k.defaultCombo,
        scope: "fb",
      });
    }
    return list;
  }, [commands, overrides]);

  const flash = (id: string) => {
    setFlashId(id);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(null), 800);
  };
  useEffect(() => () => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
  }, []);

  const apply = (target: KeyEntry, combo: string) => {
    // Recording the built-in back = a reset, so we don't store a redundant row.
    if (combo === target.defaultCombo) clearOverride(target.id);
    else setOverride(target.id, combo);
    flash(target.id);
  };

  /** Save a valid recorded combo, or raise the conflict prompt. */
  const commit = (target: KeyEntry, combo: string) => {
    setRec(null);
    const cur = useBindings.getState().overrides;
    if (effectiveCombo(target.id, target.defaultCombo, cur) === combo) return;
    const other = entries.find(
      (x) =>
        x.id !== target.id &&
        x.scope === target.scope &&
        effectiveCombo(x.id, x.defaultCombo, cur) === combo
    );
    if (other) {
      setConflict({ targetId: target.id, combo, otherTitle: other.title, otherId: other.id });
      return;
    }
    apply(target, combo);
  };

  // Capture keys while a row is recording. A window capture-phase listener +
  // stopPropagation keeps them from leaking to the global dispatcher or the
  // dialog's own Escape-to-close. A valid combo is saved on the first key
  // release; an invalid one stays on screen with the reason until the next
  // press (or until the field loses focus, which drops it).
  const recordingId = rec?.id ?? null;
  useEffect(() => {
    if (!recordingId) return;
    const target = entries.find((e) => e.id === recordingId);
    const onDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || LOCK_KEYS.has(e.key)) return;
      const bare = !(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey);
      if (e.key === "Escape" && bare) {
        setRec(null);
        return;
      }
      if (e.key === "Backspace" && bare && target?.defaultCombo !== "backspace") {
        // Clear → restore the default binding.
        clearOverride(recordingId);
        setRec(null);
        flash(recordingId);
        return;
      }
      if (!target) {
        setRec(null);
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) {
        const draft = modifierDraft(e);
        setRec({ id: recordingId, draft, error: null, ready: false });
        return;
      }
      const combo = keyCombo(e);
      const problem = validateCombo(combo, {
        mac: isMac,
        windowsKey: !isMac && e.metaKey,
        label: formatCombo,
      });
      setRec({ id: recordingId, draft: combo, error: problem?.message ?? null, ready: !problem });
    };
    const onUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const r = recRef.current;
      if (!r || !target) return;
      if (r.ready) {
        commit(target, r.draft);
        return;
      }
      // Let go of every modifier without adding a key: say what's missing.
      if (r.draft.endsWith("+") && !(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)) {
        const problem = validateCombo(r.draft, { mac: isMac, label: formatCombo });
        setRec({ ...r, error: problem?.message ?? null });
      }
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId, entries]);

  const resolveConflict = () => {
    if (!conflict) return;
    const target = entries.find((e) => e.id === conflict.targetId);
    if (target) apply(target, conflict.combo);
    // Unbind the previous holder so one combo never drives two actions.
    setOverride(conflict.otherId, "");
    setConflict(null);
  };

  const query = q.trim().toLowerCase();
  const filtered = entries.filter(
    (e) =>
      query === "" ||
      e.title.toLowerCase().includes(query) ||
      e.group.toLowerCase().includes(query)
  );
  // Preserve the natural group order (registry order, then the catalogues).
  const groupOrder: string[] = [];
  const byGroup = new Map<string, KeyEntry[]>();
  for (const e of filtered) {
    if (!byGroup.has(e.group)) {
      byGroup.set(e.group, []);
      groupOrder.push(e.group);
    }
    byGroup.get(e.group)!.push(e);
  }

  const overrideCount = Object.keys(overrides).length;

  return (
    <div className="space-y-3">
      <div className="flex min-h-7 items-center gap-1.5">
        <Checkbox
          checked={enabled}
          onChange={(v) => {
            setEnabled(v);
            setRec(null);
          }}
          label="Use keyboard shortcuts"
        >
          Use keyboard shortcuts
        </Checkbox>
        <InfoTip text="Off: no shortcut does anything and menus show no keys. Your changes below are kept." />
      </div>

      <div className={cn("space-y-3", !enabled && "pointer-events-none opacity-50")} aria-disabled={!enabled}>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim"
            />
            <TextInput
              data-settings-focus={SETTINGS_FOCUS.keyboardSearch}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                // First Esc clears the search; the next one closes Settings.
                if (e.key === "Escape" && q) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQ("");
                }
              }}
              placeholder="Search shortcuts…"
              aria-label="Search shortcuts"
              className="w-full pl-8"
            />
          </div>
          <InfoTip
            label="How to record a shortcut"
            text={
              <>
                Click a shortcut, then press the keys; it saves when you let go. <kbd>Esc</kbd> cancels,{" "}
                <kbd>Backspace</kbd> resets to default. Shortcuts need a modifier, except F1–F12 and the keys
                file lists already use on their own. File-browser and list keys apply to the focused pane or
                row; they never fire while you're typing.
              </>
            }
          />
          <Btn onClick={resetAll} disabled={overrideCount === 0} title="Reset every shortcut to its default">
            Reset all{overrideCount > 0 ? ` (${overrideCount})` : ""}
          </Btn>
        </div>

        {conflict && (
          <div className="flex min-h-7 items-center gap-2 text-sm text-text-muted">
            <span className="min-w-0 flex-1">
              <Keys label={formatCombo(conflict.combo)} /> is bound to{" "}
              <span className="text-text">{conflict.otherTitle}</span>. Reassign it here?
            </span>
            <Btn variant="primary" size="sm" onClick={resolveConflict}>
              Reassign
            </Btn>
            <Btn variant="ghost" size="sm" onClick={() => setConflict(null)}>
              Cancel
            </Btn>
          </div>
        )}

        {groupOrder.length === 0 ? (
          <Empty>No shortcuts match “{q.trim()}”.</Empty>
        ) : (
          groupOrder.map((group) => (
            <div key={group}>
              <h3 className="mb-1 text-xs font-semibold text-text">{group}</h3>
              <List>
                {byGroup.get(group)!.map((e) => {
                  const eff = effectiveCombo(e.id, e.defaultCombo, overrides);
                  const overridden = e.id in overrides;
                  const recording = rec?.id === e.id ? rec : null;
                  return (
                    <div
                      key={e.id}
                      data-keybinding-row={e.id}
                      data-flash={flashId === e.id ? "" : undefined}
                      className={cn(
                        "px-3 py-1 transition-colors duration-300",
                        flashId === e.id && "bg-success/15"
                      )}
                    >
                      <div className="flex min-h-7 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-text-muted">{e.title}</span>
                        {overridden && (
                          <Btn
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              clearOverride(e.id);
                              flash(e.id);
                            }}
                            title="Reset to default"
                          >
                            Reset
                          </Btn>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setRec(recording ? null : { id: e.id, draft: "", error: null, ready: false })
                          }
                          // Leaving the field drops an unsaved (or invalid) draft.
                          onBlur={() => {
                            if (recRef.current?.id === e.id) setRec(null);
                          }}
                          aria-label={`Shortcut for ${e.title}`}
                          aria-invalid={!!recording?.error}
                          className={cn(
                            "flex h-7 min-w-[8rem] items-center justify-end gap-1 rounded border px-1.5 outline-none transition-colors",
                            recording
                              ? recording.error
                                ? "border-danger bg-bg-hover"
                                : "border-border bg-bg-hover"
                              : "border-transparent hover:bg-bg-hover"
                          )}
                          title="Click, then press the key combination"
                        >
                          {recording ? (
                            recording.draft ? (
                              <Keys label={labelFor(recording.draft)} tone={recording.error ? "danger" : "active"} />
                            ) : (
                              <span className="text-xs text-text">Press keys…</span>
                            )
                          ) : eff ? (
                            <Keys label={formatCombo(eff)} />
                          ) : (
                            <span className="text-xs text-text-dim">Unbound</span>
                          )}
                        </button>
                      </div>
                      {recording?.error && (
                        <p role="alert" className="pb-1 text-right text-xs text-danger">
                          {recording.error}
                        </p>
                      )}
                    </div>
                  );
                })}
              </List>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** A combo label as key chips. The "+" between keys stays in the text (for
 *  copy and screen readers) but is hidden; a literal "+" key keeps its chip. */
function Keys({ label, tone = "default" }: { label: string; tone?: "default" | "active" | "danger" }) {
  const parts = label.split(/\+(?=.)/);
  return (
    <span className="inline-flex items-center gap-1">
      {parts.map((k, i) => (
        <span key={i} className="contents">
          {i > 0 && <span className="sr-only">+</span>}
          <kbd
            className={cn(
              "inline-flex h-5 min-w-5 items-center justify-center rounded border px-1.5 font-mono text-xs",
              tone === "default" && "border-border bg-bg-subtle text-text-muted",
              tone === "active" && "border-border bg-bg-subtle text-text",
              tone === "danger" && "border-danger/50 bg-bg-subtle text-danger"
            )}
          >
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}
