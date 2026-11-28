// Settings › Changed (Plan 37 Phase 1): every setting that differs from its
// default, in one list, each with a live control and a way back.
//
// A row that was just reset stays in the list with an Undo until the view is
// left, so a reset can be taken back without hunting for the old value.

import { useState } from "react";
import { RotateCcw, Undo2 } from "lucide-react";
import {
  SETTINGS_DEFAULTS,
  applySetting,
  useSettings,
  type PersistedSettings,
} from "@/stores/settingsStore";
import {
  SETTINGS_REGISTRY,
  settingValueLabel,
  type SettingEntry,
} from "@/lib/settingsRegistry";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/lib/settingsNav";
import { Dropdown } from "../ui/Dropdown";
import { Btn, Checkbox, Empty } from "./kit";

type Key = keyof PersistedSettings;

export function ChangedSettings({
  isChanged,
  onOpenSection,
}: {
  /** The page's own "differs from default" rule. */
  isChanged: (key: Key, value: unknown) => boolean;
  /** Jump to the page a setting lives on. */
  onOpenSection: (section: SettingsSectionId, label: string) => void;
}) {
  const settings = useSettings();
  // Values that were reset here, by key, so they can be put back.
  const [undo, setUndo] = useState<Record<string, unknown>>({});
  const [confirmAll, setConfirmAll] = useState(false);

  const values = settings as unknown as Record<string, unknown>;
  const defaults = SETTINGS_DEFAULTS as unknown as Record<string, unknown>;
  const rows = SETTINGS_REGISTRY.filter(
    (e) => e.key in defaults && (isChanged(e.key as Key, values[e.key]) || e.key in undo)
  );
  const changedCount = rows.filter((e) => isChanged(e.key as Key, values[e.key])).length;

  const reset = (entry: SettingEntry) => {
    const previous = values[entry.key];
    void applySetting(entry.key as Key, defaults[entry.key] as never);
    setUndo((u) => ({ ...u, [entry.key]: previous }));
  };
  const putBack = (entry: SettingEntry) => {
    void applySetting(entry.key as Key, undo[entry.key] as never);
    setUndo((u) => {
      const { [entry.key]: _gone, ...rest } = u;
      return rest;
    });
  };
  const resetAll = () => {
    const taken: Record<string, unknown> = {};
    for (const e of rows) {
      if (!isChanged(e.key as Key, values[e.key])) continue;
      taken[e.key] = values[e.key];
      void applySetting(e.key as Key, defaults[e.key] as never);
    }
    setUndo((u) => ({ ...u, ...taken }));
    setConfirmAll(false);
  };

  if (rows.length === 0) {
    return (
      <div data-changed-settings>
        <Empty>Every setting is at its default.</Empty>
      </div>
    );
  }

  const sectionLabel = (id: SettingsSectionId) =>
    SETTINGS_SECTIONS.find((s) => s.id === id)?.label ?? id;

  return (
    <div data-changed-settings className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-text-muted">
          {changedCount === 0
            ? "Everything here was reset. Undo puts a value back."
            : `${changedCount} ${changedCount === 1 ? "setting differs" : "settings differ"} from the default.`}
        </p>
        {changedCount > 0 &&
          (confirmAll ? (
            <>
              <span className="text-xs text-text-muted">Reset all {changedCount}?</span>
              <Btn size="sm" variant="danger" data-changed-reset-all-confirm onClick={resetAll}>
                Reset
              </Btn>
              <Btn size="sm" variant="ghost" onClick={() => setConfirmAll(false)}>
                Cancel
              </Btn>
            </>
          ) : (
            <Btn size="sm" data-changed-reset-all onClick={() => setConfirmAll(true)}>
              Reset all
            </Btn>
          ))}
      </div>
      <ul className="divide-y divide-border rounded border border-border">
        {rows.map((entry) => {
          const value = values[entry.key];
          const wasReset = entry.key in undo && !isChanged(entry.key as Key, value);
          return (
            <li
              key={entry.key}
              data-changed-row={entry.key}
              className="flex min-h-10 items-center gap-3 px-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-text">{entry.label}</div>
                <button
                  type="button"
                  onClick={() => onOpenSection(entry.section, entry.label)}
                  className="text-xs text-text-dim hover:text-text hover:underline"
                >
                  {sectionLabel(entry.section)}
                </button>
              </div>
              {wasReset ? (
                <>
                  <span className="text-xs text-text-dim">Reset to default</span>
                  <Btn
                    size="sm"
                    icon={<Undo2 size={12} />}
                    data-changed-undo={entry.key}
                    onClick={() => putBack(entry)}
                  >
                    Undo
                  </Btn>
                </>
              ) : (
                <>
                  <Control entry={entry} value={value} />
                  <Btn
                    size="sm"
                    variant="ghost"
                    icon={<RotateCcw size={12} />}
                    title={`Reset to ${settingValueLabel(entry, defaults[entry.key])}`}
                    aria-label={`Reset ${entry.label}`}
                    data-changed-reset={entry.key}
                    onClick={() => reset(entry)}
                  />
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A live control for the simple kinds; a reading of the value for the rest. */
function Control({ entry, value }: { entry: SettingEntry; value: unknown }) {
  if (entry.kind === "toggle") {
    return (
      <Checkbox
        checked={!!value}
        onChange={(v) => void applySetting(entry.key as Key, v as never)}
        label={entry.label}
      />
    );
  }
  if (entry.kind === "choice" && entry.options) {
    return (
      <Dropdown<string>
        value={String(value)}
        onChange={(v) => {
          const picked = entry.options?.find((o) => String(o.value) === v);
          if (picked) void applySetting(entry.key as Key, picked.value as never);
        }}
        aria-label={entry.label}
        className="h-7 w-44 py-0"
        options={entry.options.map((o) => ({ value: String(o.value), label: o.label }))}
      />
    );
  }
  return (
    <span className="max-w-[16rem] truncate text-sm text-text-muted" title={String(value)}>
      {settingValueLabel(entry, value)}
    </span>
  );
}
