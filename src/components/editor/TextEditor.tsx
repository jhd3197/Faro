// The built-in text editor (Plan 37 Phase 3). Loaded on demand (this file is
// the only one that imports CodeMirror), so it costs nothing until a file is
// opened.
//
// A save goes through `editor_write` with the stamp of the version that was
// read. When the file changed in the meantime the save is refused and the two
// versions are shown side by side, so the choice to overwrite is explicit.

import { useCallback, useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { tags } from "@lezer/highlight";
import { ExternalLink, GitCompare, Loader2, Save, X } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { kindOf, messageOf } from "@/lib/errors";
import { languageFor } from "@/lib/editorLang";
import { baseName, fmtSize } from "@/lib/format";
import { LOCAL_SESSION, type FileStamp, type SessionId } from "@/lib/types";
import { useSettings, setSetting, themeIsDark } from "@/stores/settingsStore";
import { useViewer } from "@/stores/viewerStore";
import { useEditor } from "@/stores/editorStore";
import { Btn, Checkbox } from "../settings/kit";
import { cn } from "@/lib/cn";

// Colours come from the app theme's variables, so the editor follows every
// theme without a table of its own.
const chrome = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: "rgb(var(--text))" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
    lineHeight: "1.5",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "rgb(var(--text-dim))",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "rgb(var(--bg-hover) / 0.45)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "rgb(var(--text))" },
  ".cm-cursor": { borderLeftColor: "rgb(var(--accent))" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "rgb(var(--accent) / 0.28)",
  },
  ".cm-panels": {
    backgroundColor: "rgb(var(--bg-subtle))",
    color: "rgb(var(--text))",
    borderColor: "rgb(var(--border))",
  },
  ".cm-searchMatch": { backgroundColor: "rgb(var(--warning) / 0.35)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgb(var(--accent) / 0.5)" },
  ".cm-textfield, .cm-button": {
    backgroundColor: "rgb(var(--bg-panel))",
    color: "rgb(var(--text))",
    border: "1px solid rgb(var(--border))",
    backgroundImage: "none",
  },
  ".cm-tooltip": {
    backgroundColor: "rgb(var(--bg-panel))",
    border: "1px solid rgb(var(--border))",
    color: "rgb(var(--text))",
  },
});

