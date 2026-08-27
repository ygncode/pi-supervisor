import assert from "node:assert/strict";
import { classifyPane } from "./classifier";

// Real fixture: pi working state (captured from a live session)
const working = classifyPane(`use the ask_user_question tool to ask me a question with 2 options


 Thinking...


 ask user Choose option


 ⠇ Working...
`);
assert.equal(working.status, "working");
assert.equal(working.dangerous, false);

// Real fixture: ask_user_question dialog rendered by pi's ui.select
const dialog = classifyPane(` Would you like to proceed with option A or option B?

>   1. Option A (Recommended)
     This is the first option, recommended for most cases.
    2. Option B
     This is the alternative option, suitable for specific scenarios.
    3. Type your own answer...

 ↑↓ navigate · Enter select · Esc cancel`);
assert.equal(dialog.status, "dialog");
assert.equal(dialog.question, true);
assert.equal(dialog.dangerous, false);

// Dangerous dialog (destructive content inside a selector)
const dangerousDialog = classifyPane(`Would you like to run this command?

>   1. Yes
     Allow once
    2. No

 ↑↓ navigate · Enter select · Esc cancel

  rm -rf dist && git push origin main`);
assert.equal(dangerousDialog.status, "dialog");
assert.equal(dangerousDialog.dangerous, true);

// Real fixture: idle pane after a completed turn (status line + input prompt)
const idle = classifyPane(` Done — created /tmp/pisup-probe-1.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/private/tmp/pisup-new • probe3
0.0%/1.0M (auto)                                                                                                                                                        (deepseek) deepseek-v4-pro • max
`);
assert.equal(idle.status, "idle");
assert.equal(idle.unresolvedFailure, false);

// A terminal failure in the live tail must be preserved by automatic cleanup.
const failed = classifyPane(`Test run completed.

Command exited with code 1

────────────────────────────────────────────────────────────────
~/project • worker
(openai) model • high`);
assert.equal(failed.status, "idle");
assert.equal(failed.unresolvedFailure, true);

// Merely discussing a fixed error must not prevent cleanup.
const fixedError = classifyPane(`Done — fixed the authentication error and added regression coverage.

All tests passed.

────────────────────────────────────────────────────────────────
~/project • worker
(openai) model • high`);
assert.equal(fixedError.unresolvedFailure, false);

// Scrollback can retain old working spinners after the agent has completed.
// Only the live pane tail should determine state.
const staleSpinner = classifyPane(` Thinking...

 bash test
 ✓ done

 Final implementation summary
 - tests passed
 - build passed
 - no commit

 line 01
 line 02
 line 03
 line 04
 line 05
 line 06
 line 07
 line 08
 line 09
 line 10
 line 11
 line 12
 line 13
 line 14
 line 15
 line 16
────────────────────────────────────────────────────────────────
~/project (main) • worker
42%/272k (auto) (openai-codex) gpt-5.6-sol • high`);
assert.equal(staleSpinner.status, "idle");

// Assistant replies with numbered lists must NOT look like a dialog
const numberedList = classifyPane(`Here are the steps:

1. Clone the repository
2. Install dependencies
3. Run the tests

Done.`);
assert.equal(numberedList.status, "idle");

// Missing session
const missing = classifyPane("", false);
assert.equal(missing.status, "missing");
assert.equal(missing.piLike, false);
assert.equal(missing.unresolvedFailure, false);

// pi-like detection: startup screen
const piLike = classifyPane(` pi v0.83.0
 escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
 Press ctrl+o to show full startup help and loaded resources.`);
assert.equal(piLike.piLike, true);

console.log("pi-supervisor classifier tests passed");
