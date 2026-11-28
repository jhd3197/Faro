// Which files the built-in editor and image viewer open, and which syntax a
// text file gets (Plan 37 Phase 3). Language packages are imported on demand,
// so opening a shell script doesn't load the PHP parser.

import type { Extension } from "@codemirror/state";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** MIME type when the image viewer can show this file, else null. */
export function imageMime(name: string): string | null {
  return IMAGE_MIME[extOf(name)] ?? null;
}

// Extensions that are never text. Everything else is tried: the backend
// refuses binaries and non-UTF-8 files with a clear reason.
const NOT_TEXT = new Set([
  ...Object.keys(IMAGE_MIME).filter((e) => e !== "svg"),
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "war",
  "exe", "dll", "so", "dylib", "bin", "dmg", "iso", "msi", "deb", "rpm", "apk",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
  "mp3", "mp4", "mkv", "mov", "avi", "webm", "wav", "flac", "ogg", "m4a",
  "ttf", "otf", "woff", "woff2", "eot",
  "sqlite", "db", "pyc", "class", "o", "a", "wasm", "psd", "heic", "tiff", "tif",
]);

/** Could this be a text file the editor opens? */
export function looksEditable(name: string): boolean {
  return !NOT_TEXT.has(extOf(name));
}

export interface LanguageChoice {
  /** Shown in the editor's status line. */
  label: string;
  load: () => Promise<Extension>;
}

const PLAIN: LanguageChoice = { label: "Plain text", load: async () => [] };

async function legacy(
  pick: () => Promise<unknown>,
  name: string
): Promise<Extension> {
  const [{ StreamLanguage }, mod] = await Promise.all([import("@codemirror/language"), pick()]);
  const parser = (mod as Record<string, unknown>)[name];
  return parser ? StreamLanguage.define(parser as never) : [];
}

const shell: LanguageChoice = {
  label: "Shell",
  load: () => legacy(() => import("@codemirror/legacy-modes/mode/shell"), "shell"),
};
const properties: LanguageChoice = {
  label: "Config",
  load: () => legacy(() => import("@codemirror/legacy-modes/mode/properties"), "properties"),
};

const BY_EXT: Record<string, LanguageChoice> = {
  js: { label: "JavaScript", load: async () => (await import("@codemirror/lang-javascript")).javascript() },
  mjs: { label: "JavaScript", load: async () => (await import("@codemirror/lang-javascript")).javascript() },
  cjs: { label: "JavaScript", load: async () => (await import("@codemirror/lang-javascript")).javascript() },
  jsx: { label: "JavaScript", load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }) },
  ts: { label: "TypeScript", load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }) },
  tsx: { label: "TypeScript", load: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }) },
  json: { label: "JSON", load: async () => (await import("@codemirror/lang-json")).json() },
  html: { label: "HTML", load: async () => (await import("@codemirror/lang-html")).html() },
  htm: { label: "HTML", load: async () => (await import("@codemirror/lang-html")).html() },
  liquid: { label: "HTML", load: async () => (await import("@codemirror/lang-html")).html() },
  css: { label: "CSS", load: async () => (await import("@codemirror/lang-css")).css() },
  scss: { label: "CSS", load: async () => (await import("@codemirror/lang-css")).css() },
  md: { label: "Markdown", load: async () => (await import("@codemirror/lang-markdown")).markdown() },
  markdown: { label: "Markdown", load: async () => (await import("@codemirror/lang-markdown")).markdown() },
  py: { label: "Python", load: async () => (await import("@codemirror/lang-python")).python() },
  php: { label: "PHP", load: async () => (await import("@codemirror/lang-php")).php() },
  sql: { label: "SQL", load: async () => (await import("@codemirror/lang-sql")).sql() },
  xml: { label: "XML", load: async () => (await import("@codemirror/lang-xml")).xml() },
  svg: { label: "XML", load: async () => (await import("@codemirror/lang-xml")).xml() },
  yaml: { label: "YAML", load: async () => (await import("@codemirror/lang-yaml")).yaml() },
  yml: { label: "YAML", load: async () => (await import("@codemirror/lang-yaml")).yaml() },
  toml: { label: "TOML", load: () => legacy(() => import("@codemirror/legacy-modes/mode/toml"), "toml") },
  sh: shell,
  bash: shell,
  zsh: shell,
  fish: shell,
  env: properties,
  ini: properties,
  conf: properties,
  cfg: properties,
  properties: properties,
  service: properties,
  dockerfile: { label: "Dockerfile", load: () => legacy(() => import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile") },
  nginx: { label: "nginx", load: () => legacy(() => import("@codemirror/legacy-modes/mode/nginx"), "nginx") },
  rb: { label: "Ruby", load: () => legacy(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby") },
  go: { label: "Go", load: () => legacy(() => import("@codemirror/legacy-modes/mode/go"), "go") },
  rs: { label: "Rust", load: () => legacy(() => import("@codemirror/legacy-modes/mode/rust"), "rust") },
  lua: { label: "Lua", load: () => legacy(() => import("@codemirror/legacy-modes/mode/lua"), "lua") },
  ps1: { label: "PowerShell", load: () => legacy(() => import("@codemirror/legacy-modes/mode/powershell"), "powerShell") },
};

// Files known by their whole name rather than an extension.
const BY_NAME: Record<string, LanguageChoice> = {
  dockerfile: BY_EXT.dockerfile,
  ".env": properties,
  ".bashrc": shell,
  ".bash_profile": shell,
  ".zshrc": shell,
  ".profile": shell,
  ".htaccess": properties,
  "nginx.conf": BY_EXT.nginx,
  makefile: PLAIN,
};

/** The syntax for a file name. Unknown names are plain text. */
export function languageFor(name: string): LanguageChoice {
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  // `.env.production`, `.env.local`
  if (base.startsWith(".env.")) return properties;
  return BY_EXT[extOf(base)] ?? PLAIN;
}
