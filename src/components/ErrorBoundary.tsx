import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { crashDetail, logCrash, useCrashTest } from "@/lib/errorCapture";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/cn";
import { CopyTextButton } from "./ui/CopyText";

interface Props {
  /** What the user calls this part of the window ("File browser"). */
  region: string;
  children: ReactNode;
  /** Fill the whole window (the top-level boundary). */
  fullScreen?: boolean;
  className?: string;
}

interface State {
  error: unknown;
  componentStack: string | null;
}

/**
 * Keeps a crash in one part of the window from blanking the rest: the region
 * is replaced by a small panel saying what failed, with Try again (re-mounts
 * the region) and Copy details. The crash is logged to the notification
 * centre, where the status-bar error pill counts it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error("Unknown error") };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    logCrash(this.props.region, error, info.componentStack);
  }

  reset = () => {
    if (useCrashTest.getState().region === this.props.region) useCrashTest.getState().crash(null);
    this.setState({ error: null, componentStack: null });
  };

  render() {
    const { error, componentStack } = this.state;
    if (!error) {
      return (
        <>
          <CrashProbe region={this.props.region} />
          {this.props.children}
        </>
      );
    }
    const { region, fullScreen, className } = this.props;
    return (
      <div
        role="alert"
        data-error-boundary={region}
        className={cn(
          "flex min-h-0 flex-1 items-center justify-center bg-bg p-6",
          fullScreen && "h-screen w-screen",
          className
        )}
      >
        <div className="flex w-full max-w-sm flex-col gap-2 rounded-lg border border-border bg-bg-panel p-4 shadow-elev-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle size={15} className="shrink-0 text-danger" />
            {region} stopped working
          </div>
          <div className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-text-muted [overflow-wrap:anywhere]">
            {messageOf(error) || "Unknown error"}
          </div>
          <div className="text-[11px] text-text-dim">
            The rest of Faro still works. Try again reloads just this part.
          </div>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent/90"
            >
              <RotateCcw size={12} />
              Try again
            </button>
            <CopyTextButton
              text={`${region} stopped working\n\n${crashDetail(error, componentStack)}`}
              label="Copy details"
              className="rounded-md border border-border px-2.5 py-1 text-xs text-text-muted"
            />
          </div>
        </div>
      </div>
    );
  }
}

/** Throws while the demo crash hook targets this region. */
function CrashProbe({ region }: { region: string }) {
  const target = useCrashTest((s) => s.region);
  if (target === region) throw new Error(`Test crash in ${region}`);
  return null;
}
