import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { classifyPane, type PiPaneStatus, type PaneClassification } from "./classifier";
import {
  automaticCloseBlockReason,
  explicitCloseBlockReason,
  legacyCleanupBlockReason,
  settledAtFromSignal,
  type SessionLifecycleInput,
} from "./lifecycle";

const POLL_MS = 5_000;
const STABLE_POLLS = 2;
const AUTO_CLOSE_MS = 30 * 60_000;
const LEGACY_MIN_IDLE_MS = 10 * 60_000;
const ENTRY_TYPE = "pi-supervisor-state";
const CLOSE_ENTRY_TYPE = "pi-supervisor-closed";
const STATUS_KEY = "pi-supervisor";
const WIDGET_KEY = "pi-supervisor";
const SETTLED_OPTION = "@pi_agent_settled";
const MANAGED_OPTION = "@pi_supervisor_managed";
const OWNER_OPTION = "@pi_supervisor_owner";
const CREATED_OPTION = "@pi_supervisor_created_at";

type WatchedSession = {
  name: string;
  status: PiPaneStatus;
  classification?: PaneClassification;
  lastNotified?: string;
  stableFingerprint?: string;
  stableCount: number;
  pendingWake: boolean;
  lastSettledSignal?: string;
  latestSettledSignal?: string;
  settledAt?: number;
  attached: boolean;
  managed: boolean;
  owner?: string;
  autoCloseAt?: number;
  lastAutoCloseAttempt?: number;
  updatedAt?: number;
};

type SessionMetadata = {
  attached: boolean;
  managed: boolean;
  owner?: string;
  createdAt?: number;
};

type InspectedSession = SessionLifecycleInput & {
  text: string;
};

type CloseResult = {
  session: string;
  message: string;
  excerpt: string;
};

const createWatched = (name: string): WatchedSession => ({
  name,
  status: "missing",
  stableCount: 0,
  pendingWake: false,
  attached: false,
  managed: false,
});

