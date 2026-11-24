// Still's side chat engine: talks to coding agents so you can ask them to use
// the page you are on. Two kinds of connection, behind one small interface:
//
// - Direct (Agent Client Protocol, https://agentclientprotocol.com): Still
//   starts the agent itself on stdio and streams its replies, tool steps,
//   plans and permission questions. Any ACP agent works; Codex and Claude
//   Code come with Still (`still acp codex|claude`, pinned adapters in
//   firefox/agent/), and others are added with the pref still.chat.agents.
//   Each session is given Still's own MCP server, so the agent can see and
//   act on your pages with your sign-ins (StillAgent.sys.mjs).
// - T3 Code: the chat becomes a T3 thread (`t3 thread start/send/show`), so
//   it also shows in T3 with its history, provider and model.
//
// The window layer (still-chat.js) renders events from both the same way.

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs"
});

const PROTOCOL_VERSION = 1;
const PREF_AGENTS = "still.chat.agents";

// Built-in agents. `command` is looked up on PATH ("still" is Still's own
// launcher, ~/.local/bin/still, which runs the pinned adapters).
// `requires` is the harness's own command: an agent shows only when it is
// installed. Gemini CLI, OpenCode and Qwen Code speak ACP themselves and
// appear as soon as they are installed.
const BUILT_IN = [
  { id: "codex", name: "Codex", kind: "acp", command: "still", args: ["acp", "codex"], login: "codex login", requires: "codex" },
  { id: "claude", name: "Claude Code", kind: "acp", command: "still", args: ["acp", "claude"], login: "claude, then /login", requires: "claude" },
  { id: "t3", name: "T3 Code", kind: "t3", command: "t3", requires: "t3" },
  { id: "gemini", name: "Gemini CLI", kind: "acp", command: "gemini", args: ["--experimental-acp"], requires: "gemini", optional: true },
  { id: "opencode", name: "OpenCode", kind: "acp", command: "opencode", args: ["acp"], requires: "opencode", optional: true },
  { id: "qwen", name: "Qwen Code", kind: "acp", command: "qwen", args: ["--experimental-acp"], requires: "qwen", optional: true }
];

function searchDirs() {
  const path = Services.env.get("PATH") || "";
  return [...path.split(":"), PathUtils.join(home(), ".local", "bin"), PathUtils.join(home(), ".t3", "bin"), "/usr/local/bin", "/usr/bin"].filter(Boolean);
}

// Quick, synchronous: is this command on the computer?
function commandExists(name) {
  for (const dir of searchDirs()) {
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(PathUtils.join(dir, name));
      if (file.exists()) return true;
    } catch {}
  }
  return false;
}

function home() {
  return Services.dirsvc.get("Home", Ci.nsIFile).path;
}

