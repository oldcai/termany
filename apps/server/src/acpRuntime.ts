import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ActiveSession,
  type ClientConnection,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { findAgentConfig, type AgentConfig } from "./agentConfig.js";
import { overriddenCredentials, subscriptionEnvironment } from "./agentCredentials.js";
import { getMeta, setMeta } from "./db.js";
import { resolveExecutable, spawnEnvironment } from "./shellPath.js";

export type AcpRuntimeEvent =
  | { type: "delta"; text: string }
  | { type: "thought"; text: string }
  | { type: "activity"; title: string; status?: string }
  | { type: "tool"; id: string; title?: string; status?: string; input?: string; output?: string }
  | { type: "permission"; requestId: string; title: string; options: PermissionOption[] }
  | { type: "done"; sessionId: string };

type Emit = (event: AcpRuntimeEvent) => void;

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) args.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote in runtime arguments");
  if (current) args.push(current);
  return args;
}

async function executablePath(command: string): Promise<string> {
  const found = await resolveExecutable(command);
  if (found) return found;
  throw new Error(`Agent runtime command not found: ${command}`);
}

/** Flatten a select's values; ACP allows either a plain list or grouped lists. */
function selectValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "group" in entry ? entry.options.map((child) => child.value) : [entry.value]
  );
}

function textFromUpdate(update: SessionUpdate): string | undefined {
  if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return;
  const content = update.content;
  return content.type === "text" ? content.text : undefined;
}

/** Keep tool detail blobs bounded — they persist with the conversation. */
const TOOL_DETAIL_LIMIT = 10_000;

function clipDetail(text: string): string | undefined {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed.trim()) return undefined;
  return trimmed.length > TOOL_DETAIL_LIMIT ? `${trimmed.slice(0, TOOL_DETAIL_LIMIT)}…` : trimmed;
}

/** Shell-style tools show their command as `$ …`; anything else pretty JSON. */
function formatToolInput(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const command = (raw as { command?: unknown }).command;
  if (typeof command === "string" && command.trim()) return clipDetail(`$ ${command}`);
  try {
    return clipDetail(JSON.stringify(raw, null, 2));
  } catch {
    return undefined;
  }
}

function formatToolOutput(content: unknown, rawOutput: unknown): string | undefined {
  const items = Array.isArray(content) ? content : [];
  const chunks = items
    .map((item: { type?: string; content?: { type?: string; text?: string } }) =>
      item?.type === "content" && item.content?.type === "text" ? item.content.text ?? "" : ""
    )
    .filter(Boolean);
  if (chunks.length) return clipDetail(chunks.join("\n"));
  if (rawOutput == null) return undefined;
  if (typeof rawOutput === "string") return clipDetail(rawOutput);
  try {
    return clipDetail(JSON.stringify(rawOutput, null, 2));
  } catch {
    return undefined;
  }
}

/**
 * Extra environment for a pane's ACP agent, injected by index.ts.
 *
 * The pane-control token registry lives with the server that answers control
 * calls; this module only needs to hand whatever it produces to the child. A
 * provider rather than an import keeps that one-way — acpRuntime has no business
 * knowing how identity is minted.
 */
let controlEnvFor: (paneId: string) => Record<string, string> = () => ({});

export function setControlEnvProvider(fn: (paneId: string) => Record<string, string>): void {
  controlEnvFor = fn;
}

class Runtime {
  private emit: Emit | null = null;
  private prompting = false;
  private stderr = "";
  /** Model/mode/effort selectors the agent offers for this session, with their
   *  current values. Refreshed from every reply the agent sends about them —
   *  it can change them on its own (a slash command, a fallback), and a stale
   *  copy would show the user a model that is not the one answering. */
  private configOptions: SessionConfigOption[];
  private pendingPermissions = new Map<
    string,
    { resolve: (response: RequestPermissionResponse) => void; options: PermissionOption[] }
  >();

