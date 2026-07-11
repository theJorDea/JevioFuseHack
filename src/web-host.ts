import path from "node:path";
import { runAgent, type AgentEvent } from "./agent.ts";
import { loadConfig, setAllRolesModelConfig, setDefaultProviderConfig } from "./config.ts";
import { listProviderModels } from "./setup.ts";
import { CogneeMemory } from "./memory.ts";
import { runCouncilPlan, runCouncilReview, runTeam } from "./orchestrator.ts";
import { createPlanDocument, writePlanDocument } from "./plan.ts";
import { cogneeConfigForProject, loadProjectIdentity } from "./project-identity.ts";
import {
  appendSessionTurn,
  createSession,
  listSessions,
  loadProjectMemory,
  loadSession,
  NEW_SESSION_TITLE,
  renameSession,
  saveSessionTodos,
  type LoadedSession,
} from "./session.ts";
import { discoverSkills } from "./skills.ts";
import { buildRepositoryMap } from "./symbol-index.ts";
import { formatAskUserNudge, isImplementationRequest, needsUserClarification } from "./task-intent.ts";
import type {
  AskUserOption,
  AskUserRequest,
  ChatMessage,
  ExecutionMode,
  JevioConfig,
  PlanModeState,
  RoleName,
  SpecialistRoleName,
  TodoItem,
  ToolContext,
} from "./types.ts";

export type WebStreamEvent =
  | { type: "status"; detail: string }
  | { type: "thinking"; role: string; detail: string }
  | { type: "tool"; role: string; detail: string }
  | { type: "progress"; role: string; detail: string }
  | { type: "message"; role: "user" | "assistant" | "system"; content: string }
  | { type: "todos"; items: TodoItem[] }
  | { type: "confirm"; id: string; message: string }
  | {
    type: "ask_user";
    id: string;
    question: string;
    options: AskUserOption[];
  }
  | { type: "done"; content: string; sessionId: string }
  | { type: "error"; message: string };

type Pending =
  | { kind: "confirm"; resolve: (value: boolean) => void }
  | { kind: "ask"; resolve: (value: string) => void };

export class WebHost {
  readonly workspace: string;
  private config!: JevioConfig;
  private active!: LoadedSession;
  private history: ChatMessage[] = [];
  private mode: ExecutionMode = "orchestrate";
  private yolo = false;
  private workspaceMutationCount = 0;
  private planMode: PlanModeState = { active: false };
  private pending = new Map<string, Pending>();
  private busy = false;
  private activeTask: string | null = null;
  private activeDetail: string | null = null;
  private projectMemory = "";

