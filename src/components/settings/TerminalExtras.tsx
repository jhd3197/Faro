// Settings › Terminal rows added by Plan 36: cursor and line height, paste and
// clipboard behaviour, and the keyword highlight rules.

import { Plus, Trash2 } from "lucide-react";
import { useSettings, setSetting } from "@/stores/settingsStore";
import {
  DEFAULT_HIGHLIGHT_RULES,
  HIGHLIGHT_COLORS,
  compileRules,
  highlightHex,
  type HighlightColor,
  type HighlightRule,
} from "@/lib/terminalHighlight";
import { Dropdown } from "../ui/Dropdown";
import { Btn, CheckRow, Checkbox, Note, Row, Segmented, TextInput } from "./kit";

type CursorStyle = "block" | "bar" | "underline";

export function TerminalExtras() {
  const cursorStyle = useSettings((s) => s.terminalCursorStyle);
  const cursorBlink = useSettings((s) => s.terminalCursorBlink);
  const lineHeight = useSettings((s) => s.terminalLineHeight);
  const plainPaste = useSettings((s) => s.terminalPlainPaste);
  const osc52 = useSettings((s) => s.terminalOsc52);
  const highlight = useSettings((s) => s.terminalHighlight);

  return (
    <>
      <Row label="Cursor" keywords="caret block bar underline blink" help="Applies live to open terminals.">
        <Segmented<CursorStyle>
          label="Cursor style"
          value={cursorStyle}
          onChange={(v) => setSetting("terminalCursorStyle", v)}
          options={[
            { value: "block", label: "Block" },
            { value: "bar", label: "Bar" },
            { value: "underline", label: "Underline" },
          ]}
        />
        <Checkbox checked={cursorBlink} onChange={(v) => setSetting("terminalCursorBlink", v)}>
          Blink
        </Checkbox>
      </Row>
      <Row label="Line height" keywords="spacing leading rows">
        <Dropdown<number>
          value={lineHeight}
          onChange={(v) => setSetting("terminalLineHeight", v)}
          aria-label="Line height"
          className="h-7 w-52 py-0"
          options={[
            { value: 1, label: "Tight (1.0)" },
            { value: 1.1, label: "1.1" },
            { value: 1.2, label: "Comfortable (1.2)" },
            { value: 1.4, label: "Relaxed (1.4)" },
            { value: 1.6, label: "Loose (1.6)" },
          ]}
        />
      </Row>
      <CheckRow
        label="Plain paste"
        keywords="bracketed paste markers raw"
        help="Pastes text exactly as typed, without the bracketed-paste markers. Turn it on for programs that show stray characters around pasted text."
        checked={plainPaste}
        onChange={(v) => setSetting("terminalPlainPaste", v)}
      />
      <CheckRow
        label="Let the server set the clipboard"
        keywords="osc 52 copy remote clipboard tmux vim"
        help="Programs on the server (tmux, vim) can copy to this computer's clipboard. They can never read it."
        checked={osc52}
        onChange={(v) => setSetting("terminalOsc52", v)}
      />
      <CheckRow
        label="Highlight keywords"
        keywords="color colour error warning ok success highlight rules regex"
        help="Colours words such as error, warning and ok in command output. Full-screen programs are left alone."
        checked={highlight}
        onChange={(v) => setSetting("terminalHighlight", v)}
      />
      {highlight && <HighlightRules />}
    </>
  );
}

function HighlightRules() {
  const rules = useSettings((s) => s.terminalHighlightRules);
  const themeKey = useSettings((s) => s.terminalTheme);
  const dark = themeKey !== "light";
  const { errors } = compileRules(rules);
  const update = (next: HighlightRule[]) => setSetting("terminalHighlightRules", next);
  const patch = (id: string, change: Partial<HighlightRule>) =>
    update(rules.map((r) => (r.id === id ? { ...r, ...change } : r)));
  const isDefault = JSON.stringify(rules) === JSON.stringify(DEFAULT_HIGHLIGHT_RULES);

  return (
    <Row
      label="Highlight rules"
      indent
      keywords="pattern regex regular expression word color colour"
      help="Each rule is a word or a regular expression, matched without regard to case. Earlier rules win where two overlap."
    >
      <div className="flex w-full flex-col gap-1.5" data-highlight-rules>
        {rules.map((rule) => (
          <div key={rule.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <Checkbox
                checked={rule.enabled}
                onChange={(v) => patch(rule.id, { enabled: v })}
                label={`Enable rule ${rule.pattern}`}
              />
              <TextInput
                value={rule.pattern}
                onChange={(e) => patch(rule.id, { pattern: e.target.value })}
                aria-label="Pattern"
                aria-invalid={!!errors[rule.id]}
                spellCheck={false}
                className="min-w-0 flex-1 font-mono text-xs"
                style={{ color: highlightHex(rule.color, dark) }}
              />
              <Dropdown<HighlightColor>
                value={rule.color}
                onChange={(v) => patch(rule.id, { color: v })}
                aria-label="Colour"
                className="h-7 w-28 py-0"
                options={HIGHLIGHT_COLORS.map((c) => ({
                  value: c,
                  label: c[0].toUpperCase() + c.slice(1),
                }))}
              />
              <Btn
                size="sm"
                variant="ghost"
                aria-label={`Delete rule ${rule.pattern}`}
                title="Delete rule"
                icon={<Trash2 size={12} />}
                onClick={() => update(rules.filter((r) => r.id !== rule.id))}
              />
            </div>
            {errors[rule.id] && <Note tone="danger">{errors[rule.id]}</Note>}
          </div>
        ))}
        <div className="flex gap-1.5">
          <Btn
            size="sm"
            icon={<Plus size={12} />}
            onClick={() =>
              update([
                ...rules,
                { id: crypto.randomUUID(), pattern: "", color: "cyan", enabled: true },
              ])
            }
          >
            Add rule
          </Btn>
          {!isDefault && (
            <Btn size="sm" variant="ghost" onClick={() => update(DEFAULT_HIGHLIGHT_RULES)}>
              Restore defaults
            </Btn>
          )}
        </div>
      </div>
    </Row>
  );
}