const syntax = (dark: boolean) =>
  syntaxHighlighting(
    HighlightStyle.define(
      dark
        ? [
            { tag: tags.comment, color: "#7f8896", fontStyle: "italic" },
            { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "#c792ea" },
            { tag: [tags.string, tags.special(tags.string)], color: "#b5d98c" },
            { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#f0986c" },
            { tag: [tags.propertyName, tags.attributeName], color: "#82aaff" },
            { tag: [tags.typeName, tags.className, tags.tagName], color: "#f2c66d" },
            { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#7ec8e3" },
            { tag: [tags.heading, tags.strong], fontWeight: "600" },
            { tag: tags.emphasis, fontStyle: "italic" },
            { tag: tags.link, textDecoration: "underline" },
            { tag: tags.invalid, color: "#f27463" },
          ]
        : [
            { tag: tags.comment, color: "#6b7280", fontStyle: "italic" },
            { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: "#8b2fc9" },
            { tag: [tags.string, tags.special(tags.string)], color: "#2f7d32" },
            { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#b5500c" },
            { tag: [tags.propertyName, tags.attributeName], color: "#1d5fd1" },
            { tag: [tags.typeName, tags.className, tags.tagName], color: "#9a6700" },
            { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#0b7285" },
            { tag: [tags.heading, tags.strong], fontWeight: "600" },
            { tag: tags.emphasis, fontStyle: "italic" },
            { tag: tags.link, textDecoration: "underline" },
            { tag: tags.invalid, color: "#dc2626" },
          ]
    )
  );

type Phase =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready" };

interface Compare {
  /** Why the two versions are shown. */
  reason: "conflict" | "compare";
  theirs: string;
  theirStamp: FileStamp | null;
}

export default function TextEditor({ sessionId, path }: { sessionId: SessionId; path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef<Text | null>(null);
  const stamp = useRef<FileStamp | null>(null);
  const crlf = useRef(false);
  const language = useRef(new Compartment());
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [askClose, setAskClose] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [size, setSize] = useState(0);

  const appTheme = useSettings((s) => s.appTheme);
  const autoSave = useSettings((s) => s.editorAutoSave);
  const dark = themeIsDark(appTheme);
  const lang = languageFor(path);
  const name = baseName(path);

  const currentText = () => {
    const doc = view.current?.state.doc.toString() ?? "";
    return crlf.current ? doc.replace(/\n/g, "\r\n") : doc;
  };

  // ---- Load ----
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "loading" });
    void (async () => {
      try {
        const file = await ipc.editorRead(sessionId, path);
        if (cancelled || !host.current) return;
        stamp.current = file.stamp;
        crlf.current = /\r\n/.test(file.text);
        const doc = file.text.replace(/\r\n/g, "\n");
        const state = EditorState.create({
          doc,
          extensions: [
            basicSetup,
            chrome,
            syntax(dark),
            language.current.of([]),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) {
                setDirty(saved.current ? !u.state.doc.eq(saved.current) : true);
                setSize(u.state.doc.length);
                setNote(null);
              }
              if (u.selectionSet || u.docChanged) {
                const head = u.state.selection.main.head;
                const line = u.state.doc.lineAt(head);
                setCursor({ line: line.number, col: head - line.from + 1 });
              }
            }),
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  void saveRef.current();
                  return true;
                },
              },
            ]),
          ],
        });
        view.current = new EditorView({ state, parent: host.current });
        // Escape belongs to the editor's find panel while it is open; only an
        // Escape with nothing to dismiss reaches the window and asks to close.
        const el = host.current;
        let panelOpen = false;
        el.addEventListener(
          "keydown",
          (e) => {
            if (e.key === "Escape") panelOpen = !!el.querySelector(".cm-panels .cm-search");
          },
          true
        );
        el.addEventListener("keydown", (e) => {
          if (e.key === "Escape" && panelOpen) e.stopPropagation();
        });
        saved.current = state.doc;
        setSize(state.doc.length);
        setDirty(false);
        setPhase({ kind: "ready" });
        view.current.focus();
        // The syntax arrives a moment later; the text is usable meanwhile.
        void lang.load().then((ext) => {
          if (!cancelled) view.current?.dispatch({ effects: language.current.reconfigure(ext) });
        });
      } catch (e) {
        if (!cancelled) setPhase({ kind: "failed", message: messageOf(e) });
      }
    })();
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
    // The viewer remounts this component for another file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, path]);

  // ---- Save ----
  const save = useCallback(
    async (force = false) => {
      const v = view.current;
      if (!v || saving) return;
      setSaving(true);
      setNote(null);
      const doc = v.state.doc;
      try {
        stamp.current = await ipc.editorWrite(sessionId, path, currentText(), stamp.current, force);
        saved.current = doc;
        setDirty(!v.state.doc.eq(doc));
        setCompare(null);
        setNote({ tone: "ok", text: "Saved" });
      } catch (e) {
        if (kindOf(e) === "conflict") {
          // Show both versions rather than guess.
          try {
            const theirs = await ipc.editorRead(sessionId, path);
            setCompare({ reason: "conflict", theirs: theirs.text, theirStamp: theirs.stamp });
          } catch (readErr) {
            setNote({ tone: "error", text: messageOf(readErr) });
          }
        } else {
          setNote({ tone: "error", text: messageOf(e) });
        }
      } finally {
        setSaving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, path, saving]
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  // Auto-save a moment after typing stops. Never while two versions are
  // being compared: that needs a decision first.
  useEffect(() => {
    if (!autoSave || !dirty || compare || saving) return;
    const t = setTimeout(() => void saveRef.current(), 1500);
    return () => clearTimeout(t);
  }, [autoSave, dirty, compare, saving, size, cursor]);

  // ---- Close guard ----
  useEffect(() => {
    useViewer.getState().setBeforeClose(() => {
      if (!dirty) return true;
      setAskClose(true);
      return false;
    });
    return () => useViewer.getState().setBeforeClose(null);
  }, [dirty]);

  const takeTheirs = () => {
    const v = view.current;
    if (!v || !compare) return;
    crlf.current = /\r\n/.test(compare.theirs);
    const doc = compare.theirs.replace(/\r\n/g, "\n");
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc } });
    saved.current = v.state.doc;
    stamp.current = compare.theirStamp;
    setDirty(false);
    setCompare(null);
    setNote({ tone: "ok", text: "Reloaded from the server" });
  };

  const compareWithSaved = async () => {
    try {
      const theirs = await ipc.editorRead(sessionId, path);
      setCompare({ reason: "compare", theirs: theirs.text, theirStamp: theirs.stamp });
    } catch (e) {
      setNote({ tone: "error", text: messageOf(e) });
    }
  };

  const openExternally = () => {
    void useEditor
      .getState()
      .startEditing(sessionId, path)
      .then(() => useViewer.getState().close());
  };

  return (
    <div data-text-editor className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="truncate font-medium" title={path}>
              {name}
            </span>
            {dirty && (
              <span data-editor-dirty title="Unsaved changes" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            )}
            <span className="truncate text-xs text-text-dim">{path}</span>
          </div>
        </div>
        {note && (
          <span
            data-editor-note={note.tone}
            className={cn("max-w-[24rem] truncate text-xs", note.tone === "ok" ? "text-success" : "text-danger")}
            title={note.text}
          >
            {note.text}
          </span>
        )}
        <Checkbox checked={autoSave} onChange={(v) => setSetting("editorAutoSave", v)} label="Auto-save">
          Auto-save
        </Checkbox>
        <Btn
          size="sm"
          variant="ghost"
          icon={<GitCompare size={12} />}
          disabled={phase.kind !== "ready"}
          data-editor-compare
          title="Compare with the saved file"
          onClick={() => void compareWithSaved()}
        >
          Compare
        </Btn>
        {sessionId !== LOCAL_SESSION && (
          <Btn
            size="sm"
            variant="ghost"
            icon={<ExternalLink size={12} />}
            title="Open in your own editor instead"
            disabled={dirty}
            onClick={openExternally}
          >
            External
          </Btn>
        )}
        <Btn
          size="sm"
          variant="primary"
          icon={<Save size={12} />}
          busy={saving}
          disabled={phase.kind !== "ready" || !dirty}
          data-editor-save
          onClick={() => void save()}
        >
          Save
        </Btn>
        <button
          type="button"
          aria-label="Close editor"
          data-editor-close
          onClick={() => useViewer.getState().close()}
          className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text"
        >
          <X size={14} />
        </button>
      </div>

      {askClose && (
        <div data-editor-ask-close className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-subtle px-3 py-1.5 text-sm">
          <span className="min-w-0 flex-1">{name} has unsaved changes.</span>
          <Btn
            size="sm"
            variant="primary"
            data-editor-save-close
            onClick={() =>
              void save().then(() => {
                if (!compare) useViewer.getState().close(true);
              })
            }
          >
            Save and close
          </Btn>
          <Btn size="sm" variant="danger" data-editor-discard onClick={() => useViewer.getState().close(true)}>
            Discard
          </Btn>
          <Btn size="sm" variant="ghost" onClick={() => setAskClose(false)}>
            Keep editing
          </Btn>
        </div>
      )}

      {compare && (
        <CompareBar
          compare={compare}
          onOverwrite={() => void save(true)}
          onTakeTheirs={takeTheirs}
          onClose={() => setCompare(null)}
        />
      )}

      <div className="relative min-h-0 flex-1">
        {phase.kind === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-text-muted">
            <Loader2 size={14} className="animate-spin" /> Opening {name}…
          </div>
        )}
        {phase.kind === "failed" && (
          <div data-editor-failed className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="max-w-md text-sm text-text-muted">{phase.message}</p>
            <div className="flex gap-2">
              {sessionId !== LOCAL_SESSION && (
                <Btn icon={<ExternalLink size={12} />} onClick={openExternally}>
                  Open in my editor
                </Btn>
              )}
              <Btn variant="ghost" onClick={() => useViewer.getState().close(true)}>
                Close
              </Btn>
            </div>
          </div>
        )}
        {/* The editor stays mounted under a comparison so its state survives. */}
        <div ref={host} className={cn("h-full", (phase.kind !== "ready" || compare) && "invisible")} />
        {compare && <MergePane theirs={compare.theirs} mine={currentText()} dark={dark} />}
      </div>

      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-xs text-text-dim">
        <span>
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <span>{lang.label}</span>
        <span>{crlf.current ? "CRLF" : "LF"}</span>
        <span>{fmtSize(size)}</span>
        <span className="flex-1" />
        <span>Ctrl+S saves · Ctrl+F finds</span>
      </div>
    </div>
  );
}

