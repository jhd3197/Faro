import { useEffect, useState } from "react";
import { Loader2, PackageX, Trash2 } from "lucide-react";
import { ConfirmModal } from "@faro/file-ui";
import { ipc } from "@/lib/ipc";
import { useDocker, type DockerSection } from "@/stores/dockerStore";
import { toast } from "@/stores/toastStore";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/cn";
import type { DockerAccess, DockerPruneKind, Elevate } from "@/lib/types";
import {
  AskSudoButton,
  Notice,
  RefreshButton,
  SudoPasswordModal,
  runInTerminal,
  useRoot,
} from "../server/shared";
import { ContainersSection } from "./ContainersSection";
import { ImagesSection, NetworksSection, VolumesSection } from "./ResourceSections";

// Docker manager (Plan 31): a tab of the Server view. Everything is the
// `docker` CLI over the connection's SSH session.

const SECTIONS: [DockerSection, string][] = [
  ["containers", "Containers"],
  ["images", "Images"],
  ["volumes", "Volumes"],
  ["networks", "Networks"],
];

/** What a prune of each section does, in the words of the confirm dialog. */
const PRUNE: Record<DockerSection, { kind: DockerPruneKind; title: string; what: string; df?: string }> = {
  containers: {
    kind: "containers",
    title: "Remove all stopped containers?",
    what: "Running containers are not touched.",
    df: "Containers",
  },
  images: {
    kind: "images",
    title: "Remove dangling images?",
    what: "Only untagged images no container uses are removed.",
    df: "Images",
  },
  volumes: {
    kind: "volumes",
    title: "Remove unused volumes?",
    what: "Their data is deleted. Docker 23 and later removes only anonymous volumes here.",
    df: "Local Volumes",
  },
  networks: {
    kind: "networks",
    title: "Remove unused networks?",
    what: "Only networks no container is attached to are removed.",
  },
};

const PRUNE_COMMAND: Record<DockerPruneKind, string> = {
  containers: "docker container prune -f",
  images: "docker image prune -f",
  volumes: "docker volume prune -f",
  networks: "docker network prune -f",
};

/** How docker commands get root here, or `null` when they can't yet. */
function dockerElevate(access: DockerAccess | null, rootElevate: Elevate): Elevate | null {
  if (!access) return null;
  if (access.mode === "direct") return "none";
  if (access.mode === "sudo") return "sudo";
  if (access.mode === "needsRoot") return rootElevate === "password" ? "password" : null;
  return null;
}

