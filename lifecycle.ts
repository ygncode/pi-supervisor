import type { PaneClassification } from "./classifier";

export interface SessionLifecycleInput {
  name: string;
  attached: boolean;
  managed: boolean;
  owner?: string;
  settledSignal?: string;
  classification: PaneClassification;
}

export function settledAtFromSignal(signal?: string): number | undefined {
  if (!signal) return undefined;
  const separator = signal.indexOf(":");
  const value = separator >= 0 ? signal.slice(0, separator) : signal;
  if (!/^\d+$/.test(value)) return undefined;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : undefined;
}

export function explicitCloseBlockReason(
  input: SessionLifecycleInput,
  currentOwner: string,
  currentTmuxSession?: string,
): string | undefined {
  if (input.name === currentTmuxSession) return "it is the supervising Pi's own tmux session";
  if (!input.managed) return "it was not spawned and marked as managed by Pi Supervisor";
  if (input.owner !== currentOwner) return "it is owned by a different Pi supervisor session";
  if (input.attached) return "a tmux client is attached";
  if (input.classification.status === "working") return "the Pi agent is still working";
  if (input.classification.status === "dialog") return "the Pi agent is waiting at a dialog";
  if (input.classification.dangerous) return "the pane contains a sensitive permission request";
  if (input.classification.unresolvedFailure) return "the pane shows a likely unresolved failure";
  return undefined;
}

export function automaticCloseBlockReason(
  input: SessionLifecycleInput,
  currentOwner: string,
  now: number,
  timeoutMs: number,
  currentTmuxSession?: string,
): string | undefined {
  const explicitReason = explicitCloseBlockReason(input, currentOwner, currentTmuxSession);
  if (explicitReason) return explicitReason;
  if (input.classification.question) return "the pane contains a likely question";
  const settledAt = settledAtFromSignal(input.settledSignal);
  if (!settledAt) return "there is no valid settled signal";
  if (now - settledAt < timeoutMs) return "the idle grace period has not elapsed";
  return undefined;
}

export function legacyCleanupBlockReason(
  input: SessionLifecycleInput,
  now: number,
  minimumIdleMs: number,
  currentTmuxSession?: string,
): string | undefined {
  if (input.name === currentTmuxSession) return "it is the supervising Pi's own tmux session";
  if (input.managed) return "it is already a managed Pi Supervisor session";
  if (input.attached) return "a tmux client is attached";
  if (!input.classification.piLike) return "the pane does not look like Pi";
  if (input.classification.status === "working") return "the Pi agent is still working";
  if (input.classification.status === "dialog") return "the Pi agent is waiting at a dialog";
  if (input.classification.dangerous) return "the pane contains a sensitive permission request";
  if (input.classification.question) return "the pane contains a likely question";
  if (input.classification.unresolvedFailure) return "the pane shows a likely unresolved failure";
  const settledAt = settledAtFromSignal(input.settledSignal);
  if (!settledAt) return "there is no valid settled signal";
  if (now - settledAt < minimumIdleMs) return "the minimum idle period has not elapsed";
  return undefined;
}