function CompareBar({
  compare,
  onOverwrite,
  onTakeTheirs,
  onClose,
}: {
  compare: Compare;
  onOverwrite: () => void;
  onTakeTheirs: () => void;
  onClose: () => void;
}) {
  const conflict = compare.reason === "conflict";
  return (
    <div
      data-editor-conflict={conflict || undefined}
      data-editor-comparing
      className={cn(
        "flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-sm",
        conflict ? "bg-warning-soft" : "bg-bg-subtle"
      )}
    >
      <span className="min-w-0 flex-1">
        {conflict
          ? "This file changed since you opened it. Left: the file now. Right: your version."
          : "Left: the saved file. Right: your version."}
      </span>
      {conflict && (
        <>
          <Btn size="sm" variant="danger" data-editor-overwrite onClick={onOverwrite}>
            Overwrite with mine
          </Btn>
          <Btn size="sm" data-editor-take-theirs onClick={onTakeTheirs}>
            Discard mine, reload
          </Btn>
        </>
      )}
      <Btn size="sm" variant="ghost" data-editor-compare-close onClick={onClose}>
        {conflict ? "Keep editing" : "Close"}
      </Btn>
    </div>
  );
}

/** Two read-only versions side by side, differences marked. */
function MergePane({ theirs, mine, dark }: { theirs: string; mine: string; dark: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const readOnly = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      chrome,
      syntax(dark),
    ];
    const merge = new MergeView({
      a: { doc: theirs.replace(/\r\n/g, "\n"), extensions: readOnly },
      b: { doc: mine.replace(/\r\n/g, "\n"), extensions: readOnly },
      parent: host.current,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    return () => merge.destroy();
  }, [theirs, mine, dark]);
  return <div ref={host} data-editor-merge className="absolute inset-0 overflow-auto bg-bg-panel" />;
}
