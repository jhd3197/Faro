// Controllable updater mock for the UI regression harness. A download must be
// verified before install, and install must be a separate user action.
type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export async function check(_options?: unknown) {
  const w = window as any;
  w.__updateChecks = (w.__updateChecks ?? 0) + 1;
  if (w.__mockCheckError) throw w.__mockCheckError;
  const cfg = w.__mockUpdate;
  if (!cfg) return null;
  const size = cfg.size ?? 1000;
  let verified = false;
  let closed = false;
  return {
    version: cfg.version,
    currentVersion: cfg.currentVersion ?? "1.3.22",
    body: cfg.body ?? null,
    available: true,
    async download(onEvent: (e: DownloadEvent) => void, _options?: unknown) {
      if (closed) throw new Error("Update resource was closed");
      w.__downloadCalls = (w.__downloadCalls ?? 0) + 1;
      onEvent({ event: "Started", data: { contentLength: cfg.unknownSize ? undefined : size } });
      onEvent({ event: "Progress", data: { chunkLength: Math.floor(size / 2) } });
      await new Promise((resolve) => setTimeout(resolve, cfg.delay ?? 80));
      if (w.__mockDownloadError) throw w.__mockDownloadError;
      onEvent({ event: "Progress", data: { chunkLength: Math.ceil(size / 2) } });
      onEvent({ event: "Finished" });
      await new Promise((resolve) => setTimeout(resolve, cfg.verifyDelay ?? 80));
      if (w.__mockSignatureError) throw new Error("signature verification failed");
      verified = true;
    },
    async install() {
      w.__installCalls = (w.__installCalls ?? 0) + 1;
      if (!verified || closed) throw new Error("No verified download");
      if (w.__mockInstallError) throw w.__mockInstallError;
      w.__installed = true;
    },
    async close() { closed = true; w.__closedUpdates = (w.__closedUpdates ?? 0) + 1; },
  };
}

export type Update = NonNullable<Awaited<ReturnType<typeof check>>>;