// Extra ACP agents: [{ "id": "gemini", "name": "Gemini CLI", "command": "gemini", "args": ["--experimental-acp"] }]
export function chatAgents() {
  let extra = [];
  try { extra = JSON.parse(Services.prefs.getStringPref(PREF_AGENTS, "[]")); } catch {}
  const custom = (Array.isArray(extra) ? extra : [])
    .filter((agent) => agent?.id && (agent.kind === "openai" ? /^https?:\/\//.test(agent.endpoint || "") : agent?.command))
    .map((agent) => ({ kind: "acp", args: [], ...agent, name: agent.name || agent.id }));
  const installed = BUILT_IN.filter((agent) => !agent.requires || commandExists(agent.requires));
  return [...installed, ...custom.filter((agent) => !BUILT_IN.some((built) => built.id === agent.id))];
}

async function findCommand(name) {
  if (name.includes("/")) return name;
  for (const dir of searchDirs()) {
    if (!dir) continue;
    const candidate = PathUtils.join(dir, name);
    try { if (await IOUtils.exists(candidate)) return candidate; } catch {}
  }
  throw Object.assign(new Error(`${name} was not found on this computer`), { code: "missing" });
}

async function chatDir() {
  const dir = PathUtils.join(home(), ".local", "share", "still", "chat");
  await IOUtils.makeDirectory(dir, { createAncestors: true, permissions: 0o700 });
  return dir;
}

// A Still started with its own agent folder (tests, a second profile) tells
// the agent's tools to use it, so they reach this Still and no other.
function agentDirEnv() {
  const dir = Services.prefs.getStringPref("still.agent.dir", "");
  return dir ? { STILL_AGENT_DIR: dir } : {};
}

function textOf(error) {
  return error?.message || String(error);
}

// ------------------------------------------------------------------ ACP

// JSON-RPC 2.0 over a child process's stdio, one message per line.
class RpcProcess {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = () => {};
    this.onRequest = async () => { throw new Error("Not supported"); };
    this.onExit = () => {};
    this.stderr = "";
    this.closed = false;
    this.read();
    this.readErrors();
    proc.wait().then(({ exitCode }) => this.exited(exitCode), () => this.exited(-1));
  }

  async read() {
    let buffer = "";
    try {
      for (;;) {
        const chunk = await this.proc.stdout.readString();
        if (!chunk) break;
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.receive(line);
        }
      }
    } catch {}
  }

  async readErrors() {
    try {
      for (;;) {
        const chunk = await this.proc.stderr.readString();
        if (!chunk) break;
        // Keep the tail, for error messages.
        this.stderr = (this.stderr + chunk).slice(-4000);
      }
    } catch {}
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      Promise.resolve()
        .then(() => this.onRequest(message.method, message.params || {}))
        .then((result) => this.write({ jsonrpc: "2.0", id: message.id, result: result ?? null }),
          (error) => this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: textOf(error) } }));
    } else if (message.method) {
      try { this.onNotification(message.method, message.params || {}); } catch (error) { console.error(error); }
    } else if (this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(Object.assign(new Error(message.error.message || "The agent reported an error"), { code: message.error.code, data: message.error.data }));
      else resolve(message.result);
    }
  }

  write(message) {
    if (this.closed) return;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`).catch(() => {});
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error("The agent has stopped"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  exited(code) {
    if (this.closed) return;
    this.closed = true;
    const tail = this.stderr.trim().split("\n").slice(-3).join("\n");
    const error = new Error(tail ? `The agent stopped (${code}): ${tail}` : `The agent stopped (${code})`);
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.onExit(code, tail);
  }

  kill() {
    if (this.closed) return;
    try { this.proc.kill(); } catch {}
  }
}

// A conversation with one ACP agent. Events go to `listener(event)`:
//   { type: "text", id, text }           a piece of the agent's reply
//   { type: "thought", id, text }        a piece of its reasoning summary
//   { type: "tool", call }               a tool step started or changed
//   { type: "plan", entries }
//   { type: "options", options }         model and other choices changed
//   { type: "permission", request, respond(optionId|null) }
//   { type: "title", title }
//   { type: "exit", message }            the agent process ended
export class AcpChat {
  constructor(agent, listener) {
    this.agent = agent;
    this.listener = listener;
    this.rpc = null;
    this.sessionId = null;
    this.options = [];
    this.models = null;
    this.starting = null;
  }

  emit(event) {
    try { this.listener(event); } catch (error) { console.error(error); }
  }

  async start() {
    this.starting ||= this.boot().catch((error) => { this.starting = null; throw error; });
    return this.starting;
  }

  async boot() {
    const command = await findCommand(this.agent.command);
    const cwd = await chatDir();
    const proc = await lazy.Subprocess.call({
      command,
      arguments: this.agent.args || [],
      workdir: cwd,
      environmentAppend: true,
      environment: { ...(this.agent.env || {}), ...agentDirEnv(), STILL_AGENT_CLIENT: `${this.agent.name} (side chat)` },
      stderr: "pipe"
    });
    const rpc = new RpcProcess(proc);
    this.rpc = rpc;
    rpc.onNotification = (method, params) => this.notification(method, params);
    rpc.onRequest = (method, params) => this.request(method, params);
    rpc.onExit = (code, tail) => {
      if (this.rpc !== rpc) return;
      this.rpc = null;
      this.sessionId = null;
      this.starting = null;
      this.emit({ type: "exit", message: tail || `exit ${code}` });
    };
    const init = await rpc.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "still", title: "Still", version: "1" }
    });
    this.info = init;
    await this.newSession();
  }

  async newSession() {
    const still = await findCommand("still").catch(() => null);
    const env = Object.entries({ ...agentDirEnv(), STILL_AGENT_CLIENT: `${this.agent.name} (side chat)` }).map(([name, value]) => ({ name, value }));
    const mcpServers = still ? [{ name: "still", command: still, args: ["mcp"], env }] : [];
    let session;
    try {
      session = await this.rpc.request("session/new", { cwd: await chatDir(), mcpServers });
    } catch (error) {
      if (/auth/i.test(textOf(error)) || error.code === -32000) {
        throw Object.assign(new Error(`${this.agent.name} needs you to sign in first${this.agent.login ? ` (in a terminal: ${this.agent.login})` : ""}.`), { code: "auth" });
      }
      throw error;
    }
    this.sessionId = session.sessionId;
    this.options = session.configOptions || [];
    this.models = session.models || null;
    this.emit({ type: "options", options: this.choices() });
    return session;
  }

  // What the person can choose, as [{ id, name, value, values: [{ value, name }] }].
  choices() {
    const flat = (option) => (option.options || []).flatMap((item) => item.options ? item.options : [item]);
    // Everything the agent offers about how it works: model, reasoning
    // effort, speed and similar switches, and its permission mode.
    const list = this.options
      .filter((option) => option.type === "select" && ["model", "thought_level", "model_config", "mode"].includes(option.category))
      .map((option) => ({ id: option.id, name: option.name, category: option.category, description: option.description || "", value: option.currentValue,
        values: flat(option).map((item) => ({ value: item.value, name: item.name, description: item.description || "" })) }));
    if (!list.some((choice) => choice.id === "model") && !list.some((choice) => /model/i.test(choice.name)) && this.models?.availableModels?.length) {
      list.unshift({ id: "__model", name: "Model", category: "model", value: this.models.currentModelId,
        values: this.models.availableModels.map((model) => ({ value: model.modelId, name: model.name })) });
    }
    return list;
  }

  async choose(id, value) {
    if (!this.sessionId) return;
    if (id === "__model") {
      await this.rpc.request("session/set_model", { sessionId: this.sessionId, modelId: value });
      if (this.models) this.models.currentModelId = value;
    } else {
      const result = await this.rpc.request("session/set_config_option", { sessionId: this.sessionId, configId: id, value });
      if (result?.configOptions) this.options = result.configOptions;
      else for (const option of this.options) if (option.id === id) option.currentValue = value;
    }
    this.emit({ type: "options", options: this.choices() });
  }

  async prompt(blocks) {
    await this.start();
    if (!this.sessionId) await this.newSession();
    const result = await this.rpc.request("session/prompt", { sessionId: this.sessionId, prompt: blocks });
    return result?.stopReason || "end_turn";
  }

  cancel() {
    if (this.sessionId) this.rpc?.notify("session/cancel", { sessionId: this.sessionId });
  }

  async reset() {
    if (this.rpc && !this.rpc.closed) {
      if (this.sessionId) this.rpc.request("session/close", { sessionId: this.sessionId }).catch(() => {});
      this.sessionId = null;
      await this.newSession();
    }
  }

  notification(method, params) {
    if (method !== "session/update" || params.sessionId !== this.sessionId) return;
    const update = params.update || {};
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.type === "text") this.emit({ type: "text", id: update.messageId || "", text: update.content.text });
        break;
      case "agent_thought_chunk":
        if (update.content?.type === "text") this.emit({ type: "thought", id: update.messageId || "", text: update.content.text });
        break;
      case "tool_call":
      case "tool_call_update":
        this.emit({ type: "tool", call: update });
        break;
      case "plan":
        this.emit({ type: "plan", entries: update.entries || [] });
        break;
      case "config_option_update":
        this.options = update.configOptions || this.options;
        this.emit({ type: "options", options: this.choices() });
        break;
      case "session_info_update":
        if (update.title) this.emit({ type: "title", title: update.title });
        break;
    }
  }

  // The agent asks the client something. Still answers permission questions
  // through the chat; it offers no file system or terminal of its own.
  request(method, params) {
    if (method === "session/request_permission") {
      return new Promise((resolve) => {
        this.emit({
          type: "permission",
          request: params,
          respond: (optionId) => resolve({ outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } })
        });
      });
    }
    throw new Error(`Still does not offer ${method}`);
  }

  stop() {
    this.rpc?.kill();
    this.rpc = null;
    this.sessionId = null;
    this.starting = null;
  }
}

// ------------------------------------------------------------------- T3

const PROVIDER_NAMES = { codex: "Codex", claudeAgent: "Claude", cursor: "Cursor", grok: "Grok", opencode: "OpenCode", antigravity: "Antigravity", gemini: "Gemini" };

// A conversation as a T3 Code thread, through T3's command line. T3 runs the
// agent (its own provider, model and Still tools). Still polls the thread
// for new messages while it works.
export class T3Chat {
  constructor(agent, listener) {
    this.agent = agent;
    this.listener = listener;
    this.threadId = null;
    this.seen = 0;
    this.stopped = false;
    this.cancelled = false;
  }

  emit(event) {
    try { this.listener(event); } catch (error) { console.error(error); }
  }

  async t3(args, input = null) {
    const command = await findCommand(this.agent.command || "t3");
    const proc = await lazy.Subprocess.call({ command, arguments: args, workdir: home(), environmentAppend: true, environment: {}, stderr: "stdout" });
    if (input !== null) { await proc.stdin.write(input); await proc.stdin.close(); }
    let out = "";
    for (;;) { const chunk = await proc.stdout.readString(); if (!chunk) break; out += chunk; }
    const { exitCode } = await proc.wait();
    return { out, exitCode };
  }

  json(out) {
    const start = out.search(/[{[]/);
    try { return JSON.parse(out.slice(start)); } catch { return null; }
  }

  // T3's own provider cache (~/.t3/caches/<provider>.json): which harnesses
  // are installed, on and signed in, with their live models and each
  // model's options (reasoning, speed, ...). Falls back to the provider and
  // model pairs of your recent T3 chats.
  async readProviders() {
    const base = Services.env.get("T3CODE_HOME") || PathUtils.join(home(), ".t3");
    const dir = PathUtils.join(base, "caches");
    const providers = new Map();
    let names = [];
    try { names = (await IOUtils.getChildren(dir)).filter((path) => path.endsWith(".json")); } catch {}
    for (const path of names) {
      try {
        const data = await IOUtils.readJSON(path);
        if (!data?.enabled || !data.installed || data.status !== "ready" || !data.models?.length) continue;
        const id = PathUtils.filename(path).replace(/\.json$/, "");
        providers.set(id, { name: data.displayName || PROVIDER_NAMES[id] || id, models: data.models.filter((model) => model.slug) });
      } catch {}
    }
    let defaults = null;
    try { defaults = (await IOUtils.readJSON(PathUtils.join(base, "userdata", "settings.json")))?.defaultModelSelection; } catch {}
    return { providers, defaults };
  }

  pref(name) {
    return Services.prefs.getStringPref(`still.chat.choice.t3.${name}`, "");
  }

  async start() {
    const { providers, defaults } = await this.readProviders();
    this.providers = providers;
    if (!providers.size) {
      const { out, exitCode } = await this.t3(["thread", "list", "--project", this.projectPath(), "--json"]).catch(() => ({ out: "", exitCode: -1 }));
      const threads = exitCode === 0 ? this.json(out) : null;
      if (!Array.isArray(threads)) throw Object.assign(new Error("T3 Code is not running. Open the T3 Code app, then try again."), { code: "missing" });
      for (const thread of threads) {
        if (!thread.providerInstanceId || !thread.model) continue;
        const entry = providers.get(thread.providerInstanceId) || { name: PROVIDER_NAMES[thread.providerInstanceId] || thread.providerInstanceId, models: [] };
        if (!entry.models.some((model) => model.slug === thread.model)) entry.models.push({ slug: thread.model, name: thread.model });
        providers.set(thread.providerInstanceId, entry);
      }
      if (!providers.size) throw new Error("Start one chat in T3 Code first, so Still knows which harness and model to use.");
    }
    // What you picked before wins, then T3's own default.
    const saved = this.pref("harness");
    this.harness = providers.has(saved) ? saved : providers.has(defaults?.instanceId) ? defaults.instanceId : providers.keys().next().value;
    this.pickModel(this.pref("model") || (defaults?.instanceId === this.harness ? defaults.model : ""));
    this.emitOptions();
  }

  pickModel(slug) {
    const models = this.providers.get(this.harness)?.models || [];
    const model = models.find((item) => item.slug === slug) || models.find((item) => item.isDefault) || models[0];
    this.model = model?.slug || "";
    this.optionValues = {};
    for (const descriptor of model?.capabilities?.optionDescriptors || []) {
      const value = this.pref(`option:${descriptor.id}`);
      if (value) this.optionValues[descriptor.id] = value;
    }
  }

  currentModel() {
    return (this.providers.get(this.harness)?.models || []).find((model) => model.slug === this.model) || null;
  }

  // The chosen model's options, as the same kind of choices ACP agents give.
  // A choice with a single value is not a choice and is left out.
  modelOptions() {
    return (this.currentModel()?.capabilities?.optionDescriptors || []).map((descriptor) => {
      const boolean = descriptor.type === "boolean";
      const values = boolean ? [{ value: "false", name: "Off" }, { value: "true", name: "On" }]
        : (descriptor.options || []).map((option) => ({ value: option.id, name: option.label || option.id, description: option.description || "", isDefault: Boolean(option.isDefault) }));
      const fallback = boolean ? "false" : ((descriptor.options || []).find((option) => option.isDefault)?.id || descriptor.currentValue || values[0]?.value);
      return { id: `option:${descriptor.id}`, name: descriptor.label || descriptor.id, category: /effort|reason/i.test(descriptor.id) ? "thought_level" : "model_config",
        value: this.optionValues[descriptor.id] ?? fallback, defaultValue: fallback, values };
    }).filter((option) => option.values.length > 1);
  }

  emitOptions() {
    const harnesses = [...this.providers].map(([value, provider]) => ({ value, name: provider.name }));
    const models = (this.providers.get(this.harness)?.models || []).map((model) => ({ value: model.slug, name: model.name || model.slug }));
    this.emit({ type: "options", options: [
      { id: "harness", name: "Harness", category: "harness", value: this.harness, values: harnesses },
      { id: "model", name: "Model", category: "model", value: this.model, values: models },
      ...this.modelOptions()
    ] });
  }

  projectPath() {
    return PathUtils.join(home(), ".t3", "scratch");
  }

  async prompt(blocks) {
    this.cancelled = false;
    const message = blocks.map((block) => block.text || "").join("\n\n");
    let result;
    if (!this.threadId) {
      // Chats go into T3's "No project" (its scratch folder).
      const pick = this.harness && this.model ? ["--provider", this.harness, "--model", this.model] : [];
      // Options differing from T3's default for this model, as id=value.
      if (pick.length) {
        for (const option of this.modelOptions()) {
          if (option.value !== option.defaultValue) pick.push("--option", `${option.id.slice(7)}=${option.value}`);
        }
      }
      result = await this.t3(["thread", "start", this.projectPath(), "-", "--title", `Still: ${this.firstLine(blocks)}`, ...pick, "--json"], message);
      const data = this.json(result.out);
      this.threadId = data?.threadId || data?.thread?.threadId || data?.id || (result.out.match(/[0-9a-f]{8}-[0-9a-f-]{27}/) || [])[0] || null;
      if (!this.threadId) throw new Error(`T3 Code did not start a thread: ${result.out.trim().slice(0, 300)}`);
      this.seen = 0;
    } else {
      result = await this.t3(["thread", "send", this.threadId, "-", "--json"], message);
      if (result.exitCode !== 0) throw new Error(`T3 Code did not take the message: ${result.out.trim().slice(0, 300)}`);
    }
    return this.follow();
  }

  firstLine(blocks) {
    const user = blocks[blocks.length - 1]?.text || "";
    return user.split("\n")[0].slice(0, 60);
  }

  // Poll until the thread is no longer running; emit assistant messages as
  // they appear (each message arrives whole).
  async follow() {
    let quiet = 0;
    for (;;) {
      if (this.stopped) return "cancelled";
      await new Promise((resolve) => setTimeout(resolve, 900));
      const { out } = await this.t3(["thread", "show", this.threadId, "--json", "--messages", "40"]).catch(() => ({ out: "" }));
      const data = this.json(out);
      if (!data) continue;
      const thread = data.thread || {};
      if (thread.link) this.link = thread.link;
      const messages = (data.messages || []).filter((message) => message.role === "assistant");
      if (this.seenRun !== thread.latestRunId) { this.seenRun = thread.latestRunId; this.seen = 0; }
      const fresh = messages.filter((message) => message.runId === thread.latestRunId).slice(this.seen);
      for (const message of fresh) this.emit({ type: "text", id: `t3-${thread.latestRunId}-${this.seen++}`, text: message.text, whole: true });
      if (thread.title) this.emit({ type: "title", title: thread.title, link: this.link });
      const running = /running|starting|queued|pending/i.test(thread.status || "");
      if (!running && thread.status) {
        if (++quiet >= 2) return this.cancelled || /cancel/i.test(thread.status) ? "cancelled" : /fail|error/i.test(thread.status) ? "failed" : "end_turn";
      } else {
        quiet = 0;
      }
    }
  }

  cancel() {
    this.cancelled = true;
    this.emit({ type: "notice", text: "T3 Code keeps running this turn. Open the thread in T3 to stop it." });
  }

  async reset() {
    this.threadId = null;
    this.seen = 0;
  }

  async choose(id, value) {
    if (id.startsWith("option:")) this.optionValues[id.slice(7)] = value;
    else if (id === "harness" && this.providers.has(value)) { this.harness = value; this.pickModel(""); }
    else if (id === "model") this.pickModel(value);
    else return;
    // A thread keeps its harness and model; changes start the next chat.
    if (this.threadId) this.emit({ type: "notice", text: "This is used from your next new chat." });
    this.emitOptions();
  }

  stop() {
    this.stopped = true;
  }
}

// A chat with any OpenAI-style server (your GridAPI, a local llama.cpp, a
// hosted API): plain conversation about the page, streamed, without tools.
// Added in Settings as { kind: "openai", endpoint, key?, model? }.
export class OpenAIChat {
  constructor(agent, listener) {
    this.agent = agent;
    this.listener = listener;
    this.messages = [];
    this.model = agent.model || "";
    this.controller = null;
    this.models = [];
  }

  emit(event) {
    try { this.listener(event); } catch (error) { console.error(error); }
  }

  url(path) {
    const base = this.agent.endpoint.replace(/\/*$/, "/");
    return new URL(/\/v1\/$/.test(base) ? path : `v1/${path}`, base).href;
  }

  headers() {
    return { "Content-Type": "application/json", "X-GridAPI-Project": "Still", "X-GridAPI-Title": "Side chat",
      ...(this.agent.key ? { Authorization: `Bearer ${this.agent.key}` } : {}) };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      const response = await fetch(this.url("models"), { headers: this.headers(), signal: AbortSignal.timeout(8000) });
      const data = response.ok ? await response.json() : null;
      this.models = (data?.data || []).map((model) => model.id).filter(Boolean).slice(0, 60);
    } catch {}
    this.emitOptions();
  }

  emitOptions() {
    const values = [{ value: "", name: "Server default" }, ...this.models.map((id) => ({ value: id, name: id }))];
    this.emit({ type: "options", options: [{ id: "model", name: "Model", category: "model", value: this.model, values }] });
  }

  async prompt(blocks) {
    await this.start();
    const text = blocks.map((block) => block.text || "").filter(Boolean).join("\n\n");
    if (!this.messages.length) {
      this.messages.push({ role: "system", content: "You are the side chat of Still, a calm web browser. The user may share the page they are looking at; answer plainly and briefly." });
    }
    this.messages.push({ role: "user", content: text });
    this.controller = new AbortController();
    const response = await fetch(this.url("chat/completions"), {
      method: "POST",
      headers: this.headers(),
      signal: this.controller.signal,
      body: JSON.stringify({ messages: this.messages, stream: true, ...(this.model ? { model: this.model } : {}) })
    }).catch((error) => { if (this.controller.signal.aborted) return null; throw error; });
    if (!response) return "cancelled";
    if (!response.ok || !response.body) {
      this.messages.pop();
      throw new Error(`${this.agent.name} answered with error ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const id = `m${Date.now()}`;
    let buffer = "";
    let reply = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const piece = JSON.parse(data).choices?.[0]?.delta?.content;
            if (piece) { reply += piece; this.emit({ type: "text", id, text: piece }); }
          } catch {}
        }
      }
    } catch (error) {
      if (!this.controller.signal.aborted) throw error;
    }
    this.messages.push({ role: "assistant", content: reply });
    return this.controller.signal.aborted ? "cancelled" : "end_turn";
  }

  cancel() {
    this.controller?.abort();
  }

  async reset() {
    this.cancel();
    this.messages = [];
  }

  async choose(id, value) {
    if (id === "model") this.model = value;
    this.emitOptions();
  }

  stop() {
    this.cancel();
  }
}

export function createChat(agent, listener) {
  if (agent.kind === "openai") return new OpenAIChat(agent, listener);
  return agent.kind === "t3" ? new T3Chat(agent, listener) : new AcpChat(agent, listener);
}

export const StillChat = { chatAgents, createChat };
