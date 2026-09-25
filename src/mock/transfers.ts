// Mock transfer-queue engine (Plan 17). Mirrors the Rust backend's contract
// closely enough for the headless verify script: keeps the transfer list plus
// the queue state (waiting FIFO / pausedAll / concurrency / throttle), applies
// the pause/resume/retry/move/pause-all/set-* commands, and emits the same
// `transfer://updated` / `transfer://queue` events the real backend would.
// Every mutating command is recorded in `calls` so the harness can assert the
// UI invoked the right command with the right args.
import type { Transfer, TransferQueueState } from "@/lib/types";
import { emit } from "./event";
import { transfers as canned } from "./data";

export const calls: Array<{ cmd: string; args: Record<string, any> }> = [];

let byId = new Map<string, Transfer>(canned.map((t) => [t.id, t]));
let queue: TransferQueueState = {
  waiting: canned.filter((t) => t.status === "queued").map((t) => t.id),
  pausedAll: false,
  concurrency: 3,
  throttleKbps: 0,
};

export function listTransfers(): Transfer[] {
  return [...byId.values()];
}

export function queueState(): TransferQueueState {
  return { ...queue, waiting: [...queue.waiting] };
}

/** Test hook: replace the whole world. The store re-reads via loadInitial(). */
export function seed(list: Transfer[], q?: Partial<TransferQueueState>) {
  byId = new Map(list.map((t) => [t.id, t]));
  queue = {
    waiting: list.filter((t) => t.status === "queued").map((t) => t.id),
    pausedAll: false,
    concurrency: queue.concurrency,
    throttleKbps: queue.throttleKbps,
    ...q,
  };
}

function update(t: Transfer) {
  byId.set(t.id, t);
  emit("transfer://updated", t);
}

function emitQueue() {
  emit("transfer://queue", queueState());
}

export function handle(cmd: string, a: Record<string, any>): void {
  calls.push({ cmd, args: a });
  const t = byId.get(a.transferId);
  switch (cmd) {
    case "transfer_pause":
      // Valid from queued or transferring. A queued row leaves the FIFO.
      if (t && (t.status === "transferring" || t.status === "queued")) {
        if (queue.waiting.includes(t.id)) {
          queue.waiting = queue.waiting.filter((id) => id !== t.id);
          emitQueue();
        }
        update({ ...t, status: "paused" });
      }
      break;
    case "transfer_resume":
      // Valid from paused; the backend re-runs from byte 0.
      if (t && t.status === "paused") {
        update({ ...t, status: "transferring", transferred: 0 });
      }
      break;
    case "transfer_retry":
      // Valid from error/canceled; re-enqueues at the FIFO tail.
      if (t && (t.status === "error" || t.status === "canceled")) {
        const next: Transfer = {
          ...t,
          status: "queued",
          transferred: 0,
          error: undefined,
          retryAttempt: undefined,
        };
        queue.waiting = [...queue.waiting, t.id];
        update(next);
        emitQueue();
      }
      break;
    case "transfer_move": {
      const i = queue.waiting.indexOf(a.transferId);
      const j = a.direction === "up" ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < queue.waiting.length) {
        const w = [...queue.waiting];
        [w[i], w[j]] = [w[j], w[i]];
        queue.waiting = w;
        emitQueue();
      }
      break;
    }
    case "transfer_pause_all":
      queue.pausedAll = true;
      emitQueue();
      break;
    case "transfer_resume_all":
      queue.pausedAll = false;
      emitQueue();
      break;
    case "transfer_set_concurrency":
      queue.concurrency = Math.max(1, Math.min(32, a.count | 0));
      emitQueue();
      break;
    case "transfer_set_throttle":
      queue.throttleKbps = Math.max(0, a.kbps | 0);
      emitQueue();
      break;
    case "transfer_set_delta_sync":
      // Recorded in `calls` above; the mock has no delta engine to toggle.
      break;
  }
}

let started = 0;

/** start_download / start_upload: enqueue a fresh row and animate it to done
 *  over a few seconds, so demos and walkthrough videos show a real transfer
 *  instead of a silent no-op. Returns the new transfer id. */
export function start(
  kind: "download" | "upload",
  source: string,
  destDir: string,
  knownSize?: number
): string {
  const id = `t-new-${++started}`;
  const name = source.split(/[\/]/).pop() || "file";
  const sep = destDir.includes("\\") ? "\\" : "/";
  const destination = destDir.replace(/[\/]+$/, "") + sep + name;
  // The listing's size when the caller knows it, else a deterministic
  // per-name size between ~2 and ~18 MB.
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const size = knownSize || 2_000_000 + (h % 16_000_000);
  let t: Transfer = { id, kind, source, destination, size, transferred: 0, status: "transferring", startedAt: Date.now() };
  update(t);
  const steps = 24;
  let i = 0;
  const timer = setInterval(() => {
    i++;
    const done = i >= steps;
    t = { ...t, transferred: done ? size : Math.round((size * i) / steps), status: done ? "done" : "transferring" };
    update(t);
    if (done) clearInterval(timer);
  }, 350);
  return id;
}
