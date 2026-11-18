import { useEffect, useMemo, useRef, useState } from "react";
import { Search, RotateCcw, Circle, X } from "lucide-react";
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
      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border-subtle px-3 py-2.5">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setRec(null);
          }}
          className="mt-0.5 accent-[rgb(var(--accent))]"
          aria-describedby="kb-enabled-note"
        />
        <span>
          <span className="block text-sm text-text">Enable keyboard shortcuts</span>
          <span id="kb-enabled-note" className="block text-[11px] text-text-dim">
            Off: no shortcut does anything and menus show no keys. Your
            changes below are kept.
          </span>
        </span>
      </label>

      <div className={cn("space-y-3", !enabled && "pointer-events-none opacity-50")} aria-disabled={!enabled}>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim"
          />
          <input
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
            className="w-full rounded-md border border-border bg-bg-subtle py-1.5 pl-8 pr-2.5 text-sm outline-none focus:border-accent"
          />
        </div>
        <button
          onClick={resetAll}
          disabled={overrideCount === 0}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-40"
          title="Reset every shortcut to its default"
        >
          <RotateCcw size={12} /> Reset all
          {overrideCount > 0 ? ` (${overrideCount})` : ""}
        </button>
      </div>

      {conflict && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <div className="flex-1">
            <span className="font-mono font-medium">
              {formatCombo(conflict.combo)}
            </span>{" "}
            is already bound to{" "}
            <span className="font-medium">{conflict.otherTitle}</span>. Reassign
            it here and unbind the other?
          </div>
          <button
            onClick={resolveConflict}
            className="btn-accent shrink-0 rounded px-2 py-1 text-[11px] font-medium text-white"
          >
            Reassign
          </button>
          <button
            onClick={() => setConflict(null)}
            className="shrink-0 rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {groupOrder.length === 0 ? (
        <div className="py-8 text-center text-xs text-text-dim">
          No shortcuts match “{q.trim()}”.
        </div>
      ) : (
        groupOrder.map((group) => (
          <div key={group}>
            <div className="mb-1.5 mt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
              {group}
            </div>
            <div className="overflow-hidden rounded-md border border-border-subtle">
              {byGroup.get(group)!.map((e, i) => {
                const eff = effectiveCombo(e.id, e.defaultCombo, overrides);
                const overridden = e.id in overrides;
                const recording = rec?.id === e.id ? rec : null;
                return (
                  <div
                    key={e.id}
                    data-keybinding-row={e.id}
                    data-flash={flashId === e.id ? "" : undefined}
                    className={cn(
                      "px-3 py-1.5 text-sm transition-colors duration-300",
                      i > 0 && "border-t border-border-subtle",
                      flashId === e.id && "bg-success/15"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-text-muted">
                        {e.title}
                      </span>
                      {overridden && (
                        <button
                          onClick={() => {
                            clearOverride(e.id);
                            flash(e.id);
                          }}
                          title="Reset to default"
                          className="rounded p-1 text-text-dim hover:bg-bg-hover hover:text-text"
                        >
                          <RotateCcw size={12} />
                        </button>
                      )}
                      <button
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
                          "min-w-[8rem] rounded border px-2 py-1 text-center font-mono text-[11px] transition-colors",
                          recording
                            ? recording.error
                              ? "border-danger bg-danger/10 text-danger"
                              : "border-accent bg-accent/10 text-accent"
                            : "border-border bg-bg-subtle text-text-dim hover:border-accent/50 hover:text-text"
                        )}
                        title="Click, then press the key combination"
                      >
                        {recording ? (
                          recording.draft ? (
                            labelFor(recording.draft)
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              <Circle size={7} className="animate-pulse fill-current" />
                              Press keys…
                            </span>
                          )
                        ) : eff ? (
                          formatCombo(eff)
                        ) : (
                          <span className="italic text-text-dim/70">Unbound</span>
                        )}
                      </button>
                    </div>
                    {recording?.error && (
                      <p role="alert" className="mt-1 text-right text-[11px] text-danger">
                        {recording.error}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}

      <p className="pt-1 text-[11px] leading-relaxed text-text-dim">
        Click a shortcut, then press the keys; it saves when you let go.{" "}
        <kbd>Esc</kbd> cancels, <kbd>Backspace</kbd> resets to default.
        Shortcuts need a modifier, except F1–F12 and the keys file lists
        already use on their own. File-browser and list keys apply to the
        focused pane or row; they never fire while you're typing.
      </p>
      </div>
    </div>
  );
}