export default function piSupervisor(pi: ExtensionAPI) {
  const watched = new Map<string, WatchedSession>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let context: ExtensionContext | undefined;
  let supervisorTmuxSession: string | undefined;

  const tmux = (args: string[], timeout = 8_000) => pi.exec("tmux", args, { timeout });

  async function listSessions(): Promise<string[]> {
    const result = await tmux(["list-sessions", "-F", "#{session_name}"], 5_000);
    if (result.code !== 0) return [];
    return result.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  }

  function defaultSession(requested?: string): string {
    if (requested) requested = requested.trim();
    if (requested) return requested;
    if (watched.size === 1) return [...watched.keys()][0]!;
    if (watched.size === 0) throw new Error("No Pi tmux session is supervised");
    throw new Error(`Multiple sessions are supervised; specify one of: ${[...watched.keys()].join(", ")}`);
  }

  function renderStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (watched.size === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const values = [...watched.values()];
    const attention = values.filter((item) => item.status === "dialog" || item.status === "idle" || item.status === "missing").length;
    const working = values.filter((item) => item.status === "working").length;
    const color = attention > 0 ? "warning" : "accent";
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `● Pi ${working} working · ${attention} waiting · ${values.length} total`));
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
      const lines = [theme.fg("accent", theme.bold("Pi supervisors")) + theme.fg("dim", ` · ${values.length} tmux sessions`)];
      for (const item of values.sort((a, b) => a.name.localeCompare(b.name))) {
        const failure = item.classification?.unresolvedFailure;
        const itemColor = failure ? "error" : item.status === "working" ? "accent" : item.status === "dialog" ? "warning" : item.status === "idle" ? "success" : "error";
        const symbol = failure ? "!" : item.status === "working" ? "●" : item.status === "dialog" ? "!" : item.status === "idle" ? "◆" : "×";
        const age = item.updatedAt ? `${Math.max(0, Math.floor((Date.now() - item.updatedAt) / 1000))}s` : "waiting";
        const lifecycle = failure
          ? " · preserved: failure"
          : item.autoCloseAt
            ? ` · closes in ${Math.max(0, Math.ceil((item.autoCloseAt - Date.now()) / 60_000))}m`
            : "";
        lines.push(theme.fg(itemColor, `${symbol} ${item.name}`) + theme.fg("dim", ` · ${item.status} · ${age}${lifecycle}`));
      }
      lines.push(theme.fg("dim", "Autonomous supervision enabled · /pi-supervise status"));
      return new Text(lines.join("\n"), 0, 0);
    });
  }

  function persist() {
    pi.appendEntry(ENTRY_TYPE, { sessions: [...watched.keys()] });
  }

  function wakeSupervisor(
    ctx: ExtensionContext,
    item: WatchedSession,
    classification: PaneClassification,
    notificationKey = classification.fingerprint,
    stateLabel: string = classification.status,
  ): boolean {
    if (item.pendingWake || notificationKey === item.lastNotified) return false;
    item.pendingWake = true;
    item.lastNotified = notificationKey;
    const safety = classification.dangerous
      ? "STOP: this appears to be an explicit destructive/deployment/security permission request. Obtain explicit user approval before sending anything to the supervised Pi."
      : "Supervise autonomously: inspect the relevant repository and the supervised Pi pane as needed, answer routine questions, send the appropriate response or next checkpoint through pi_supervisor, and continue managing until validated completion.";
    const message = `[Pi Supervisor event]\nSession: ${item.name}\nState: ${stateLabel}${classification.question ? " (question or decision likely)" : ""}\n\n${safety}\n\nRecent Pi pane:\n---\n${classification.excerpt}\n---`;
    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: "followUp" });
    return true;
  }

  async function readSessionMetadata(session: string): Promise<SessionMetadata> {
    const result = await tmux([
      "display-message",
      "-p",
      "-t",
      session,
      `#{session_attached}\t#{${MANAGED_OPTION}}\t#{${OWNER_OPTION}}\t#{${CREATED_OPTION}}`,
    ], 4_000);
    if (result.code !== 0) return { attached: false, managed: false };
    const [attached = "0", managed = "", owner = "", createdAt = ""] = result.stdout.trim().split("\t");
    const created = Number(createdAt);
    return {
      attached: Number(attached) > 0,
      managed: managed === "1",
      owner: owner || undefined,
      createdAt: Number.isFinite(created) && created > 0 ? created : undefined,
    };
  }

  async function currentTmuxSession(): Promise<string | undefined> {
    const pane = process.env.TMUX_PANE;
    if (!pane) return undefined;
    const result = await tmux(["display-message", "-p", "-t", pane, "#{session_name}"], 4_000);
    const name = result.code === 0 ? result.stdout.trim() : "";
    return name || undefined;
  }

  async function readSettledSignal(session: string): Promise<string | undefined> {
    const panes = await tmux(["list-panes", "-t", session, "-F", "#{pane_id}\t#{pane_active}"], 4_000);
    if (panes.code !== 0) return undefined;
    const rows = panes.stdout.split("\n").map((row) => row.trim()).filter(Boolean);
    const active = rows.find((row) => row.endsWith("\t1")) ?? rows[0];
    const pane = active?.split("\t")[0];
    if (!pane) return undefined;
    const result = await tmux(["show-options", "-p", "-t", pane, "-v", SETTLED_OPTION], 4_000);
    const value = result.code === 0 ? result.stdout.trim() : "";
    return value || undefined;
  }

  async function inspectSession(session: string): Promise<InspectedSession> {
    const exists = await tmux(["has-session", "-t", session], 4_000);
    if (exists.code !== 0) {
      return {
        name: session,
        attached: false,
        managed: false,
        classification: classifyPane("", false),
        text: "tmux session does not exist",
      };
    }
    const [capture, metadata, settledSignal] = await Promise.all([
      tmux(["capture-pane", "-p", "-t", session, "-S", "-220"], 7_000),
      readSessionMetadata(session),
      readSettledSignal(session),
    ]);
    const text = capture.stdout.slice(-20_000);
    return {
      name: session,
      ...metadata,
      settledSignal,
      classification: classifyPane(capture.stdout),
      text,
    };
  }

  function watchedLifecycle(item: WatchedSession): SessionLifecycleInput {
    return {
      name: item.name,
      attached: item.attached,
      managed: item.managed,
      owner: item.owner,
      settledSignal: item.latestSettledSignal,
      classification: item.classification ?? classifyPane("", item.status !== "missing"),
    };
  }

  async function publishSettledSignal(ctx: ExtensionContext) {
    const pane = process.env.TMUX_PANE;
    if (!pane) return;
    const token = `${Date.now()}:${ctx.sessionManager.getLeafId() ?? "none"}`;
    await tmux(["set-option", "-p", "-t", pane, SETTLED_OPTION, token], 4_000);
  }

  async function terminateSession(session: string, classification: PaneClassification, reason: "validated" | "automatic" | "legacy cleanup"): Promise<CloseResult> {
    const killed = await tmux(["kill-session", "-t", session], 7_000);
    if (killed.code !== 0) throw new Error(killed.stderr || `tmux kill-session failed for ${session}`);
    const verification = await tmux(["has-session", "-t", session], 4_000);
    if (verification.code === 0) throw new Error(`tmux session still exists after close: ${session}`);
    watched.delete(session);
    persist();
    if (watched.size === 0) stopTimer();
    const excerpt = classification.excerpt.slice(-4_000);
    pi.appendEntry(CLOSE_ENTRY_TYPE, { session, reason, closedAt: Date.now(), excerpt });
    return { session, message: `Closed completed Pi tmux session '${session}' (${reason}).`, excerpt };
  }

  async function closeManagedSession(session: string, ctx: ExtensionContext, reason: "validated" | "automatic"): Promise<CloseResult> {
    const inspected = await inspectSession(session);
    if (inspected.classification.status === "missing") throw new Error(`tmux session does not exist: ${session}`);
    const blocked = explicitCloseBlockReason(inspected, ctx.sessionManager.getSessionId(), await currentTmuxSession());
    if (blocked) throw new Error(`Refusing to close ${session}: ${blocked}.`);
    return terminateSession(session, inspected.classification, reason);
  }

  async function closeLegacySession(session: string, currentSession: string | undefined): Promise<CloseResult> {
    const inspected = await inspectSession(session);
    const blocked = legacyCleanupBlockReason(inspected, Date.now(), LEGACY_MIN_IDLE_MS, currentSession);
    if (blocked) throw new Error(`Refusing to close legacy session ${session}: ${blocked}.`);
    return terminateSession(session, inspected.classification, "legacy cleanup");
  }

  async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(values.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (index < values.length) {
        const current = index++;
        results[current] = await mapper(values[current]!);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function inspectLegacyCleanup(): Promise<{ candidates: InspectedSession[]; protectedSessions: Array<{ session: InspectedSession; reason: string }> }> {
    const sessions = await listSessions();
    const currentSession = await currentTmuxSession();
    const inspected = await mapWithConcurrency(sessions, 8, inspectSession);
    const candidates: InspectedSession[] = [];
    const protectedSessions: Array<{ session: InspectedSession; reason: string }> = [];
    const now = Date.now();
    for (const session of inspected) {
      const reason = legacyCleanupBlockReason(session, now, LEGACY_MIN_IDLE_MS, currentSession);
      if (reason) protectedSessions.push({ session, reason });
      else candidates.push(session);
    }
    return { candidates, protectedSessions };
  }

  function formatCleanupPreview(preview: { candidates: InspectedSession[]; protectedSessions: Array<{ session: InspectedSession; reason: string }> }): string {
    const eligible = preview.candidates.map((item) => item.name).sort();
    const reasonCounts = new Map<string, number>();
    for (const item of preview.protectedSessions) reasonCounts.set(item.reason, (reasonCounts.get(item.reason) ?? 0) + 1);
    const protectedSummary = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${count} · ${reason}`);
    return [
      `Eligible legacy sessions (${eligible.length}):`,
      eligible.length ? eligible.join("\n") : "none",
      "",
      `Preserved sessions (${preview.protectedSessions.length}):`,
      protectedSummary.length ? protectedSummary.join("\n") : "none",
    ].join("\n");
  }

  async function cleanupLegacySessions(ctx: ExtensionContext): Promise<string> {
    const preview = await inspectLegacyCleanup();
    const text = formatCleanupPreview(preview);
    if (preview.candidates.length === 0) return text;
    if (!ctx.hasUI) return `${text}\n\nCleanup was not run because interactive confirmation is unavailable.`;
    const names = preview.candidates.map((item) => item.name).sort();
    const reviewed = await ctx.ui.editor(
      "Legacy cleanup preview — submit to continue or Esc to cancel",
      `${text}\n\nReview only. Editing this text does not change the candidate set.`,
    );
    if (reviewed === undefined) return `Cleanup cancelled during preview; no sessions were closed (${names.length} eligible, ${preview.protectedSessions.length} preserved).`;
    const approved = await ctx.ui.confirm(
      `Close ${names.length} completed legacy Pi sessions?`,
      "The exact candidate list was shown in the preview. Every session will be rechecked before closing. This cannot be undone.",
    );
    if (!approved) return `Cleanup cancelled; no sessions were closed (${names.length} eligible, ${preview.protectedSessions.length} preserved).`;

    const currentSession = await currentTmuxSession();
    const results: CloseResult[] = [];
    const errors: string[] = [];
    for (const name of names) {
      try {
        results.push(await closeLegacySession(name, currentSession));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return `Closed ${results.length} legacy Pi sessions.${errors.length ? `\nPreserved or failed during recheck (${errors.length}):\n${errors.join("\n")}` : ""}`;
  }

  async function pollOne(item: WatchedSession, ctx: ExtensionContext) {
    const exists = await tmux(["has-session", "-t", item.name], 4_000);
    let raw = "";
    let metadata: SessionMetadata = { attached: false, managed: false };
    let settledSignal: string | undefined;
    if (exists.code === 0) {
      const [capture, sessionMetadata, signal] = await Promise.all([
        tmux(["capture-pane", "-p", "-t", item.name, "-S", "-220"], 7_000),
        readSessionMetadata(item.name),
        readSettledSignal(item.name),
      ]);
      raw = capture.stdout;
      metadata = sessionMetadata;
      settledSignal = signal;
    }
    const classification = classifyPane(raw, exists.code === 0);
    item.status = classification.status;
    item.classification = classification;
    item.attached = metadata.attached;
    item.managed = metadata.managed;
    item.owner = metadata.owner;
    item.latestSettledSignal = settledSignal;
    item.settledAt = settledAtFromSignal(settledSignal);
    item.updatedAt = Date.now();

    if (classification.status === "working") {
      item.stableCount = 0;
      item.stableFingerprint = undefined;
    } else if (classification.fingerprint === item.stableFingerprint) {
      item.stableCount++;
    } else {
      item.stableFingerprint = classification.fingerprint;
      item.stableCount = 1;
    }

    item.autoCloseAt = undefined;
    if (item.settledAt) {
      const closeAt = item.settledAt + AUTO_CLOSE_MS;
      const eligibleAtDeadline = automaticCloseBlockReason(
        watchedLifecycle(item),
        ctx.sessionManager.getSessionId(),
        closeAt,
        AUTO_CLOSE_MS,
        supervisorTmuxSession,
      );
      if (!eligibleAtDeadline) item.autoCloseAt = closeAt;
    }

    const now = Date.now();
    if (item.autoCloseAt && now >= item.autoCloseAt && (!item.lastAutoCloseAttempt || now - item.lastAutoCloseAttempt >= 5 * 60_000)) {
      item.lastAutoCloseAttempt = now;
      try {
        const result = await closeManagedSession(item.name, ctx, "automatic");
        if (ctx.hasUI) ctx.ui.notify(result.message, "info");
        return;
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Pi supervisor preserved ${item.name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }

    // Every Pi process publishes a durable tmux pane option from agent_settled.
    // Unlike visual polling, this cannot miss a brief idle state when another
    // extension immediately queues follow-up work after the agent's final reply.
    if (settledSignal && settledSignal !== item.lastSettledSignal) {
      const queued = wakeSupervisor(ctx, item, classification, `settled:${settledSignal}`, "agent settled");
      if (queued) item.lastSettledSignal = settledSignal;
    }

    if ((classification.status === "idle" || classification.status === "dialog" || classification.status === "missing") && item.stableCount >= STABLE_POLLS) {
      wakeSupervisor(ctx, item, classification);
    }
  }

  async function poll() {
    if (polling || watched.size === 0 || !context) return;
    polling = true;
    try {
      await Promise.all([...watched.values()].map((item) => pollOne(item, context!)));
      renderStatus(context);
    } catch (error) {
      if (context.hasUI) context.ui.notify(`Pi supervisor poll failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      polling = false;
    }
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function startTimer() {
    stopTimer();
    if (watched.size === 0) return;
    timer = setInterval(() => void poll(), POLL_MS);
    timer.unref?.();
    void poll();
  }

  async function start(session: string, ctx: ExtensionContext): Promise<string> {
    const sessions = await listSessions();
    if (!sessions.includes(session)) throw new Error(`tmux session not found: ${session}. Available: ${sessions.join(", ") || "none"}`);
    if (!watched.has(session)) watched.set(session, createWatched(session));
    context = ctx;
    persist();
    startTimer();
    renderStatus(ctx);
    return `Supervising ${session}; ${watched.size} session${watched.size === 1 ? "" : "s"} monitored every ${POLL_MS / 1000}s.`;
  }

  function stop(session: string | undefined, ctx: ExtensionContext): string {
    if (session) watched.delete(session);
    else watched.clear();
    persist();
    startTimer();
    renderStatus(ctx);
    return session ? `Stopped supervision of ${session}.` : "Stopped all Pi supervision.";
  }

  async function capture(session?: string): Promise<{ session: string; classification: PaneClassification; text: string }> {
    const target = defaultSession(session);
    const exists = await tmux(["has-session", "-t", target], 4_000);
    if (exists.code !== 0) return { session: target, classification: classifyPane("", false), text: "tmux session does not exist" };
    const result = await tmux(["capture-pane", "-p", "-t", target, "-S", "-220"], 7_000);
    return { session: target, classification: classifyPane(result.stdout), text: result.stdout.slice(-20_000) };
  }

  // Pi's input box is single-line: multiline paste only keeps the last line,
  // so collapse newlines (and whitespace runs) into single spaces.
  function flattenForInput(text: string): string {
    return text.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim();
  }

  async function send(session: string | undefined, text: string): Promise<string> {
    const target = defaultSession(session);
    const message = flattenForInput(text);
    if (!message) throw new Error("Cannot send an empty message");
    const exists = await tmux(["has-session", "-t", target], 4_000);
    if (exists.code !== 0) throw new Error(`tmux session does not exist: ${target}`);

    const dir = await mkdtemp(join(tmpdir(), "pi-supervisor-"));
    const file = join(dir, "message.txt");
    try {
      await writeFile(file, message, { mode: 0o600 });
      const loaded = await tmux(["load-buffer", file]);
      if (loaded.code !== 0) throw new Error(loaded.stderr || "tmux load-buffer failed");
      const pasted = await tmux(["paste-buffer", "-d", "-t", target]);
      if (pasted.code !== 0) throw new Error(pasted.stderr || "tmux paste-buffer failed");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const submitted = await tmux(["send-keys", "-t", target, "Enter"]);
      if (submitted.code !== 0) throw new Error(submitted.stderr || "tmux send-keys failed");
      const item = watched.get(target);
      if (item) {
        item.pendingWake = false;
        item.stableCount = 0;
      }
      return `Sent and submitted ${message.length} characters to ${target}.`;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function markManagedSession(session: string, owner: string) {
    const options: Array<[string, string]> = [
      [MANAGED_OPTION, "1"],
      [OWNER_OPTION, owner],
      [CREATED_OPTION, String(Date.now())],
    ];
    for (const [option, value] of options) {
      const result = await tmux(["set-option", "-t", session, option, value], 4_000);
      if (result.code !== 0) throw new Error(result.stderr || `Could not set ${option} on ${session}`);
    }
  }

  function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  async function spawn(model: string, ctx: ExtensionContext, name?: string, dir?: string, provider?: string, thinking?: string): Promise<string> {
    if (!model.trim()) throw new Error("A model is required, e.g. -m gpt-5.6-luna or -m provider/id");
    const sessions = await listSessions();
    const session = name?.trim() || `pi-${model.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    if (sessions.includes(session)) throw new Error(`tmux session already exists: ${session}`);
    const cwd = dir?.trim() || ctx.cwd;
    const flags = ["--model", model, "--name", session];
    if (provider?.trim()) flags.push("--provider", provider.trim());
    if (thinking?.trim()) flags.push("--thinking", thinking.trim());
    const shell = `pi ${flags.map(shellQuote).join(" ")}`;
    const created = await tmux(["new-session", "-d", "-s", session, "-c", cwd, shell], 10_000);
    if (created.code !== 0) throw new Error(created.stderr || "tmux new-session failed");
    await markManagedSession(session, ctx.sessionManager.getSessionId());
    if (!watched.has(session)) watched.set(session, createWatched(session));
    const item = watched.get(session)!;
    item.managed = true;
    item.owner = ctx.sessionManager.getSessionId();
    context = ctx;
    persist();
    startTimer();
    renderStatus(ctx);
    return `Spawned managed Pi tmux session '${session}' (model ${model}${provider ? `, provider ${provider}` : ""}${thinking ? `, thinking ${thinking}` : ""}, cwd ${cwd}) and started supervising it. Completed clean-idle sessions auto-close after ${AUTO_CLOSE_MS / 60_000} minutes.`;
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    supervisorTmuxSession = await currentTmuxSession();
    let restored: string[] = [];
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const data = entry.data as { sessions?: string[]; enabled?: boolean; session?: string };
      restored = Array.isArray(data.sessions) ? data.sessions : data.enabled && data.session ? [data.session] : [];
    }
    watched.clear();
    for (const name of restored) watched.set(name, createWatched(name));
    startTimer();
    renderStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    context = ctx;
    for (const item of watched.values()) item.pendingWake = false;
    try {
      await publishSettledSignal(ctx);
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Pi supervisor could not publish completion: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("session_shutdown", () => {
    stopTimer();
    context = undefined;
    supervisorTmuxSession = undefined;
  });

  pi.registerCommand("pi-supervise", {
    description: "Start/status/close/cleanup/stop autonomous supervision of Pi tmux sessions",
    handler: async (args, ctx) => {
      const values = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (values[0] === "stop") {
          ctx.ui.notify(stop(values[1], ctx), "info");
          return;
        }
        if (values[0] === "close") {
          const session = defaultSession(values[1]);
          const result = await closeManagedSession(session, ctx, "validated");
          renderStatus(ctx);
          ctx.ui.notify(result.message, "info");
          return;
        }
        if (values[0] === "cleanup") {
          const result = await cleanupLegacySessions(ctx);
          renderStatus(ctx);
          ctx.ui.notify(result, "info");
          return;
        }
        if (values[0] === "status") {
          const summary = [...watched.values()].map((item) => {
            const lifecycle = item.classification?.unresolvedFailure
              ? "preserved: failure"
              : item.autoCloseAt
                ? `auto-close ${Math.max(0, Math.ceil((item.autoCloseAt - Date.now()) / 60_000))}m`
                : item.managed
                  ? "managed"
                  : "unmanaged";
            return `${item.name}: ${item.status} (${lifecycle})`;
          }).join(" · ") || "No supervised sessions";
          ctx.ui.notify(summary, "info");
          return;
        }
        let session = values[0];
        if (!session) {
          const sessions = (await listSessions()).filter((name) => !watched.has(name));
          if (sessions.length === 0) {
            ctx.ui.notify("No unsupervised tmux sessions found", "warning");
            return;
          }
          session = sessions.length === 1 ? sessions[0]! : (await ctx.ui.select("Add Pi tmux session", sessions)) ?? "";
          if (!session) return;
        }
        ctx.ui.notify(await start(session, ctx), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("pi-send", {
    description: "Send text to a supervised Pi tmux session; use '<session> :: <message>' when supervising multiple",
    handler: async (args, ctx) => {
      try {
        const raw = args.trim() || (await ctx.ui.editor("Message to Pi", ""))?.trim();
        if (!raw) return;
        const separator = raw.indexOf(" :: ");
        const session = separator >= 0 ? raw.slice(0, separator).trim() : undefined;
        const text = separator >= 0 ? raw.slice(separator + 4).trim() : raw;
        ctx.ui.notify(await send(session, text), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("pi-spawn", {
    description: "Spawn a new Pi tmux session with a given model and supervise it; usage: /pi-spawn -m <model> [-n <name>] [-d <dir>] [-p <provider>] [-t <thinking>]",
    handler: async (args, ctx) => {
      try {
        const argv = args.trim().split(/\s+/).filter(Boolean);
        const read = (flag: string) => {
          const index = argv.indexOf(flag);
          return index >= 0 ? argv[index + 1] : undefined;
        };
        const model = read("-m") || read("--model");
        if (!model) throw new Error("Usage: /pi-spawn -m <model> [-n <name>] [-d <dir>] [-p <provider>] [-t <thinking>]");
        const name = read("-n") || read("--name");
        const dir = read("-d") || read("--dir");
        const provider = read("-p") || read("--provider");
        const thinking = read("-t") || read("--thinking");
        ctx.ui.notify(await spawn(model, ctx, name, dir, provider, thinking), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "pi_supervisor",
    label: "Pi Supervisor",
    description:
      "Manage and inspect multiple interactive Pi coding-agent tmux sessions. Start autonomous monitoring, spawn agents, capture panes, send responses, close validated managed sessions, preview legacy cleanup, list statuses, or stop monitors. Output is capped at 20KB.",
    promptSnippet: "Supervise multiple interactive Pi coding-agent sessions running in tmux",
    promptGuidelines: [
      "Use pi_supervisor to inspect and respond whenever a Pi Supervisor event appears; continue routine supervision autonomously across all monitored sessions.",
      "After validating that a managed supervised Pi completed successfully and no follow-up is needed, use pi_supervisor close so its tmux session does not leak.",
      "Never close sessions that are working, attached, waiting at a dialog, or showing an unresolved failure; pi_supervisor also enforces these checks.",
      "Never use pi_supervisor send to approve destructive, deployment, production, credential, or security-sensitive actions without explicit user approval.",
      "Pi's input box is single-line: pi_supervisor send flattens newlines to spaces, so phrase messages accordingly.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "start", "status", "capture", "send", "close", "cleanup", "stop", "spawn"] as const),
      session: Type.Optional(Type.String({ description: "tmux session name; required for capture/send/close when multiple sessions are watched; stop without it stops all" })),
      text: Type.Optional(Type.String({ description: "Text to send when action is send" })),
      model: Type.Optional(Type.String({ description: "Model pattern for action spawn, e.g. gpt-5.6-luna or provider/id" })),
      name: Type.Optional(Type.String({ description: "tmux session name for action spawn (defaults to pi-<model>)" })),
      dir: Type.Optional(Type.String({ description: "Working directory for action spawn (defaults to the current directory)" })),
      provider: Type.Optional(Type.String({ description: "Provider name for action spawn, e.g. anthropic or openai" })),
      thinking: Type.Optional(Type.String({ description: "Thinking level for action spawn: off, minimal, low, medium, high, xhigh, max" })),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: `${params.action}…` }], details: { action: params.action } });
      switch (params.action) {
        case "list": {
          const sessions = await listSessions();
          const rows: string[] = [];
          for (const name of sessions) {
            const item = watched.get(name);
            const prefix = item ? "●" : "○";
            let marker = item ? ` (${item.status})` : "";
            if (!item) {
              const probe = await tmux(["capture-pane", "-p", "-t", name, "-S", "-40"], 5_000);
              if (probe.code === 0 && classifyPane(probe.stdout).piLike) marker = " (pi?)";
            }
            rows.push(`${prefix} ${name}${marker}`);
          }
          return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "No tmux sessions found" }], details: { sessions, watched: [...watched.keys()] } };
        }
        case "start": {
          let session = params.session;
          if (!session) {
            const candidates = (await listSessions()).filter((name) => !watched.has(name));
            if (candidates.length !== 1) throw new Error("Specify a tmux session name");
            session = candidates[0];
          }
          const message = await start(session, ctx);
          return { content: [{ type: "text", text: message }], details: { session, watched: [...watched.keys()] } };
        }
        case "status": {
          const rows = [...watched.values()].map((item) => {
            const flags = [
              item.managed ? "managed" : "unmanaged",
              item.attached ? "attached" : undefined,
              item.classification?.question ? "question likely" : undefined,
              item.classification?.unresolvedFailure ? "failure preserved" : undefined,
              item.autoCloseAt ? `auto-close in ${Math.max(0, Math.ceil((item.autoCloseAt - Date.now()) / 60_000))}m` : undefined,
            ].filter(Boolean);
            return `${item.name}: ${item.status}${flags.length ? ` (${flags.join(", ")})` : ""}`;
          });
          return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "No supervised sessions" }], details: { sessions: [...watched.values()].map((item) => ({ name: item.name, status: item.status, managed: item.managed, attached: item.attached, autoCloseAt: item.autoCloseAt })) } };
        }
        case "capture": {
          const result = await capture(params.session);
          return { content: [{ type: "text", text: `${result.session}: ${result.classification.status}\n\n${result.text}` }], details: result.classification };
        }
        case "send": {
          if (!params.text) throw new Error("text is required for send");
          const message = await send(params.session, params.text);
          return { content: [{ type: "text", text: message }], details: { session: params.session, length: params.text.length } };
        }
        case "close": {
          const session = defaultSession(params.session);
          const result = await closeManagedSession(session, ctx, "validated");
          renderStatus(ctx);
          return { content: [{ type: "text", text: result.message }], details: { session, excerpt: result.excerpt, watched: [...watched.keys()] } };
        }
        case "cleanup": {
          const preview = await inspectLegacyCleanup();
          const text = `${formatCleanupPreview(preview)}\n\nPreview only. Run /pi-supervise cleanup for interactive confirmation.`;
          return { content: [{ type: "text", text: text.slice(0, 20_000) }], details: { candidates: preview.candidates.map((item) => item.name), protected: preview.protectedSessions.length, dryRun: true } };
        }
        case "spawn": {
          if (!params.model) throw new Error("model is required for spawn");
          const message = await spawn(params.model, ctx, params.name, params.dir, params.provider, params.thinking);
          return { content: [{ type: "text", text: message }], details: { model: params.model, session: params.name ?? `pi-${params.model}`, watched: [...watched.keys()] } };
        }
        case "stop": {
          const message = stop(params.session, ctx);
          return { content: [{ type: "text", text: message }], details: { stopped: params.session ?? "all", watched: [...watched.keys()] } };
        }
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("pi_supervisor ")) + theme.fg("muted", args.action) + (args.session ? ` ${theme.fg("accent", args.session)}` : ""), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content.find((item) => item.type === "text");
      const value = text?.type === "text" ? text.text : "";
      return new Text(theme.fg("success", "✓ ") + theme.fg("dim", value.split("\n")[0] ?? "done"), 0, 0);
    },
  });
}
