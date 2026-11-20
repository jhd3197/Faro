import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Copy, Loader2 } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { fmtSize } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useConnections } from "@/stores/connectionsStore";
import { useCopyJobs } from "@/stores/copyStore";
import { useRules } from "@/stores/rulesStore";
import { toast } from "@/stores/toastStore";
import { Dialog } from "@/components/ui/Dialog";
import { Dropdown } from "@/components/ui/Dropdown";
import type { CopyOverwrite, CopyPlan, CopySourceRef } from "@/lib/types";

const OVERWRITE: Array<{ value: CopyOverwrite; label: string }> = [
  { value: "skip", label: "Skip" },
  { value: "newer", label: "If newer" },
  { value: "always", label: "Replace" },
];

/** Rows shown in the preview; the run still covers every file. */
const LIST_CAP = 500;

const ACTION_LABEL = { copy: "Copy", overwrite: "Replace", skip: "Skip" } as const;

/// Copy to…: pick a connection and folder, preview the plan, then run it in
/// the background (progress in the status-bar pill and the transfer queue).
export function CopyToDialog() {
  const request = useCopyJobs((s) => s.request);
  const close = useCopyJobs((s) => s.closeCopyTo);
  const profiles = useConnections((s) => s.profiles);
  const ruleSets = useRules((s) => s.sets);

  const [destProfileId, setDestProfileId] = useState<string>("");
  const [destDir, setDestDir] = useState("/");
  const [overwrite, setOverwrite] = useState<CopyOverwrite>("skip");
  const [verify, setVerify] = useState(true);
  const [ruleSet, setRuleSet] = useState<string>("");
  const [plan, setPlan] = useState<CopyPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sources: CopySourceRef[] = useMemo(
    () => (request?.entries ?? []).map((e) => ({ path: e.path, isDir: e.kind === "directory" })),
    [request]
  );

  // A changed choice, or opening the dialog for new items, makes the
  // preview stale. The destination choices are kept for the next copy.
  useEffect(() => {
    setPlan(null);
    setError(null);
  }, [request, destProfileId, destDir, overwrite, ruleSet]);

  if (!request) return null;

  const dest = profiles.find((p) => p.id === destProfileId);
  const options = { overwrite, verify, ruleSet: ruleSet || null };
  const what =
    request.entries.length === 1 ? `“${request.entries[0].name}”` : `${request.entries.length} items`;

  const preview = async () => {
    if (!destProfileId) return;
    setPlanning(true);
    setError(null);
    try {
      setPlan(await ipc.copyToPlan(request.sessionId, sources, destProfileId, destDir.trim() || "/", options));
    } catch (e) {
      setError(String(e));
    } finally {
      setPlanning(false);
    }
  };

  const start = async () => {
    if (!plan) {
      await preview();
      return false;
    }
    try {
      await ipc.copyToStart(request.sessionId, sources, destProfileId, destDir.trim() || "/", options);
      toast.info("Copy started", `${plan.filesToCopy} file${plan.filesToCopy === 1 ? "" : "s"} to ${dest?.name ?? "the connection"}.`);
      close();
    } catch (e) {
      setError(String(e));
      return false;
    }
  };

  return (
    <Dialog
      title={`Copy ${what} to…`}
      icon={<Copy size={14} />}
      size="lg"
      onClose={close}
      onConfirm={start}
      confirmLabel={plan ? (plan.filesToCopy ? `Copy ${plan.filesToCopy} file${plan.filesToCopy === 1 ? "" : "s"}` : "Nothing to copy") : "Preview"}
      confirmDisabled={!destProfileId || planning || (!!plan && plan.filesToCopy === 0)}
      data-testid="copy-to-dialog"
    >
      <div className="flex flex-col gap-3 text-[12px]">
        <div className="grid grid-cols-[7rem_1fr] items-center gap-x-3 gap-y-2">
          <label className="text-text-muted">Connection</label>
          <Dropdown
            aria-label="Destination connection"
            value={destProfileId}
            searchable
            placeholder="Choose a connection…"
            options={profiles.map((p) => ({ value: p.id, label: p.name, hint: p.protocol }))}
            onChange={(id) => {
              setDestProfileId(id);
              const p = profiles.find((x) => x.id === id);
              setDestDir(p?.defaultRemotePath || "/");
            }}
          />
          <label className="text-text-muted" htmlFor="copy-to-folder">
            Folder
          </label>
          <input
            id="copy-to-folder"
            value={destDir}
            onChange={(e) => setDestDir(e.target.value)}
            className="rounded border border-border bg-bg-panel px-2 py-1 font-mono text-[12px]"
            spellCheck={false}
          />
          <span className="text-text-muted">If a file exists</span>
          <div role="radiogroup" aria-label="If a file exists" className="flex gap-1">
            {OVERWRITE.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={overwrite === o.value}
                onClick={() => setOverwrite(o.value)}
                className={cn(
                  "rounded px-2 py-0.5",
                  overwrite === o.value ? "bg-bg-hover text-text" : "text-text-muted hover:text-text"
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          {ruleSets.length > 0 && (
            <>
              <span className="text-text-muted">Rules</span>
              <Dropdown
                aria-label="Rename with rules"
                value={ruleSet}
                options={[{ value: "", label: "None" }, ...ruleSets.map((r) => ({ value: r.id, label: r.name }))]}
                onChange={setRuleSet}
              />
            </>
          )}
          <span />
          <label className="flex items-center gap-2 text-text-muted">
            <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
            Check each file's size after it lands
          </label>
        </div>

        {error && <div className="rounded border border-danger/40 px-2 py-1.5 text-danger">{error}</div>}

        {planning && (
          <div className="flex items-center gap-2 text-text-muted">
            <Loader2 size={12} className="animate-spin" /> Scanning both sides…
          </div>
        )}

        {plan && (
          <div className="flex flex-col gap-1.5" data-testid="copy-plan">
            <div className="text-text">
              {plan.filesToCopy} to copy ({fmtSize(plan.bytesToCopy)}) · {plan.skipped} already there
              {plan.renamed > 0 && ` · ${plan.renamed} renamed`}
              {plan.collisions > 0 && ` · ${plan.collisions} name clashes numbered`}
            </div>
            <div className="max-h-64 overflow-auto rounded border border-border bg-bg-subtle px-2 py-1">
              {plan.items.slice(0, LIST_CAP).map((it) => (
                <div key={it.dest} className="flex items-center gap-2 font-mono text-[11px] leading-5">
                  <span className={cn("w-14 shrink-0", it.action === "skip" ? "text-text-dim" : "text-text-muted")}>
                    {ACTION_LABEL[it.action]}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={it.source}>
                    {it.source}
                  </span>
                  <ArrowRight size={10} className="shrink-0 text-text-dim" />
                  <span className={cn("min-w-0 flex-1 truncate", it.renamed && "text-accent")} title={it.dest}>
                    {it.dest}
                  </span>
                </div>
              ))}
              {plan.items.length > LIST_CAP && (
                <div className="py-1 text-text-dim">and {plan.items.length - LIST_CAP} more</div>
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
