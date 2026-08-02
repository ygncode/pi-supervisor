import { createHash } from "node:crypto";

export type PiPaneStatus = "working" | "dialog" | "idle" | "missing";

export interface PaneClassification {
  status: PiPaneStatus;
  dangerous: boolean;
  question: boolean;
  piLike: boolean;
  fingerprint: string;
  excerpt: string;
}

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

// Pi renders transient status lines while the agent is active:
//   " Thinking..."  (leading space, then dots)
//   " ⠇ Working..." (Braille spinner + "Working...")
const WORKING = /^\s*(?:Thinking|Working|Ruminating|Compacting|Baking|Brewing|Crunching|Finagling|Hatching|Pondering|Whirring|Wandering|Channelling|Churning|Cogitating|Researching|Implementing|Testing|Building|Analyzing|Reading|Writing|Updating|Installing|Fixing|Reviewing|Planning|Searching)[…\.]{1,4}\s*$|^[⠁-⠿]\s*Working[…\.]{1,4}\s*$/im;

// Pi renders decision/selector dialogs (ui.select, ui.confirm, ask_user_question,
// trust prompts, model selectors) with these markers:
//   "↑↓ navigate · Enter select · Esc cancel"   (option hint line)
//   "→ model-name [provider] ✓"                  (selected option marker)
//   ">   1. Option A (Recommended)"              (search cursor + numbered option)
//   "tab scope (all/scoped)"                     (model selector header)
//   "(esc to cancel)" / "(esc to cancel, enter to submit)" (login/other dialogs)
const DIALOG = /(?:↑↓\s*(?:navigate|move)|Enter\s+(?:select|submit)|esc\s+to\s+cancel|to\s+(?:submit|cancel|close))/i;
const DIALOG_SELECTED = /^\s*→\s/m;
const DIALOG_OPTION = /^\s*>\s*\d+\.\s/m;
const DIALOG_HEADER = /^tab scope\s/m;

// Reuse the claude-supervisor danger vocabulary: destructive, deployment,
// credential, and security-sensitive content.
const DANGEROUS = /(?:\brm\s+-[^\n]*r|\bsudo\b|\bgit\s+(?:push|reset\s+--hard|clean\s+-f)|\b(?:ssh|scp|rsync)\b|\b(?:deploy|production|staging)\b|\b(?:drop|truncate|delete)\s+(?:database|table|from)\b|\b(?:migrate|migration|artisan)\b|\.env\b|secret|credential|token|password)/i;

const QUESTION = /(?:\?\s*$|please (?:choose|confirm)|which (?:option|approach)|would you like|should i|need your (?:input|decision))/im;

// Heuristics for "does this tmux pane look like a pi TUI?" (used by `list`):
// startup help line, token-usage status (↑/↓ counters), or the model input
// prompt line "(provider) model • thinking-level".
const PI_LIKE = /escape interrupt|↑\s*\d+[kMG]?\s+↓\s*\d+|^\([^)]+\)\s+\S+\s+•\s+(?:max|high|low|off|medium)\s*$/im;

export function cleanPane(raw: string): string {
  return raw
    .replace(ANSI, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function meaningfulExcerpt(cleaned: string): string {
  const lines = cleaned.split("\n").filter((line) => {
    const text = line.trim();
    if (!text) return false;
    if (/^[─━═]+$/.test(text)) return false;
    if (/^(?:⏵⏵\s*)?accept edits on/i.test(text)) return false;
    return true;
  });
  return lines.slice(-80).join("\n").slice(-12_000);
}

export function classifyPane(raw: string, exists = true): PaneClassification {
  if (!exists) {
    return { status: "missing", dangerous: false, question: false, piLike: false, fingerprint: "missing", excerpt: "tmux session does not exist" };
  }

  const cleaned = cleanPane(raw);
  const excerpt = meaningfulExcerpt(cleaned);
  // capture-pane includes scrollback, so old spinners and dialogs may remain
  // hundreds of lines above the current prompt. Classify only the live tail.
  const stateWindow = cleaned.split("\n").slice(-16).join("\n");
  const dialog = DIALOG.test(stateWindow) || DIALOG_SELECTED.test(stateWindow) || DIALOG_OPTION.test(stateWindow) || DIALOG_HEADER.test(stateWindow);
  const working = !dialog && WORKING.test(stateWindow);
  const status: PiPaneStatus = working ? "working" : dialog ? "dialog" : "idle";
  const stableText = excerpt
    .replace(/^[⠁-⠿]\s*/gm, "")
    .replace(/\(\d+[smh](?:\s+\d+[smh])?[^)]*\)/g, "(elapsed)")
    .replace(/\b\d{1,3}(?:,\d{3})*\s+tokens?\b/gi, "tokens")
    .replace(/[✳✻✽·*]\s+/g, "");
  const fingerprint = createHash("sha256").update(`${status}\n${stableText}`).digest("hex").slice(0, 20);

  return {
    status,
    dangerous: dialog && DANGEROUS.test(cleaned),
    question: dialog || QUESTION.test(excerpt),
    piLike: PI_LIKE.test(cleaned),
    fingerprint,
    excerpt,
  };
}
