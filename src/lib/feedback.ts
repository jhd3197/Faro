// Feedback without a backend: a prefilled GitHub issue the user reviews
// before sending, and a copyable system-info block. Nothing is uploaded by
// Faro itself. Like diagnostics.rs, the info carries no hosts, paths or
// secrets: only the app version, OS and WebView.
import { getVersion } from "@tauri-apps/api/app";
import { useSettings } from "@/stores/settingsStore";

export const REPO_URL = "https://github.com/jhd3197/faro";
export const DISCORD_URL = "https://discord.gg/ZKk6tkCQfG";

export type FeedbackKind = "bug" | "idea";

function osFromUserAgent(ua: string): string {
  const win = ua.match(/Windows NT ([\d.]+)/);
  if (win) {
    // Windows 11 still reports NT 10.0 in the user agent.
    const arch = /ARM64|aarch64/i.test(ua) ? "ARM64" : /Win64|x64|WOW64/i.test(ua) ? "x64" : "";
    return `Windows (NT ${win[1]})${arch ? ` ${arch}` : ""}`;
  }
  const mac = ua.match(/Mac OS X ([\d_]+)/);
  if (mac) return `macOS ${mac[1].replace(/_/g, ".")}`;
  if (/Linux/i.test(ua)) return `Linux${/aarch64|arm64/i.test(ua) ? " ARM64" : /x86_64/.test(ua) ? " x64" : ""}`;
  return "Unknown";
}

function webviewFromUserAgent(ua: string): string {
  const edge = ua.match(/Edg\/([\d.]+)/);
  if (edge) return `WebView2 ${edge[1]}`;
  const chrome = ua.match(/Chrome\/([\d.]+)/);
  if (chrome) return `Chromium ${chrome[1]}`;
  const webkit = ua.match(/AppleWebKit\/([\d.]+)/);
  if (webkit) return `WebKit ${webkit[1]}`;
  return "Unknown";
}

/** A few plain lines safe to paste in public. */
export async function systemInfo(): Promise<string> {
  let version = "unknown";
  try {
    version = await getVersion();
  } catch {
    // Not fatal: the rest is still useful.
  }
  const s = useSettings.getState();
  const ua = navigator.userAgent;
  return [
    `Faro: ${version}`,
    `OS: ${osFromUserAgent(ua)}`,
    `WebView: ${webviewFromUserAgent(ua)}`,
    `Language: ${s.uiLanguage === "system" ? `system (${navigator.language})` : s.uiLanguage}`,
    `UI zoom: ${s.uiZoom}%`,
  ].join("\n");
}

const TEMPLATES: Record<FeedbackKind, { labels: string; body: string }> = {
  bug: {
    labels: "bug",
    body: "### What happened\n\n\n### Steps to reproduce\n1. \n\n### What you expected\n\n",
  },
  idea: {
    labels: "enhancement",
    body: "### What would you like Faro to do?\n\n\n### Why would it help?\n\n",
  },
};

/** GitHub's new-issue page with the template and system info filled in. */
export async function issueUrl(kind: FeedbackKind): Promise<string> {
  const t = TEMPLATES[kind];
  const body = `${t.body}---\n<details><summary>System info</summary>\n\n\`\`\`\n${await systemInfo()}\n\`\`\`\n</details>\n`;
  const q = new URLSearchParams({ labels: t.labels, body });
  return `${REPO_URL}/issues/new?${q.toString()}`;
}