  private constructor(
    readonly paneId: string,
    readonly agent: AgentConfig,
    readonly cwd: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: ClientConnection,
    private readonly session: ActiveSession
  ) {
    this.configOptions = session.newSessionResponse.configOptions ?? [];
    rememberConfig(agent.id, this.configOptions);
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-8_000);
    });
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      this.connection.close(new Error(`Agent runtime exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
      this.cancelPermissions();
      runtimes.delete(paneId);
    });
  }

  static async create(paneId: string, agent: AgentConfig, cwd: string): Promise<Runtime> {
    const spec = agent.runtime;
    if (!spec || spec.protocol !== "acp") throw new Error(`${agent.name} has no ACP runtime configured`);
    if (spec.distribution === "managed") {
      throw new Error(`The managed ${agent.name} runtime is not installed yet; switch its installation to System or Custom`);
    }
    if (spec.modelSource === "termany") {
      throw new Error("Termany model routing for ACP runtimes is not available yet; choose Agent-managed models");
    }

    const command = await executablePath(spec.command);
    // Adapters shell out to node/npx and the agent CLI itself, so they need the
    // login PATH rather than the bundle's launchd-inherited one — but not the
    // API keys a shell profile may also export. See agentCredentials.ts.
    // Plus the pane's control identity, so an ACP agent can address panes on the
    // same footing as an agent the user started in a terminal — per-session and
    // per-pane, nothing written to disk.
    const env = { ...subscriptionEnvironment(await spawnEnvironment(), agent), ...controlEnvFor(paneId) };
    const dropped = overriddenCredentials(agent).filter((name) => name in process.env);
    if (dropped.length) {
      console.log(`[termany] ${agent.name}: using its own login, ignoring ${dropped.join(", ")}`);
    }
    const child = spawn(command, splitArgs(spec.args), {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let runtime!: Runtime;
    const app = client({ name: "Termany" }).onRequest(
      methods.client.session.requestPermission,
      ({ params }) => runtime.requestPermission(params)
    );
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );
    const connection = app.connect(stream);
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "Termany", version: "0.1.21" },
      });
      const session = await connection.agent.buildSession(cwd).start();
      runtime = new Runtime(paneId, agent, cwd, child, connection, session);
      return runtime;
    } catch (error) {
      connection.close(error);
      child.kill();
      const detail = runtime?.stderr?.trim();
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `: ${detail}` : ""}`);
    }
  }

  async prompt(text: string, emit: Emit, signal: AbortSignal): Promise<void> {
    if (this.prompting) throw new Error("This agent is already responding");
    this.prompting = true;
    this.emit = emit;
    const cancel = () => void this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.session.sessionId });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      void this.session.prompt(text).catch(() => undefined);
      while (true) {
        const message = await this.session.nextUpdate();
        if (message.kind === "stop") break;
        const update = message.update;
        const textChunk = textFromUpdate(update);
        if (textChunk) {
          emit({ type: update.sessionUpdate === "agent_thought_chunk" ? "thought" : "delta", text: textChunk });
        } else if (update.sessionUpdate === "config_option_update") {
          this.configOptions = update.configOptions;
          rememberConfig(this.agent.id, this.configOptions);
        } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          // tool_call_update carries only changed fields; the client merges by id.
          emit({
            type: "tool",
            id: update.toolCallId,
            title: update.title ?? undefined,
            status: update.status ?? undefined,
            input: formatToolInput(update.rawInput),
            output: formatToolOutput(update.content, update.rawOutput),
          });
        }
      }
      emit({ type: "done", sessionId: this.session.sessionId });
    } finally {
      signal.removeEventListener("abort", cancel);
      this.emit = null;
      this.prompting = false;
      if (signal.aborted) this.cancelPermissions();
    }
  }

  get config(): SessionConfigOption[] {
    return this.configOptions;
  }

  /** Set one selector, returning the agent's own view of every option after. */
  async setConfigOption(configId: string, value: string): Promise<SessionConfigOption[]> {
    const option = this.configOptions.find((entry) => entry.id === configId);
    if (!option) throw new Error(`${this.agent.name} has no "${configId}" option in this session`);
    const response = await this.connection.agent.request(methods.agent.session.setConfigOption, {
      sessionId: this.session.sessionId,
      configId,
      ...(option.type === "boolean" ? { type: "boolean" as const, value: value === "true" } : { value }),
    });
    this.configOptions = response.configOptions;
    rememberConfig(this.agent.id, this.configOptions);
    return this.configOptions;
  }

  /**
   * Re-apply the picks a pane remembers. Sessions are per-process and start on
   * the agent's own defaults, so without this a restart — switching folders,
   * relaunching the app, a crashed adapter — would silently drop back to the
   * default model mid-conversation.
   *
   * Values the agent no longer offers are skipped rather than failing the whole
   * turn: model line-ups change under us between releases.
   */
  async applyConfig(picks: Record<string, string>): Promise<void> {
    for (const [configId, value] of Object.entries(picks)) {
      const option = this.configOptions.find((entry) => entry.id === configId);
      if (!option || option.currentValue === value) continue;
      if (option.type === "select" && !selectValues(option).includes(value)) continue;
      try {
        await this.setConfigOption(configId, value);
      } catch (error) {
        console.log(
          `[termany] ${this.agent.name}: could not restore ${configId}=${value}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  respondPermission(requestId: string, optionId: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending || !pending.options.some((option) => option.optionId === optionId)) return false;
    this.pendingPermissions.delete(requestId);
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    return true;
  }

  close(): void {
    this.cancelPermissions();
    this.session.dispose();
    this.connection.close();
    this.child.kill();
  }

  private requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.emit) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const requestId = randomUUID();
    this.emit({
      type: "permission",
      requestId,
      title: params.toolCall.title || "Allow this action?",
      options: params.options,
    });
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { resolve, options: params.options });
    });
  }

  private cancelPermissions(): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
  }
}

const runtimes = new Map<string, Runtime>();

/**
 * Last selector list each agent reported, kept in SQLite so it also survives a
 * relaunch — the first dropdown of the day is the one most worth being quick.
 * Only ever a display shortcut: nothing is *applied* from here, and a live
 * session always answers for itself.
 */
const CONFIG_CACHE_KEY = "acpConfigOptions";

function configCache(): Record<string, SessionConfigOption[]> {
  try {
    const parsed = JSON.parse(getMeta(CONFIG_CACHE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function cachedConfig(agentId: string): SessionConfigOption[] | null {
  const options = configCache()[agentId];
  return Array.isArray(options) && options.length ? options : null;
}

function rememberConfig(agentId: string, options: SessionConfigOption[]): void {
  if (!options.length) return;
  try {
    setMeta(CONFIG_CACHE_KEY, JSON.stringify({ ...configCache(), [agentId]: options }));
  } catch {
    // A cache that can't be written just means the next menu waits again.
  }
}

export interface AcpRuntimeTarget {
  paneId: string;
  agentId: string;
  cwd: string;
  /** True when the user picked the folder explicitly. Only then does a cwd
   *  mismatch restart the session — the inherited terminal cwd drifts as the
   *  user `cd`s around, and that must never kill a live conversation. */
  cwdExplicit?: boolean;
  /** The pane's remembered selector picks, keyed by config id. Re-applied to
   *  every session this pane starts. */
  config?: Record<string, string>;
}

/**
 * The pane's live session, started if it has none.
 *
 * Both the chat stream and the selector menu come through here so they can
 * never disagree about which session a pane owns: resolve the cwd differently
 * in one of them and the menu would configure a session the next prompt then
 * throws away.
 */
async function acquire(input: AcpRuntimeTarget): Promise<Runtime> {
  let runtime = runtimes.get(input.paneId);
  if (runtime && (runtime.agent.id !== input.agentId || (input.cwdExplicit && runtime.cwd !== input.cwd))) {
    runtime.close();
    runtimes.delete(input.paneId);
    runtime = undefined;
  }
  if (runtime) return runtime;
  const agent = findAgentConfig(input.agentId);
  if (!agent || !agent.enabled) throw new Error("Agent runtime is missing or disabled");
  runtime = await Runtime.create(input.paneId, agent, input.cwd || os.homedir());
  runtimes.set(input.paneId, runtime);
  if (input.config) await runtime.applyConfig(input.config);
  return runtime;
}

/**
 * Report the selectors an agent offers, preferring not to start it.
 *
 * Starting an adapter to ask what models it has costs 2–3s (npx resolves the
 * package, the agent CLI boots, then `session/new`), and a dropdown that takes
 * three seconds to fill is a dropdown people stop opening. What it would answer
 * barely changes between runs, so the last answer is remembered and served
 * immediately; the agent starts for real when there is something to say to it.
 *
 * The pane's own picks are layered on top, because a remembered list carries
 * whichever values were current in *some* past session, not this pane's.
 */
export function acpRuntimeConfig(input: AcpRuntimeTarget): SessionConfigOption[] | null {
  const live = runtimes.get(input.paneId);
  if (live && live.agent.id === input.agentId) return live.config;
  const cached = cachedConfig(input.agentId);
  return cached && withPicks(cached, input.config ?? {});
}

/** Start the agent and ask it directly — for when the cache has no answer. */
export async function loadAcpRuntimeConfig(input: AcpRuntimeTarget): Promise<SessionConfigOption[]> {
  return (await acquire(input)).config;
}

/**
 * Change one selector.
 *
 * With no session yet there is nothing to change: the pick is the caller's to
 * remember, and acquire() replays it the moment a session does start. Starting
 * an agent here would make choosing a model — the one thing a user does *before*
 * talking to it — the slowest step in the pane.
 */
export async function setAcpConfigOption(
  input: AcpRuntimeTarget & { configId: string; value: string }
): Promise<SessionConfigOption[]> {
  const live = runtimes.get(input.paneId);
  if (live && live.agent.id === input.agentId) return live.setConfigOption(input.configId, input.value);
  const cached = cachedConfig(input.agentId);
  if (!cached) return (await acquire(input)).setConfigOption(input.configId, input.value);
  return withPicks(cached, { ...input.config, [input.configId]: input.value });
}

/** Overlay remembered picks onto a cached list's current values. */
function withPicks(options: SessionConfigOption[], picks: Record<string, string>): SessionConfigOption[] {
  return options.map((option) => {
    const pick = picks[option.id];
    if (pick === undefined || option.type !== "select" || !selectValues(option).includes(pick)) return option;
    return { ...option, currentValue: pick };
  });
}

export async function promptAcpRuntime(
  input: AcpRuntimeTarget & { prompt: string; signal: AbortSignal; emit: Emit }
): Promise<void> {
  input.emit({ type: "activity", title: "Starting agent", status: input.agentId });
  const runtime = await acquire(input);
  input.emit({ type: "activity", title: runtime.agent.name, status: "Thinking" });
  await runtime.prompt(input.prompt, input.emit, input.signal);
}

/** The folder a pane's live ACP session is actually bound to, if one exists. */
export function acpRuntimeCwd(paneId: string): string | undefined {
  return runtimes.get(paneId)?.cwd;
}

export function respondAcpPermission(paneId: string, requestId: string, optionId: string): boolean {
  return runtimes.get(paneId)?.respondPermission(requestId, optionId) ?? false;
}

export function closeAcpRuntimes(paneIds: string[]): void {
  for (const paneId of paneIds) {
    runtimes.get(paneId)?.close();
    runtimes.delete(paneId);
  }
}

export function closeAllAcpRuntimes(): void {
  closeAcpRuntimes([...runtimes.keys()]);
}
