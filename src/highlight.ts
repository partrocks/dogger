// Syntax highlighting for the task file editor, built on Prism. Kept separate
// from `App.tsx` so the (side-effectful) Prism language imports live in one
// place. The editor (`react-simple-code-editor`) calls `highlightCode` with the
// active file name; we pick a grammar by extension and fall back to plain,
// HTML-escaped text for anything we don't recognise.

import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";
// `php` needs the templating helper; import it first.
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-markdown";

// Map a file (by extension, or special-cased name) to a Prism language id.
const BY_EXTENSION: Record<string, string> = {
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  php: "php",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
};

const LABELS: Record<string, string> = {
  bash: "Shell",
  json: "JSON",
  javascript: "JavaScript",
  typescript: "TypeScript",
  php: "PHP",
  yaml: "YAML",
  markdown: "Markdown",
};

function languageKey(filename: string | null): string | null {
  if (!filename) return null;
  const lower = filename.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const lang = BY_EXTENSION[ext];
  if (lang) return lang;
  // Extension-less shell scripts (e.g. a bare `main`) still read as shell.
  if (lower === "main.sh" || lower.endsWith(".sh")) return "bash";
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Highlight `code` for the given file, or escape it when unrecognised. */
export function highlightCode(code: string, filename: string | null): string {
  const lang = languageKey(filename);
  const grammar = lang ? Prism.languages[lang] : undefined;
  if (!lang || !grammar) return escapeHtml(code);
  return Prism.highlight(code, grammar, lang);
}

/** Human-readable language name for the editor header, if recognised. */
export function languageLabel(filename: string | null): string | null {
  const lang = languageKey(filename);
  return lang ? (LABELS[lang] ?? lang) : null;
}