  private constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
  }

  static async create(workspace = process.cwd()): Promise<WebHost> {
    const host = new WebHost(workspace);
    await host.reload();
    return host;
  }

  async reload(): Promise<void> {
    this.config = await loadConfig(this.workspace);
    try {
      this.active = await loadSession(this.workspace, "latest");
    } catch {
      this.active = { info: await createSession(this.workspace), history: [], todos: [] };
    }
    this.history = this.active.history;
    this.projectMemory = await loadProjectMemory(this.workspace);
  }

  status() {
    const role = this.config.roles.coder;
    const provider = role.provider ?? this.config.defaultProvider;
    return {
      workspace: this.workspace,
      sessionId: this.active.info.id,
      title: this.active.info.title,
      messageCount: this.active.info.messageCount,
      mode: this.mode,
      yolo: this.yolo,
      provider,
      model: role.model,
      todos: this.active.todos,
      busy: this.busy,
      activeTask: this.activeTask,
      activeDetail: this.activeDetail,
    };
  }

  /** Full settings snapshot for the web settings panel. */
  getSettings() {
    const providers = Object.entries(this.config.providers).map(([name, provider]) => ({
      name,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      toolMode: provider.toolMode ?? "auto",
      transport: provider.transport ?? "chat_completions",
      isDefault: name === this.config.defaultProvider,
    }));
    const roles = (Object.entries(this.config.roles) as Array<[RoleName, typeof this.config.roles[RoleName]]>).map(
      ([role, settings]) => ({
        role,
        provider: settings.provider ?? this.config.defaultProvider,
        model: settings.model,
      }),
    );
    const coder = this.config.roles.coder;
    return {
      workspace: this.workspace,
      yolo: this.yolo,
      mode: this.mode,
      defaultProvider: this.config.defaultProvider,
      currentProvider: coder.provider ?? this.config.defaultProvider,
      currentModel: coder.model,
      providers,
      roles,
      permissions: {
        autoApproveWrites: this.config.permissions.autoApproveWorkspaceWrites,
        autoApproveShell: this.config.permissions.autoApproveShell,
        shellMode: this.config.permissions.shellMode,
      },
    };
  }

  async listModels(providerName?: string): Promise<{ provider: string; models: string[]; current: string }> {
    const name = providerName && this.config.providers[providerName]
      ? providerName
      : this.config.defaultProvider;
    const provider = this.config.providers[name];
    if (!provider) throw new Error(`Unknown provider '${name}'`);
    const apiKey = provider.apiKey
      ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
    let models: string[] = [];
    try {
      models = await listProviderModels(provider.baseUrl, {
        apiKey,
        timeoutMs: 2_500,
      });
    } catch {
      models = [
        provider.defaultModel,
        ...Object.values(this.config.roles)
          .filter((role) => (role.provider ?? this.config.defaultProvider) === name)
          .map((role) => role.model),
      ].filter((item, index, all): item is string => Boolean(item) && all.indexOf(item) === index);
    }
    const current = this.config.roles.coder.provider === name || !this.config.roles.coder.provider
      ? this.config.roles.coder.model
      : (provider.defaultModel ?? models[0] ?? "");
    return { provider: name, models, current };
  }

  async applyProvider(name: string, applyDefaultModel = false): Promise<string> {
    if (!this.config.providers[name]) throw new Error(`Unknown provider '${name}'`);
    const file = await setDefaultProviderConfig(this.workspace, undefined, name, { applyDefaultModel });
    await this.reload();
    return `Провайдер: ${name}. Сохранено в ${file}.`;
  }

  async applyModel(model: string, providerName?: string): Promise<string> {
    const provider = providerName && this.config.providers[providerName]
      ? providerName
      : this.config.defaultProvider;
    if (!this.config.providers[provider]) throw new Error(`Unknown provider '${provider}'`);
    const file = await setAllRolesModelConfig(this.workspace, undefined, model.trim(), provider);
    await this.reload();
    return `Модель: ${model} · ${provider}. Сохранено в ${file}.`;
  }

  async listSessions() {
    return (await listSessions(this.workspace))
      .filter((session) => session.messageCount > 0 || session.id === this.active.info.id)
      .map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        messageCount: session.messageCount,
      }));
  }

  getHistory(): Array<{ role: "user" | "assistant"; content: string }> {
    return this.history
      .filter((message): message is ChatMessage & { role: "user" | "assistant" } =>
        message.role === "user" || message.role === "assistant")
      .map(({ role, content }) => ({ role, content: String(content ?? "") }));
  }

  async newSession(): Promise<{ sessionId: string }> {
    this.active = { info: await createSession(this.workspace), history: [], todos: [] };
    this.history = [];
    return { sessionId: this.active.info.id };
  }

  async resumeSession(id: string): Promise<{ sessionId: string; title: string; messageCount: number }> {
    this.active = await loadSession(this.workspace, id);
    this.history = this.active.history;
    return {
      sessionId: this.active.info.id,
      title: this.active.info.title,
      messageCount: this.active.info.messageCount,
    };
  }

  setMode(mode: ExecutionMode): void {
    this.mode = mode;
    this.planMode.active = mode === "plan";
  }

  setYolo(on: boolean): void {
    this.yolo = on;
  }

  resolveInteraction(id: string, answer: boolean | string): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    this.pending.delete(id);
    if (item.kind === "confirm") item.resolve(Boolean(answer));
    else item.resolve(String(answer ?? ""));
    return true;
  }

  async *runChat(userText: string): AsyncGenerator<WebStreamEvent> {
    if (this.busy) {
      yield { type: "error", message: "Уже выполняется другая задача. Дождитесь завершения." };
      return;
    }
    const text = userText.trim();
    if (!text) {
      yield { type: "error", message: "Пустое сообщение." };
      return;
    }

    this.busy = true;
    this.activeTask = text;
    this.activeDetail = "Запуск…";
    const queue: WebStreamEvent[] = [];
    let notify: (() => void) | undefined;
    const push = (event: WebStreamEvent) => {
      if (event.type === "status" || event.type === "thinking" || event.type === "tool" || event.type === "progress") {
        const detail = String(event.detail || "").trim();
        if (detail) {
          const label = event.type === "tool"
            ? "tool"
            : event.type === "progress"
              ? "…"
              : ("role" in event ? event.role : "");
          this.activeDetail = label ? `${label}: ${detail}` : detail;
        }
      } else if (event.type === "confirm") {
        this.activeDetail = "Ожидается подтверждение";
      } else if (event.type === "ask_user") {
        this.activeDetail = "Ожидается ответ";
      }
      queue.push(event);
      notify?.();
    };
    const wait = () => new Promise<void>((resolve) => {
      if (queue.length) {
        resolve();
        return;
      }
      notify = resolve;
    });

    const run = this.execute(text, push).then(
      (content) => push({ type: "done", content, sessionId: this.active.info.id }),
      (error) => push({ type: "error", message: error instanceof Error ? error.message : String(error) }),
    ).finally(() => {
      this.busy = false;
      this.activeTask = null;
      this.activeDetail = null;
    });

    while (this.busy || queue.length) {
      if (!queue.length) await wait();
      while (queue.length) yield queue.shift()!;
    }
    await run;
  }

  private async execute(task: string, emit: (event: WebStreamEvent) => void): Promise<string> {
    emit({ type: "message", role: "user", content: task });
    emit({ type: "status", detail: "Запуск…" });

    const skills = await discoverSkills(this.workspace);
    this.projectMemory = await loadProjectMemory(this.workspace);
    const projectIdentity = await loadProjectIdentity(this.workspace);
    const cognee = new CogneeMemory(
      cogneeConfigForProject(this.config.memory.cognee, projectIdentity),
      this.workspace,
    );

    let projectCodeMap: string | undefined;
    try {
      projectCodeMap = await buildRepositoryMap(this.workspace, this.config.codeIndex);
    } catch {
      projectCodeMap = undefined;
    }

    let retrievedMemory: string | undefined;
    if (cognee.enabled) {
      try {
        retrievedMemory = await cognee.recall(task, this.active.info.id);
      } catch {
        // optional
      }
    }

    const planMode = this.planMode;
    const mutationsBefore = this.workspaceMutationCount;

    const context: ToolContext = {
      workspace: this.workspace,
      skills,
      projectMemory: this.projectMemory,
      retrievedMemory,
      projectCodeMap,
      todos: this.active.todos,
      autoApproveWrites: this.yolo || this.config.permissions.autoApproveWorkspaceWrites,
      autoApproveShell: this.yolo || this.config.permissions.autoApproveShell,
      autoApprovePlugins: this.yolo || this.config.permissions.autoApprovePlugins,
      shellMode: this.yolo ? "full" : this.config.permissions.shellMode,
      maxToolOutputCharacters: this.config.agent.maxToolOutputCharacters,
      codeIndex: this.config.codeIndex,
      planMode,
      confirm: async (message) => {
        if (this.yolo) return true;
        const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return await new Promise<boolean>((resolve) => {
          this.pending.set(id, { kind: "confirm", resolve });
          emit({ type: "confirm", id, message });
        });
      },
      askUser: async (questionOrRequest, options) => {
        const request: AskUserRequest = typeof questionOrRequest === "string"
          ? {
            questions: [{
              id: "q1",
              question: questionOrRequest,
              options: options ?? [],
            }],
          }
          : questionOrRequest;
        const answers: string[] = [];
        for (const item of request.questions) {
          const id = `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const answer = await new Promise<string>((resolve) => {
            this.pending.set(id, { kind: "ask", resolve });
            emit({
              type: "ask_user",
              id,
              question: item.question,
              options: item.options ?? [],
            });
          });
          answers.push(`${item.id ?? item.question}: ${answer}`);
          if (answer === "[cancelled]") break;
        }
        return answers.join("\n") || "[cancelled]";
      },
      updateTodos: async (items) => {
        this.active.todos = items;
        context.todos = items;
        await saveSessionTodos(this.active.info, items);
        emit({ type: "todos", items });
      },
      reportProgress: async (message) => {
        emit({ type: "progress", role: "orchestrator", detail: message });
      },
      onWorkspaceChange: () => {
        this.workspaceMutationCount += 1;
      },
      enterPlanMode: async (goal) => {
        planMode.active = true;
        planMode.goal = goal;
        planMode.enteredAt = new Date().toISOString();
        emit({ type: "status", detail: goal ? `Plan Mode: ${goal}` : "Plan Mode" });
        return `Plan Mode active${goal ? ` (${goal})` : ""}`;
      },
      exitPlanMode: async (reason) => {
        planMode.active = false;
        emit({ type: "status", detail: reason ? `Left Plan Mode: ${reason}` : "Left Plan Mode" });
        return "Plan Mode exited";
      },
      submitPlan: async (plan) => {
        const doc = await createPlanDocument(this.workspace, this.active.info.id);
        await writePlanDocument(doc, plan, "pending");
        if (this.yolo) {
          await writePlanDocument(doc, plan, "approved");
          planMode.approvedPlan = plan;
          planMode.active = false;
          return `Plan approved.\n\n${plan}`;
        }
        const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const ok = await new Promise<boolean>((resolve) => {
          this.pending.set(id, { kind: "confirm", resolve });
          emit({ type: "confirm", id, message: `Одобрить план?\n\n${plan.slice(0, 4_000)}` });
        });
        if (ok) {
          await writePlanDocument(doc, plan, "approved");
          planMode.approvedPlan = plan;
          planMode.active = false;
          return `Plan approved.\n\n${plan}`;
        }
        planMode.active = false;
        await writePlanDocument(doc, plan, "rejected");
        return "Plan rejected.";
      },
      suggestMode: async () => false,
    };

    context.delegate = async (role: SpecialistRoleName, specialistTask: string) => {
      const result = await runAgent({
        role,
        task: specialistTask,
        config: this.config,
        toolContext: context,
        onEvent: (event) => this.forwardEvent(event, emit),
      });
      return result.content;
    };

    const onEvent = (event: AgentEvent) => this.forwardEvent(event, emit);

    let agentTask = task;
    if (context.askUser) {
      const need = needsUserClarification(task, this.history);
      if (need.needed) {
        agentTask = `${formatAskUserNudge(need)}${task}`;
        emit({ type: "status", detail: `Ожидаются уточнения: ${need.topics.join(", ")}` });
      }
    }

    if (this.active.info.title === NEW_SESSION_TITLE) {
      await renameSession(this.active.info, task.split(/\r?\n/)[0].slice(0, 80));
    }

    const requiresChange = isImplementationRequest(task, this.history);
    let content = "";

    if (this.mode === "team") {
      const result = await runTeam({
        task: agentTask,
        config: this.config,
        toolContext: context,
        history: this.history,
        onEvent,
        requireWorkspaceChange: requiresChange,
        getWorkspaceMutationCount: () => this.workspaceMutationCount,
      });
      content = `${result.content}\n\nReview:\n${result.review}`;
    } else if (this.mode === "council-plan") {
      const result = await runCouncilPlan({
        task: agentTask,
        config: this.config,
        toolContext: context,
        history: this.history,
        onEvent,
        requireWorkspaceChange: requiresChange,
        getWorkspaceMutationCount: () => this.workspaceMutationCount,
      });
      content = result.content;
    } else if (this.mode === "council-review") {
      const result = await runCouncilReview({
        task: agentTask,
        config: this.config,
        toolContext: context,
        history: this.history,
        onEvent,
      });
      content = result.content;
    } else {
      const role: RoleName = this.mode === "direct" ? "coder" : "orchestrator";
      let result = await runAgent({
        role,
        task: agentTask,
        config: this.config,
        toolContext: context,
        history: this.history,
        onEvent,
      });
      if (requiresChange && this.workspaceMutationCount === mutationsBefore && role === "orchestrator" && !planMode.active) {
        emit({ type: "status", detail: "Передаю coder — файлы ещё не менялись" });
        result = await runAgent({
          role: "coder",
          task: `${task}\n\nImplement now in the workspace.\n\nContext:\n${result.content}`,
          config: this.config,
          toolContext: context,
          history: this.history,
          onEvent,
        });
      }
      content = result.content;
      this.history = result.history;
    }

    if (this.mode === "team" || this.mode === "council-plan" || this.mode === "council-review") {
      this.history = [
        ...this.history,
        { role: "user", content: task },
        { role: "assistant", content },
      ];
    }

    await appendSessionTurn(this.active.info, task, content);
    emit({ type: "message", role: "assistant", content });
    emit({ type: "todos", items: this.active.todos });
    return content;
  }

  private forwardEvent(event: AgentEvent, emit: (event: WebStreamEvent) => void): void {
    // Skip thinking_delta spam (single chars like "." blow up the live panel).
    if (event.type === "thinking_delta") return;
    if (event.type === "thinking_done") {
      emit({ type: "status", detail: "думаю…" });
      return;
    }
    const detail = String(event.detail ?? "").trim();
    if (event.type === "tool") {
      if (!detail) return;
      emit({ type: "tool", role: event.role, detail });
      return;
    }
    if (event.type === "progress") {
      if (!detail) return;
      emit({ type: "progress", role: event.role, detail });
      return;
    }
    if (event.type === "thinking") {
      // Only short status-style thinking lines, not dumps.
      if (!detail || detail.length < 2) return;
      const short = detail.length > 120 ? `${detail.slice(0, 117)}…` : detail;
      emit({ type: "thinking", role: event.role, detail: short });
    }
  }
}