export function DockerTab() {
  const { probe, sessionId, elevate: rootElevate, canAsk, allow } = useRoot();
  const access = useDocker((s) => s.access);
  const accessError = useDocker((s) => s.accessError);
  const section = useDocker((s) => s.section);
  const setSection = useDocker((s) => s.setSection);
  const init = useDocker((s) => s.init);
  const loading = useDocker((s) => s.loading);
  const error = useDocker((s) => s.error);
  const containers = useDocker((s) => s.containers);
  const diskUse = useDocker((s) => s.diskUse);
  const [askSudo, setAskSudo] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [confirmPrune, setConfirmPrune] = useState(false);

  useEffect(() => {
    if (sessionId) void init(sessionId);
  }, [sessionId, init]);

  const elevate = dockerElevate(access, rootElevate);
  const sudoPrefix = elevate && elevate !== "none" ? "sudo " : "";
  const host = probe?.hostname || "this server";

  const refresh = (e: Elevate) => {
    const d = useDocker.getState();
    // Other sections name the containers that use a resource, so they need
    // the container list too.
    if (section === "containers" || !d.containers) void d.refreshContainers(e);
    if (section === "images") void d.refreshImages(e);
    if (section === "volumes") void d.refreshVolumes(e);
    if (section === "networks") void d.refreshNetworks(e);
    void d.refreshDiskUse(e);
  };

  // Load a section when it is first shown (and once access is known).
  useEffect(() => {
    if (elevate) refresh(elevate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, elevate, sessionId]);

  if (!sessionId) return null;

  if (!access && !accessError) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-text-muted">
        <Loader2 size={14} className="animate-spin text-accent" />
        Checking Docker…
      </div>
    );
  }
  if (accessError) {
    return <Notice tone="error">{accessError}</Notice>;
  }
  if (access?.mode === "unavailable") {
    return (
      <EmptyState
        icon={<PackageX size={20} />}
        title="Docker isn't answering on this host"
        hint={access.error ?? undefined}
      />
    );
  }
  if (!elevate) {
    return (
      <>
        <EmptyState
          icon={<PackageX size={20} />}
          title="Docker needs root on this host"
          hint={`${probe?.root === "none" ? "This user can't use sudo" : "This user isn't in the docker group"}, so Faro can't reach the Docker daemon as it.`}
          action={
            canAsk ? (
              <AskSudoButton onClick={() => setAskSudo(true)} />
            ) : (
              <button
                onClick={() => runInTerminal(sessionId, "sudo docker ps -a", "docker")}
                className="rounded-md border border-border px-3 py-1 text-xs text-text hover:bg-bg-hover"
              >
                Open in terminal
              </button>
            )
          }
        />
        {askSudo && (
          <SudoPasswordModal host={host} onClose={() => setAskSudo(false)} onConfirm={allow} />
        )}
      </>
    );
  }

  const prune = PRUNE[section];
  const reclaim = prune.df ? diskUse.find((d) => d.kind === prune.df)?.reclaimable : undefined;

  const runPrune = async () => {
    setPruning(true);
    try {
      const res = await ipc.dockerPrune(sessionId, prune.kind, elevate);
      if (res.ok) {
        const last = res.output.trim().split("\n").pop() ?? "";
        toast.success(`Pruned ${prune.kind}`, last || undefined);
      } else {
        toast.error(`Could not prune ${prune.kind}`, res.output || undefined);
      }
    } catch (e) {
      toast.error(`Could not prune ${prune.kind}`, String(e));
    } finally {
      setPruning(false);
      refresh(elevate);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <div
          role="tablist"
          aria-label="Docker"
          className="flex h-6 shrink-0 overflow-hidden rounded-md border border-border text-[11px]"
        >
          {SECTIONS.map(([id, label], i) => (
            <button
              key={id}
              role="tab"
              aria-selected={section === id}
              onClick={() => setSection(id)}
              className={cn(
                "px-2.5 [&:active]:scale-100",
                i > 0 && "border-l border-border",
                section === id ? "bg-bg-hover font-medium text-text" : "text-text-dim hover:text-text"
              )}
            >
              {label}
              {id === "containers" && containers ? ` ${containers.length}` : ""}
            </button>
          ))}
        </div>
        <span className="min-w-0 flex-1 truncate text-[11px] text-text-dim">
          Docker {access?.version}
          {elevate !== "none" && " · through sudo, so lists refresh only when asked"}
        </span>
        <button
          onClick={() => setConfirmPrune(true)}
          disabled={pruning}
          title={prune.title}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60"
        >
          {pruning ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          Prune…
        </button>
        <RefreshButton onClick={() => refresh(elevate)} busy={loading} />
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      {section === "containers" && (
        <ContainersSection sessionId={sessionId} elevate={elevate} sudoPrefix={sudoPrefix} />
      )}
      {section === "images" && <ImagesSection sessionId={sessionId} elevate={elevate} sudoPrefix={sudoPrefix} />}
      {section === "volumes" && <VolumesSection sessionId={sessionId} elevate={elevate} sudoPrefix={sudoPrefix} />}
      {section === "networks" && <NetworksSection sessionId={sessionId} elevate={elevate} sudoPrefix={sudoPrefix} />}

      {confirmPrune && (
        <ConfirmModal
          title={prune.title}
          message={
            `${prune.what}\n` +
            (reclaim ? `Docker reports ${reclaim} reclaimable.\n` : "") +
            `\nRuns on ${host}:\n${sudoPrefix}${PRUNE_COMMAND[prune.kind]}`
          }
          destructive
          confirmLabel="Prune"
          onClose={() => setConfirmPrune(false)}
          onConfirm={() => {
            setConfirmPrune(false);
            void runPrune();
          }}
        />
      )}
    </div>
  );
}
