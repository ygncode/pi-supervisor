import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { classifyPane, type PiPaneStatus, type PaneClassification } from "./classifier";

const POLL_MS = 5_000;
const STABLE_POLLS = 2;
const ENTRY_TYPE = "pi-supervisor-state";
const STATUS_KEY = "pi-supervisor";
const WIDGET_KEY = "pi-supervisor";
const SETTLED_OPTION = "@pi_agent_settled";

type WatchedSession = {
  name: string;
  status: PiPaneStatus;
  classification?: PaneClassification;
  lastNotified?: string;
  stableFingerprint?: string;
  stableCount: number;
  pendingWake: boolean;
  lastSettledSignal?: string;
  updatedAt?: number;
};

const createWatched = (name: string): WatchedSession => ({
  name,
  status: "missing",
  stableCount: 0,
  pendingWake: false,
});

export default function piSupervisor(pi: ExtensionAPI) {
  const watched = new Map<string, WatchedSession>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let context: ExtensionContext | undefined;

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
        const itemColor = item.status === "working" ? "accent" : item.status === "dialog" ? "warning" : item.status === "idle" ? "success" : "error";
        const symbol = item.status === "working" ? "●" : item.status === "dialog" ? "!" : item.status === "idle" ? "◆" : "×";
        const age = item.updatedAt ? `${Math.max(0, Math.floor((Date.now() - item.updatedAt) / 1000))}s` : "waiting";
        lines.push(theme.fg(itemColor, `${symbol} ${item.name}`) + theme.fg("dim", ` · ${item.status} · ${age}`));
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
    stateLabel = classification.status,
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

  async function publishSettledSignal(ctx: ExtensionContext) {
    const pane = process.env.TMUX_PANE;
    if (!pane) return;
    const token = `${Date.now()}:${ctx.sessionManager.getLeafId() ?? "none"}`;
    await tmux(["set-option", "-p", "-t", pane, SETTLED_OPTION, token], 4_000);
  }

  async function pollOne(item: WatchedSession, ctx: ExtensionContext) {
    const exists = await tmux(["has-session", "-t", item.name], 4_000);
    let raw = "";
    if (exists.code === 0) {
      const capture = await tmux(["capture-pane", "-p", "-t", item.name, "-S", "-220"], 7_000);
      raw = capture.stdout;
    }
    const classification = classifyPane(raw, exists.code === 0);
    item.status = classification.status;
    item.classification = classification;
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

    // Every Pi process publishes a durable tmux pane option from agent_settled.
    // Unlike visual polling, this cannot miss a brief idle state when another
    // extension immediately queues follow-up work after the agent's final reply.
    const settledSignal = exists.code === 0 ? await readSettledSignal(item.name) : undefined;
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

  async function spawn(model: string, ctx: ExtensionContext, name?: string, dir?: string, provider?: string, thinking?: string): Promise<string> {
    if (!model.trim()) throw new Error("A model is required, e.g. -m gpt-5.6-luna or -m provider/id");
    const sessions = await listSessions();
    const session = name?.trim() || `pi-${model.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    if (sessions.includes(session)) throw new Error(`tmux session already exists: ${session}`);
    const cwd = dir?.trim() || process.cwd();
    const flags = [`--model`, model.replace(/'/g, ""), `--name`, session.replace(/'/g, "")];
    if (provider?.trim()) flags.push("--provider", provider.trim());
    if (thinking?.trim()) flags.push("--thinking", thinking.trim());
    const shell = `pi ${flags.map((flag) => `'${flag}'`).join(" ")}`;
    const created = await tmux(["new-session", "-d", "-s", session, "-c", cwd, shell], 10_000);
    if (created.code !== 0) throw new Error(created.stderr || "tmux new-session failed");
    if (!watched.has(session)) watched.set(session, createWatched(session));
    context = ctx;
    persist();
    startTimer();
    renderStatus(ctx);
    return `Spawned Pi tmux session '${session}' (model ${model}${provider ? `, provider ${provider}` : ""}${thinking ? `, thinking ${thinking}` : ""}, cwd ${cwd}) and started supervising it.`;
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
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
  });

  pi.registerCommand("pi-supervise", {
    description: "Start/status/stop autonomous supervision of one or more Pi tmux sessions",
    handler: async (args, ctx) => {
      const values = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (values[0] === "stop") {
          ctx.ui.notify(stop(values[1], ctx), "info");
          return;
        }
        if (values[0] === "status") {
          const summary = [...watched.values()].map((item) => `${item.name}: ${item.status}`).join(" · ") || "No supervised sessions";
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
      "Manage and inspect multiple interactive Pi coding-agent tmux sessions. Start autonomous monitoring, spawn new Pi sessions with different models, capture a pane, send a response, list sessions, get all statuses, or stop one/all monitors. Output is capped at 20KB.",
    promptSnippet: "Supervise multiple interactive Pi coding-agent sessions running in tmux",
    promptGuidelines: [
      "Use pi_supervisor to inspect and respond whenever a Pi Supervisor event appears; continue routine supervision autonomously across all monitored sessions.",
      "Never use pi_supervisor send to approve destructive, deployment, production, credential, or security-sensitive actions without explicit user approval.",
      "Pi's input box is single-line: pi_supervisor send flattens newlines to spaces, so phrase messages accordingly.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "start", "status", "capture", "send", "stop", "spawn"] as const),
      session: Type.Optional(Type.String({ description: "tmux session name; required for capture/send when multiple sessions are watched; stop without it stops all" })),
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
          const rows = [...watched.values()].map((item) => `${item.name}: ${item.status}${item.classification?.question ? " (question likely)" : ""}`);
          return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "No supervised sessions" }], details: { sessions: [...watched.values()].map((item) => ({ name: item.name, status: item.status })) } };
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
