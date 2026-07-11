import {
  CombinedAutocompleteProvider,
  Box,
  Container,
  Editor,
  Input,
  Loader,
  Markdown,
  ProcessTerminal,
  SelectList,
  Text,
  TUI,
  type Component,
  type AutocompleteProvider,
  type MarkdownTheme,
  type SelectItem,
  type SelectListTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import { getPaletteItems, isExactSlashCommand } from "./slash-commands.ts";
import type { ExecutionMode } from "./types.ts";

export interface TuiSession {
  id: string;
  title: string;
  updatedAt: string;
}

export interface TuiProvider {
  name: string;
  baseUrl: string;
  apiKeyEnv?: string;
  defaultModel?: string;
  transport?: "chat_completions" | "responses";
  toolMode?: "auto" | "native" | "text";
  /** Live probe of GET /models */
  reachable?: boolean;
  modelCount?: number;
  /** Model currently used by roles on this provider */
  activeModel?: string;
}

export interface InteractiveTuiOptions {
  workspace: string;
  terminal?: Terminal;
  submit(input: string): Promise<{ output?: string; exit?: boolean }>;
  listSessions(): Promise<TuiSession[]>;
  resumeSession(id: string): Promise<string>;
  getSession(): { id: string; title: string; messageCount: number };
  getMode(): ExecutionMode;
  getProvider(): string;
  getModel(): string;
  /** YOLO: auto-approve writes/shell/plugins/plans. */
  getYolo?: () => boolean;
  listProviders(): Promise<TuiProvider[]>;
  selectProvider(name: string): Promise<string>;
  listModels(provider?: string): Promise<{ provider: string; models: string[]; current: string; detail?: string }>;
  selectModel(model: string): Promise<string>;
  addProvider(provider: { name: string; baseUrl: string; apiKey?: string; model: string; transport?: "chat_completions" | "responses"; toolMode?: "auto" | "native" | "text" }): Promise<string>;
  listRoleConfigs(): Promise<Array<{ role: string; provider: string; model: string }>>;
  listPlugins(): Promise<string>;
  configureRole(role: string, provider: string, model: string): Promise<string>;
  setupReport(): Promise<string>;
}

const ROLE_HINTS: Record<string, string> = {
  orchestrator: "маршрутизация и ответы",
  coder: "правки кода и tools",
  architect: "планы (read-only)",
  reviewer: "ревью и тесты",
  judge: "совет / вердикт",
  compactor: "сжатие контекста",
};

class FuseAutocompleteProvider implements AutocompleteProvider {
  private readonly provider: CombinedAutocompleteProvider;
  readonly triggerCharacters: string[] | undefined;

  constructor(provider: CombinedAutocompleteProvider) {
    this.provider = provider;
    this.triggerCharacters = provider.triggerCharacters;
  }

  async getSuggestions(...args: Parameters<AutocompleteProvider["getSuggestions"]>) {
    const [lines, cursorLine, cursorCol] = args;
    const input = lines[cursorLine]?.slice(0, cursorCol) ?? "";
    if (isExactSlashCommand(input)) return null;
    return this.provider.getSuggestions(...args);
  }

  applyCompletion(...args: Parameters<AutocompleteProvider["applyCompletion"]>) {
    return this.provider.applyCompletion(...args);
  }

  shouldTriggerFileCompletion(...args: Parameters<NonNullable<AutocompleteProvider["shouldTriggerFileCompletion"]>>) {
    return this.provider.shouldTriggerFileCompletion?.(...args) ?? false;
  }
}

const style = (code: number) => (text: string): string => `\x1b[${code}m${text}\x1b[39m`;
const boldCyan = (text: string): string => `\x1b[1;36m${text}\x1b[22;39m`;
const dim = style(2);
const cyan = style(36);
const green = style(32);
const yellow = style(33);
const red = style(31);
const white = style(37);
const modalBackground = (text: string): string => `\x1b[48;5;236m${text}\x1b[49m`;

const messageStyles = {
  you: cyan,
  fuse: green,
  error: red,
  system: dim,
  tool: yellow,
} as const;
type MessageLabel = keyof typeof messageStyles;

interface ThinkingBlock {
  role: string;
  text: string;
  component: Text;
  heading: Text;
  expanded: boolean;
  streaming: boolean;
}

interface ActivityToolEntry {
  name: string;
  role: string;
  status: "running" | "done" | "failed";
  meta: string;
  startedAt: number;
  elapsedMs?: number;
}

/** One transcript block that is rewritten in place (no spam of new lines). */
interface LiveActivityPanel {
  heading: Text;
  body: Text;
  spacer: Text;
  tools: ActivityToolEntry[];
  progress?: string;
  frozen: boolean;
  /** Default false: one-line summary; Ctrl+O reveals full tool list. */
  expanded: boolean;
  startedAt: number;
  elapsedMs?: number;
}

/** Shared expand/collapse targets for Ctrl+O (latest) / Ctrl+E (all). */
interface CollapsibleSection {
  kind: "thinking" | "activity";
  getExpanded(): boolean;
  setExpanded(value: boolean): void;
}

/** Parse "tool_name (running|done|failed) optional meta" tool event detail. */
export function parseToolEventDetail(detail: string): { name: string; status: "running" | "done" | "failed"; meta: string } {
  const match = /^(\S+)\s+\((running|done|failed)\)(?:\s+(.*))?$/.exec(detail.trim());
  if (!match) return { name: detail.trim() || "tool", status: "running", meta: "" };
  return {
    name: match[1],
    status: match[2] as "running" | "done" | "failed",
    meta: (match[3] ?? "").trim(),
  };
}

function formatToolLine(tool: ActivityToolEntry, shortMeta = false): string {
  const mark = tool.status === "failed" ? "✗" : tool.status === "done" ? "✓" : "⚙";
  const timing = tool.elapsedMs !== undefined
    ? ` · ${formatDuration(tool.elapsedMs)}`
    : tool.status === "running"
      ? " · …"
      : "";
  let meta = tool.meta ? `  ${tool.meta}` : "";
  if (shortMeta && meta.length > 48) meta = `  ${meta.slice(0, 47)}…`;
  return `${mark} ${tool.role.toUpperCase()}  ${tool.name}${timing}${meta}`;
}

/** Live body: last few tools + current, rewritten via setText. */
export function formatActivityBody(tools: ActivityToolEntry[], progress?: string, maxRows = 6): string {
  const done = tools.filter((tool) => tool.status !== "running");
  const running = tools.filter((tool) => tool.status === "running");
  const hidden = Math.max(0, done.length - Math.max(0, maxRows - running.length - (progress ? 1 : 0)));
  const visibleDone = done.slice(hidden);
  const lines: string[] = [];
  if (hidden > 0) lines.push(`… +${hidden} earlier`);
  for (const tool of visibleDone) lines.push(formatToolLine(tool, true));
  for (const tool of running) lines.push(formatToolLine(tool, true));
  if (progress?.trim()) lines.push(`· ${progress.trim()}`);
  return lines.join("\n");
}

/** One-line freeze summary after the turn ends. */
export function formatActivitySummary(tools: ActivityToolEntry[], elapsedMs?: number): string {
  if (!tools.length) return "";
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const names = [...new Set(tools.map((tool) => tool.name))];
  const chain = names.slice(0, 5).join(" → ");
  const more = names.length > 5 ? ` +${names.length - 5}` : "";
  const time = elapsedMs !== undefined ? ` · ${formatDuration(elapsedMs)}` : "";
  const fail = failed ? ` · ${failed} failed` : "";
  return `${tools.length} tool${tools.length === 1 ? "" : "s"}${time}${fail} · ${chain}${more}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function modalSurface(): Box {
  return new Box(1, 1, modalBackground);
}

const selectTheme: SelectListTheme = {
  selectedPrefix: boldCyan,
  selectedText: boldCyan,
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
};

const markdownTheme: MarkdownTheme = {
  heading: boldCyan,
  link: cyan,
  linkUrl: dim,
  code: green,
  codeBlock: white,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: cyan,
  hr: dim,
  listBullet: cyan,
  bold: (text) => `\x1b[1m${text}\x1b[22;39m`,
  italic: (text) => `\x1b[3m${text}\x1b[23;39m`,
  strikethrough: dim,
  underline: (text) => `\x1b[4m${text}\x1b[24;39m`,
  codeBlockIndent: "  ",
};

class RightAlignedText implements Component {
  private text = "";

  setText(text: string): void {
    this.text = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [`${" ".repeat(Math.max(0, width - this.text.length - 1))}${dim(this.text)}`];
  }
}

class ScrollableText implements Component {
  private readonly text: Text;
  private readonly maxVisibleLines: number;
  private offset = 0;
  private renderedLineCount = 0;

  constructor(content: string, maxVisibleLines: number) {
    this.maxVisibleLines = maxVisibleLines;
    this.text = new Text(content, 1, 0);
  }

  invalidate(): void {
    this.text.invalidate();
  }

  render(width: number): string[] {
    const lines = this.text.render(width);
    this.renderedLineCount = lines.length;
    this.offset = Math.min(this.offset, this.maxOffset());
    return lines.slice(this.offset, this.offset + this.maxVisibleLines);
  }

  scrollPage(direction: -1 | 1, width: number): void {
    const lines = this.text.render(width);
    this.renderedLineCount = lines.length;
    const step = Math.max(1, this.maxVisibleLines - 2);
    this.offset = Math.max(0, Math.min(this.maxOffset(), this.offset + direction * step));
  }

  pageInfo(width: number): string {
    const lines = this.text.render(width);
    this.renderedLineCount = lines.length;
    const totalPages = Math.max(1, Math.ceil(lines.length / this.maxVisibleLines));
    const currentPage = Math.min(totalPages, Math.floor(this.offset / this.maxVisibleLines) + 1);
    return `Diff: страница ${currentPage}/${totalPages} · PageUp/PageDown или Ctrl+U/Ctrl+D — прокрутка`;
  }

  private maxOffset(): number {
    return Math.max(0, this.renderedLineCount - this.maxVisibleLines);
  }
}

export class InteractiveTui {
  private readonly options: InteractiveTuiOptions;
  private readonly tui: TUI;
  private readonly root = new Container();
  private readonly transcript = new Container();
  private readonly header = new Text();
  private readonly todos = new Text();
  private readonly status = new Text();
  private readonly help = new Text();
  private readonly modeFooter = new RightAlignedText();
  private readonly loader: Loader;
  private readonly editor: Editor;
  private busy = false;
  private resolveExit?: () => void;
  private stopped = false;
  private dismissOverlay?: () => void;
  private activeApprovalPreview?: { preview: ScrollableText; status: Text };
  /** Finished + active thinking blocks; Ctrl+O toggles the latest section. */
  private thinkingBlocks: ThinkingBlock[] = [];
  private liveThinking?: ThinkingBlock;
  /** Live + frozen activity panels (frozen stay toggleable). */
  private activityBlocks: LiveActivityPanel[] = [];
  private liveActivity?: LiveActivityPanel;
  /** Stack of collapsible sections in creation order (Ctrl+O = latest). */
  private collapsibles: CollapsibleSection[] = [];
  /** Coalesce high-frequency thinking/tool paints into ~1 frame. */
  private renderTimer?: ReturnType<typeof setTimeout>;
  private renderPending = false;

  constructor(options: InteractiveTuiOptions) {
    this.options = options;
    this.tui = new TUI(options.terminal ?? new ProcessTerminal());
    this.loader = new Loader(this.tui, cyan, dim, "", { frames: [] });
    this.editor = new Editor(this.tui, { borderColor: cyan, selectList: selectTheme }, { paddingX: 1, autocompleteMaxVisible: 8 });
    const autocomplete = new CombinedAutocompleteProvider(
      getPaletteItems().map((item) => ({
        name: item.value.slice(1),
        description: item.description,
      })),
      options.workspace,
    );
    this.editor.setAutocompleteProvider(new FuseAutocompleteProvider(autocomplete));
    this.editor.onSubmit = (input) => void this.handleSubmit(input);

    this.root.addChild(this.header);
    this.root.addChild(this.todos);
    this.root.addChild(new Text(""));
    this.root.addChild(this.transcript);
    this.root.addChild(this.loader);
    this.root.addChild(this.status);
    this.help.setText(dim("Enter · /help · Ctrl+K команды · Ctrl+O блоки · /roles · /models · Esc · Ctrl+C"));
    this.root.addChild(this.help);
    this.root.addChild(this.editor);
    this.root.addChild(this.modeFooter);
    this.tui.addChild(this.root);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => this.onGlobalInput(data));
  }

  private onGlobalInput(data: string): { consume: true } | undefined {
    if (data === "\x03") {
      if (this.busy) this.setStatus("Агент еще работает. Дождитесь завершения текущей задачи.", yellow);
      else this.stop();
      return { consume: true };
    }
    // Ctrl+O — toggle latest collapsible (thinking or activity).
    if (data === "\x0f" && this.collapsibles.length) {
      this.toggleLatestCollapsible();
      return { consume: true };
    }
    // Ctrl+E — expand all collapsibles.
    if (data === "\x05" && this.collapsibles.length) {
      this.setAllCollapsibles(true);
      return { consume: true };
    }
    // Ctrl+W — collapse all (common "close" binding; only when no overlay).
    if (data === "\x17" && this.collapsibles.length && !this.dismissOverlay) {
      this.setAllCollapsibles(false);
      return { consume: true };
    }
    if (data === "\x0b" && !this.busy) {
      void this.showCommandPalette();
      return { consume: true };
    }
    if (this.activeApprovalPreview) {
      const direction = data === "\x1b[5~" || data === "\x15" ? -1 : data === "\x1b[6~" || data === "\x04" ? 1 : undefined;
      if (direction) {
        this.activeApprovalPreview.preview.scrollPage(direction, this.tui.terminal.columns);
        this.activeApprovalPreview.status.setText(dim(this.activeApprovalPreview.preview.pageInfo(this.tui.terminal.columns)));
        this.scheduleRender(true);
        return { consume: true };
      }
    }
    if (data === "\x1b" && this.dismissOverlay) {
      this.dismissOverlay();
      return { consume: true };
    }
    return undefined;
  }

  private registerCollapsible(section: CollapsibleSection): void {
    this.collapsibles.push(section);
    if (this.collapsibles.length > 48) this.collapsibles.shift();
  }

  private toggleLatestCollapsible(): void {
    const section = this.collapsibles[this.collapsibles.length - 1];
    if (!section) return;
    section.setExpanded(!section.getExpanded());
    this.setStatus(
      section.getExpanded() ? "Развернуто (Ctrl+O свернуть · Ctrl+W все)" : "Свернуто (Ctrl+O раскрыть · Ctrl+E все)",
      dim,
    );
  }

  private setAllCollapsibles(expanded: boolean): void {
    for (const section of this.collapsibles) section.setExpanded(expanded);
    this.setStatus(expanded ? "Все блоки развернуты (Ctrl+W свернуть)" : "Все блоки свернуты (Ctrl+E раскрыть)", dim);
  }

  /** Immediate or coalesced re-render. Use immediate for user-facing status/modals. */
  private scheduleRender(immediate = false): void {
    if (immediate) {
      if (this.renderTimer) {
        clearTimeout(this.renderTimer);
        this.renderTimer = undefined;
      }
      this.renderPending = false;
      this.tui.requestRender();
      return;
    }
    if (this.renderPending) return;
    this.renderPending = true;
    this.renderTimer = setTimeout(() => {
      this.renderPending = false;
      this.renderTimer = undefined;
      this.tui.requestRender();
    }, 33);
  }

  private resumeWorkingChrome(): void {
    this.loader.setMessage("Работаю...");
    this.setStatus("Работаю...", cyan);
  }

  private beginBusy(message: string): void {
    this.busy = true;
    this.editor.disableSubmit = true;
    this.loader.setMessage(message);
    this.loader.setIndicator({ frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 80 });
    this.loader.start();
    this.setStatus(message, cyan);
  }

  private endBusy(status: string, color: (text: string) => string = dim): void {
    this.loader.stop();
    this.loader.setIndicator({ frames: [] });
    this.loader.setMessage("");
    this.setStatus(status, color);
    this.busy = false;
    this.editor.disableSubmit = false;
    this.tui.setFocus(this.editor);
    this.scheduleRender(true);
  }

  async run(): Promise<void> {
    this.refreshHeader();
    if (this.options.getSession().messageCount === 0) this.showWelcome();
    this.setStatus("Готово", dim);
    this.tui.start();
    this.tui.requestRender(true);
    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setTodos(items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>): void {
    const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" } as const;
    this.todos.setText(items.length
      ? `${boldCyan("План")}\n${items.map((item, index) => {
        const line = (index + 1) + ". " + marker[item.status] + " " + item.content;
        return item.status === "completed" ? dim(line) : item.status === "in_progress" ? cyan(line) : white(line);
      }).join("\n")}\n`
      : "");
    this.scheduleRender(true);
  }

  reportEvent(event: { type: "thinking" | "thinking_delta" | "thinking_done" | "tool" | "progress"; role: string; detail: string }): void {
    switch (event.type) {
      case "thinking_delta":
        this.loader.setMessage("Размышляю...");
        this.setStatus("Размышляю...", dim, false);
        this.appendThinking(event.role, event.detail);
        return;
      case "thinking_done":
        this.finalizeThinking(event.role);
        return;
      case "tool": {
        this.finalizeThinking();
        const parsed = parseToolEventDetail(event.detail);
        this.updateActivityTool(event.role, event.detail);
        this.loader.setMessage(parsed.status === "running" ? parsed.name : `✓ ${parsed.name}`);
        this.setStatus(
          parsed.status === "running"
            ? `⚙ ${parsed.name}${parsed.meta ? `  ${parsed.meta}` : ""}`
            : `${parsed.status === "failed" ? "✗" : "✓"} ${parsed.name}`,
          messageStyles.tool,
          false,
        );
        return;
      }
      case "progress":
        this.loader.setMessage(event.detail?.trim().slice(0, 40) || "Планирую...");
        this.setStatus(event.detail || "Планирую...", green, false);
        if (event.detail?.trim()) this.updateActivityProgress(event.detail.trim());
        return;
      case "thinking":
        this.loader.setMessage(event.detail?.slice(0, 40) || "Размышляю...");
        this.setStatus(event.detail || "Размышляю...", dim, false);
        return;
    }
  }

  async confirm(message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.loader.setMessage("Жду подтверждения...");
      this.setStatus("Жду подтверждения", yellow);
      const overlay = modalSurface();
      const overlayHeight = Math.max(10, Math.min(20, this.tui.terminal.rows - 4));
      const preview = new ScrollableText(yellow(message), Math.max(3, overlayHeight - 7));
      const previewStatus = new Text(dim(preview.pageInfo(this.tui.terminal.columns)), 1, 0);
      this.activeApprovalPreview = { preview, status: previewStatus };
      overlay.addChild(preview);
      overlay.addChild(previewStatus);
      const choices = new SelectList([
        { value: "yes", label: "Разрешить", description: "Разрешить операцию" },
        { value: "no", label: "Отклонить", description: "Оставить текущее состояние" },
      ], 2, selectTheme);
      overlay.addChild(choices);
      const close = (answer: boolean) => {
        handle.hide();
        this.activeApprovalPreview = undefined;
        this.dismissOverlay = undefined;
        this.tui.setFocus(this.editor);
        this.resumeWorkingChrome();
        resolve(answer);
      };
      choices.onSelect = (choice) => close(choice.value === "yes");
      choices.onCancel = () => close(false);
      const handle = this.tui.showOverlay(overlay, { width: "78%", minWidth: 56, maxHeight: overlayHeight, anchor: "center", margin: 2 });
      this.dismissOverlay = () => close(false);
      this.tui.setFocus(choices);
    });
  }

  async askUser(question: string, options: Array<{ label: string; description?: string }>): Promise<string> {
    return new Promise<string>((resolve) => {
      this.loader.setMessage("Жду вашего ответа");
      this.setStatus("Жду вашего ответа", yellow);
      const overlay = modalSurface();
      overlay.addChild(new Text(boldCyan(`ТРЕБУЕТСЯ ВАШ ОТВЕТ\n${question}\n`), 1, 1));
      const items: SelectItem[] = [
        ...options.map((option) => ({ value: option.label, label: option.label, description: option.description })),
        { value: "__custom_answer__", label: "Другое...", description: "Ввести свой ответ" },
      ];
      const choices = new SelectList(items, 8, selectTheme);
      overlay.addChild(choices);
      const close = (answer: string) => {
        handle.hide();
        this.dismissOverlay = undefined;
        this.tui.setFocus(this.editor);
        this.resumeWorkingChrome();
        if (answer && answer !== "[cancelled]") this.appendMessage("you", answer);
        resolve(answer);
      };
      choices.onSelect = (choice) => {
        if (choice.value === "__custom_answer__") {
          handle.hide();
          this.dismissOverlay = undefined;
          this.showQuestionInput(question, resolve);
        } else {
          close(choice.value);
        }
      };
      choices.onCancel = () => close("[cancelled]");
      const handle = this.tui.showOverlay(overlay, { width: "72%", minWidth: 52, maxHeight: "60%", anchor: "center", margin: 2 });
      this.dismissOverlay = () => close("[cancelled]");
      this.tui.setFocus(choices);
    });
  }

  async reviewPlan(plan: string, planPath: string): Promise<{ decision: "approve" | "reject" | "revise"; feedback?: string }> {
    this.appendMessage("system", `## План реализации\n\n${plan}\n\nФайл плана: ${planPath}`);
    return new Promise((resolve) => {
      this.loader.setMessage("Жду согласования плана...");
      this.setStatus("План ожидает согласования", yellow);
      const overlay = modalSurface();
      overlay.addChild(new Text(boldCyan("СОГЛАСОВАНИЕ ПЛАНА\n"), 1, 1));
      const choices = new SelectList([
        { value: "approve", label: "Одобрить", description: "Запустить coder по этому плану" },
        { value: "reject", label: "Отклонить", description: "Остановить задачу без изменений" },
        { value: "revise", label: "Другое...", description: "Предложить изменения к плану" },
      ], 3, selectTheme);
      overlay.addChild(choices);
      const close = (answer: { decision: "approve" | "reject" | "revise"; feedback?: string }) => {
        handle.hide();
        this.dismissOverlay = undefined;
        this.tui.setFocus(this.editor);
        this.resumeWorkingChrome();
        resolve(answer);
      };
      choices.onSelect = (choice) => {
        if (choice.value === "revise") {
          handle.hide();
          this.dismissOverlay = undefined;
          this.showPlanFeedbackInput(resolve);
        } else {
          close({ decision: choice.value as "approve" | "reject" });
        }
      };
      choices.onCancel = () => close({ decision: "reject" });
      const handle = this.tui.showOverlay(overlay, { width: "72%", minWidth: 54, maxHeight: 10, anchor: "center", margin: 2 });
      this.dismissOverlay = () => close({ decision: "reject" });
      this.tui.setFocus(choices);
    });
  }

  private showPlanFeedbackInput(resolve: (answer: { decision: "approve" | "reject" | "revise"; feedback?: string }) => void): void {
    const overlay = modalSurface();
    overlay.addChild(new Text(boldCyan("ПРЕДЛОЖЕНИЯ К ПЛАНУ\n"), 1, 1));
    const input = new Input();
    overlay.addChild(input);
    const close = (feedback?: string) => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
      this.resumeWorkingChrome();
      resolve(feedback ? { decision: "revise", feedback } : { decision: "reject" });
    };
    input.onSubmit = (value) => close(value.trim() || undefined);
    input.onEscape = () => close();
    const handle = this.tui.showOverlay(overlay, { width: "76%", minWidth: 56, maxHeight: 8, anchor: "center", margin: 2 });
    this.dismissOverlay = () => close();
    this.tui.setFocus(input);
  }

  private showQuestionInput(question: string, resolve: (answer: string) => void): void {
    const overlay = modalSurface();
    overlay.addChild(new Text(boldCyan(`ТРЕБУЕТСЯ ВАШ ОТВЕТ\n${question}\n`), 1, 1));
    const input = new Input();
    overlay.addChild(input);
    const close = (answer: string) => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
      this.resumeWorkingChrome();
      if (answer && answer !== "[cancelled]") this.appendMessage("you", answer);
      resolve(answer);
    };
    input.onSubmit = (answer) => close(answer.trim() || "[cancelled]");
    input.onEscape = () => close("[cancelled]");
    const handle = this.tui.showOverlay(overlay, { width: "72%", minWidth: 52, maxHeight: 8, anchor: "center", margin: 2 });
    this.dismissOverlay = () => close("[cancelled]");
    this.tui.setFocus(input);
  }

  private async handleSubmit(input: string): Promise<void> {
    const value = input.trim();
    if (!value || this.busy) return;
    if (value === "/") {
      this.editor.setText("");
      await this.showCommandPalette();
      return;
    }
    // /clear — wipe visible TUI only (does not create a new session; use /new for that).
    if (/^\/clear\s*$/i.test(value)) {
      this.editor.addToHistory(input);
      this.editor.setText("");
      this.transcript.clear();
      this.thinkingBlocks = [];
      this.liveThinking = undefined;
      this.activityBlocks = [];
      this.liveActivity = undefined;
      this.collapsibles = [];
      this.appendMessage("system", "Экран очищен. Сессия та же — /new чтобы начать новую.");
      this.setStatus("Экран очищен", dim);
      this.scheduleRender(true);
      return;
    }
    // TUI pickers for interactive commands (canonical names + aliases).
    if (/^\/(?:sessions?|resume|provider|setup|roles|plugins|models?)\s*$/i.test(value)) {
      this.editor.addToHistory(input);
      this.editor.setText("");
      try {
        if (/^\/setup\s*$/i.test(value)) {
          this.appendMessage("system", await this.options.setupReport());
          await this.showProviderPicker();
        } else if (/^\/provider\s*$/i.test(value)) await this.showProviderPicker();
        else if (/^\/models?\s*$/i.test(value)) await this.showModelPicker();
        else if (/^\/roles\s*$/i.test(value)) await this.showRolePicker();
        else if (/^\/plugins\s*$/i.test(value)) this.appendMessage("system", await this.options.listPlugins());
        else await this.showSessionPicker();
      } catch (error) {
        this.appendMessage("error", getErrorMessage(error));
      }
      return;
    }

    this.editor.addToHistory(input);
    this.editor.setText("");
    if (!value.startsWith("/")) this.appendMessage("you", input);
    // Fresh in-place activity panel for this turn (previous one is already frozen).
    this.liveActivity = undefined;
    this.beginBusy(value.startsWith("/") ? "Выполняю команду..." : "Работаю...");
    let failed = false;
    try {
      const result = await this.options.submit(input);
      this.freezeLiveActivity();
      this.finalizeThinking();
      if (result.output) this.appendMessage("fuse", result.output);
      this.refreshHeader();
      if (result.exit) this.stop();
    } catch (error) {
      failed = true;
      this.freezeLiveActivity();
      this.finalizeThinking();
      this.appendMessage("error", getErrorMessage(error));
    } finally {
      this.endBusy(failed ? "Задача завершилась с ошибкой" : "Готово", failed ? red : dim);
    }
  }

  private async showSessionPicker(): Promise<void> {
    const sessions = await this.options.listSessions();
    if (!sessions.length) {
      this.appendMessage("system", "В этом проекте нет сохраненных сессий.");
      return;
    }
    const currentId = this.options.getSession().id;
    const items: SelectItem[] = sessions.map((session) => ({
      value: session.id,
      label: session.id === currentId ? `* ${session.title}` : session.title,
      description: `${formatRelativeTime(session.updatedAt)} · ${session.id.slice(0, 8)}`,
    }));
    const list = new SelectList(items, 10, selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(boldCyan("Сохраненные сессии\n"), 1, 1));
    overlay.addChild(list);
    const handle = this.tui.showOverlay(overlay, { width: "78%", minWidth: 54, maxHeight: "60%", anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
    list.onSelect = (item) => {
      close();
      void this.resumeFromPicker(item.value);
    };
    list.onCancel = close;
    this.tui.setFocus(list);
  }

  private async resumeFromPicker(id: string): Promise<void> {
    this.beginBusy("Загружаю сессию...");
    let failed = false;
    try {
      this.appendMessage("system", await this.options.resumeSession(id));
      this.refreshHeader();
    } catch (error) {
      failed = true;
      this.appendMessage("error", getErrorMessage(error));
    } finally {
      this.endBusy(failed ? "Ошибка загрузки сессии" : "Готово", failed ? red : dim);
    }
  }

  private async showProviderPicker(): Promise<void> {
    this.beginBusy("Проверяю провайдеров...");
    let providers: TuiProvider[];
    try {
      providers = await this.options.listProviders();
    } catch (error) {
      this.endBusy("Ошибка списка провайдеров", red);
      this.appendMessage("error", getErrorMessage(error));
      return;
    }
    this.endBusy("Готово", dim);

    const currentProvider = this.options.getProvider();
    const currentModel = this.options.getModel();
    const items: SelectItem[] = [
      ...providers.map((provider) => {
        const active = provider.name === currentProvider
          || (currentProvider === "mixed" && provider.activeModel);
        const status = provider.reachable === true
          ? `online${provider.modelCount !== undefined ? ` · ${provider.modelCount} models` : ""}`
          : provider.reachable === false
            ? "offline /models"
            : "";
        const model = provider.activeModel || provider.defaultModel || "—";
        return {
          value: provider.name,
          label: active ? `* ${provider.name}` : provider.name,
          description: [
            model,
            status,
            shortHost(provider.baseUrl),
            provider.toolMode && provider.toolMode !== "auto" ? `tools:${provider.toolMode}` : "",
          ].filter(Boolean).join("  ·  "),
        };
      }),
      ...(!providers.some((provider) => provider.name === "ollama")
        ? [{ value: "__preset_ollama__", label: "+ Ollama", description: "localhost:11434/v1  ·  local" }]
        : []),
      ...(!providers.some((provider) => provider.name === "kimi")
        ? [{ value: "__preset_kimi__", label: "+ Kimi Code", description: "api.kimi.com  ·  Kimi K2.7" }]
        : []),
      ...(!providers.some((provider) => provider.name === "lmstudio")
        ? [{ value: "__preset_lmstudio__", label: "+ LM Studio", description: "localhost:1234/v1  ·  tools:text" }]
        : []),
      ...(!providers.some((provider) => provider.name === "openrouter")
        ? [{ value: "__preset_openrouter__", label: "+ OpenRouter", description: "openrouter.ai  ·  400+ models" }]
        : []),
      ...(!providers.some((provider) => provider.name === "nvidia-nim")
        ? [{ value: "__preset_nvidia_nim__", label: "+ NVIDIA NIM", description: "integrate.api.nvidia.com" }]
        : []),
      ...(!providers.some((provider) => provider.name === "openai-codex")
        ? [{ value: "__preset_openai_codex__", label: "+ OpenAI Codex", description: "Responses API" }]
        : []),
      { value: "__add_provider__", label: "+ Свой endpoint", description: "OpenAI-compatible base URL" },
    ];
    const list = new SelectList(items, Math.min(12, items.length), selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(
      boldCyan(`Провайдеры\n`) + dim(`сейчас: ${currentProvider} / ${currentModel}\n`),
      1,
      1,
    ));
    overlay.addChild(list);
    const handle = this.tui.showOverlay(overlay, { width: "82%", minWidth: 56, maxHeight: "70%", anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
    list.onSelect = (item) => {
      close();
      if (item.value === "__preset_ollama__") this.showProviderForm({
        name: "ollama",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen3:14b",
      });
      else if (item.value === "__preset_kimi__") this.showProviderForm({
        name: "kimi",
        baseUrl: "https://api.kimi.com/coding/v1",
        model: "Kimi K2.7",
      });
      else if (item.value === "__preset_lmstudio__") this.showProviderForm({
        name: "lmstudio",
        baseUrl: "http://localhost:1234/v1",
        toolMode: "text",
      });
      else if (item.value === "__preset_openrouter__") this.showProviderForm({
        name: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openai/gpt-5.2",
      });
      else if (item.value === "__preset_nvidia_nim__") this.showProviderForm({
        name: "nvidia-nim",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        model: "openai/gpt-oss-20b",
      });
      else if (item.value === "__preset_openai_codex__") this.showProviderForm({
        name: "openai-codex",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.2-codex",
        transport: "responses",
      });
      else if (item.value === "__add_provider__") this.showProviderForm();
      else void this.chooseProvider(item.value);
    };
    list.onCancel = close;
    this.tui.setFocus(list);
  }

  private async chooseProvider(name: string): Promise<void> {
    try {
      this.appendMessage("system", await this.options.selectProvider(name));
      this.refreshHeader();
      this.setStatus("Выберите модель…", cyan);
      // Immediately open model picker for the new provider — main UX improvement.
      await this.showModelPicker();
    } catch (error) {
      this.appendMessage("error", getErrorMessage(error));
    }
  }

  private async showModelPicker(): Promise<void> {
    this.beginBusy("Загружаю модели...");
    let listed: { provider: string; models: string[]; current: string; detail?: string };
    try {
      listed = await this.options.listModels();
    } catch (error) {
      this.endBusy("Не удалось загрузить модели", red);
      this.appendMessage("error", getErrorMessage(error));
      return;
    }
    this.endBusy("Готово", dim);

    if (listed.detail) this.appendMessage("system", listed.detail);
    if (!listed.models.length) {
      this.appendMessage("system", [
        `Провайдер \`${listed.provider}\` не отдал список моделей.`,
        "Задайте id вручную: `/models <id>`",
        `Текущая: ${listed.current}`,
      ].join("\n"));
      this.showModelInput(listed.provider, listed.current);
      return;
    }

    const items: SelectItem[] = [
      ...listed.models.map((model) => ({
        value: model,
        label: model === listed.current ? `* ${model}` : model,
        description: model === listed.current ? "текущая" : listed.provider,
      })),
      { value: "__custom_model__", label: "Ввести id вручную…", description: "если модели нет в списке" },
    ];
    const list = new SelectList(items, Math.min(14, items.length), selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(boldCyan(`Модели · ${listed.provider}\n`), 1, 1));
    overlay.addChild(list);
    const handle = this.tui.showOverlay(overlay, { width: "78%", minWidth: 54, maxHeight: "70%", anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
    list.onCancel = close;
    list.onSelect = (item) => {
      close();
      if (item.value === "__custom_model__") {
        this.showModelInput(listed.provider, listed.current);
        return;
      }
      void this.chooseModel(item.value);
    };
    this.tui.setFocus(list);
  }

  private showModelInput(provider: string, current: string): void {
    const overlay = modalSurface();
    const input = new Input();
    overlay.addChild(new Text(boldCyan(`Модель · ${provider}\n`), 1, 1));
    overlay.addChild(input);
    const handle = this.tui.showOverlay(overlay, { width: "72%", minWidth: 52, maxHeight: 7, anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
    input.setValue(current === "mixed" ? "" : current);
    input.onEscape = close;
    input.onSubmit = (value) => {
      const model = value.trim();
      if (!model) return;
      close();
      void this.chooseModel(model);
    };
    this.tui.setFocus(input);
  }

  private async chooseModel(model: string): Promise<void> {
    try {
      this.appendMessage("system", await this.options.selectModel(model));
      this.refreshHeader();
      this.setStatus("Готово", dim);
    } catch (error) {
      this.appendMessage("error", getErrorMessage(error));
    }
  }

  private showProviderForm(preset: Partial<{ name: string; baseUrl: string; model: string; transport: "chat_completions" | "responses"; toolMode: "auto" | "native" | "text" }> = {}): void {
    const fields: Array<{ label: string; key: "name" | "baseUrl" | "apiKey" | "model" | "toolMode"; optional?: boolean; initial?: string }> = [
      { label: "Имя провайдера", key: "name", initial: preset.name },
      { label: "Базовый URL OpenAI-совместимого API", key: "baseUrl", initial: preset.baseUrl },
      { label: "API-ключ (хранится локально, не в Git)", key: "apiKey", optional: true },
      { label: "Название модели для ролей Fuse", key: "model", initial: preset.model },
      { label: "Режим инструментов: auto, native или text", key: "toolMode", initial: preset.toolMode ?? "auto" },
    ];
    const values: Partial<{ name: string; baseUrl: string; apiKey: string; model: string; toolMode: "auto" | "native" | "text" }> = {};
    let index = 0;
    const overlay = modalSurface();
    const title = new Text();
    const input = new Input();
    overlay.addChild(title);
    overlay.addChild(input);
    const renderField = () => {
      const field = fields[index];
      title.setText(`${boldCyan("Добавить провайдера")}\n${field.label}${field.optional ? " (optional)" : ""}\n`);
      input.setValue(field.initial ?? "");
      this.tui.requestRender();
    };
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    input.onEscape = close;
    input.onSubmit = (raw) => {
      const field = fields[index];
      const value = raw.trim();
      if (!value && !field.optional) return;
      if (field.key === "baseUrl") {
        try {
          new URL(value);
        } catch {
          this.setStatus("Введите корректный базовый URL", red);
          return;
        }
      }
      if (field.key === "name" && !/^[a-zA-Z0-9_-]+$/.test(value)) {
        this.setStatus("Используйте буквы, цифры, _ или - в имени провайдера", red);
        return;
      }
      if (field.key === "toolMode" && !["auto", "native", "text"].includes(value)) {
        this.setStatus("Выберите auto, native или text", red);
        return;
      }
      if (field.key === "toolMode") values.toolMode = value as "auto" | "native" | "text";
      else values[field.key] = value;
      index += 1;
      if (index < fields.length) {
        renderField();
        return;
      }
      close();
      void this.saveProvider(values, preset.transport);
    };
    const handle = this.tui.showOverlay(overlay, { width: "70%", minWidth: 52, maxHeight: 8, anchor: "center", margin: 2 });
    this.dismissOverlay = close;
    this.tui.setFocus(input);
    renderField();
  }

  private async saveProvider(values: Partial<{ name: string; baseUrl: string; apiKey: string; model: string; toolMode: "auto" | "native" | "text" }>, transport?: "chat_completions" | "responses"): Promise<void> {
    try {
      const name = values.name ?? "";
      const baseUrl = values.baseUrl ?? "";
      const message = await this.options.addProvider({ name, baseUrl, apiKey: values.apiKey || undefined, model: values.model ?? "", transport, toolMode: values.toolMode });
      this.appendMessage("system", message);
      this.refreshHeader();
      this.setStatus("Готово", dim);
    } catch (error) {
      this.appendMessage("error", getErrorMessage(error));
    }
  }

  /** Dashboard of all roles — edit one, loop back, bulk actions. */
  private async showRolePicker(): Promise<void> {
    const roles = await this.options.listRoleConfigs();
    const unique = new Set(roles.map((role) => `${role.provider}/${role.model}`));
    const summary = unique.size === 1
      ? `все → ${[...unique][0]}`
      : `${unique.size} разных связок`;
    const coder = roles.find((role) => role.role === "coder");

    const items: SelectItem[] = [
      ...roles.map((role) => ({
        value: role.role,
        label: role.role,
        description: `${role.provider} / ${role.model}${ROLE_HINTS[role.role] ? `  ·  ${ROLE_HINTS[role.role]}` : ""}`,
      })),
      ...(coder
        ? [{
          value: "__apply_coder__",
          label: "⟳  coder → все роли",
          description: `скопировать ${coder.provider} / ${coder.model}`,
        }]
        : []),
      {
        value: "__apply_provider_defaults__",
        label: "⟳  defaultModel каждого провайдера",
        description: "для каждой роли взять defaultModel её провайдера",
      },
      { value: "__done__", label: "✓  Готово", description: "закрыть настройки ролей" },
    ];

    const list = new SelectList(items, Math.min(12, items.length), selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(
      `${boldCyan("Роли")}\n${dim(summary)}\n${dim("Enter — изменить · Esc — закрыть")}\n`,
      1,
      1,
    ));
    overlay.addChild(list);
    const handle = this.tui.showOverlay(overlay, { width: "84%", minWidth: 58, maxHeight: "75%", anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
    list.onCancel = close;
    list.onSelect = (item) => {
      close();
      if (item.value === "__done__") return;
      if (item.value === "__apply_coder__") {
        void this.applyCoderToAllRoles(roles);
        return;
      }
      if (item.value === "__apply_provider_defaults__") {
        void this.applyProviderDefaultsToRoles(roles);
        return;
      }
      const role = roles.find((candidate) => candidate.role === item.value);
      if (role) void this.showRoleProviderPicker(role);
    };
    this.tui.setFocus(list);
  }

  private async applyCoderToAllRoles(roles: Array<{ role: string; provider: string; model: string }>): Promise<void> {
    const coder = roles.find((role) => role.role === "coder");
    if (!coder) return;
    this.beginBusy("Применяю coder → все роли...");
    const lines: string[] = [];
    try {
      for (const role of roles) {
        if (role.role === "coder") continue;
        lines.push(await this.options.configureRole(role.role, coder.provider, coder.model));
      }
      this.appendMessage("system", lines.length
        ? `Все роли = coder (${coder.provider} / ${coder.model})\n${lines.join("\n")}`
        : "Нечего обновлять.");
      this.refreshHeader();
    } catch (error) {
      this.appendMessage("error", getErrorMessage(error));
    } finally {
      this.endBusy("Готово", dim);
    }
    await this.showRolePicker();
  }

  private async applyProviderDefaultsToRoles(roles: Array<{ role: string; provider: string; model: string }>): Promise<void> {
    const providers = await this.options.listProviders();
    this.beginBusy("Ставлю defaultModel провайдеров...");
    const lines: string[] = [];
    try {
      for (const role of roles) {
        const provider = providers.find((item) => item.name === role.provider);
        const model = provider?.defaultModel?.trim();
        if (!model || model === role.model) continue;
        lines.push(await this.options.configureRole(role.role, role.provider, model));
      }
      this.appendMessage("system", lines.length
        ? `Обновлено ${lines.length} ролей:\n${lines.join("\n")}`
        : "У всех ролей уже defaultModel провайдера.");
      this.refreshHeader();
    } catch (error) {
      this.appendMessage("error", getErrorMessage(error));
    } finally {
      this.endBusy("Готово", dim);
    }
    await this.showRolePicker();
  }

  private async showRoleProviderPicker(role: { role: string; provider: string; model: string }): Promise<void> {
    this.beginBusy("Провайдеры...");
    let providers: TuiProvider[];
    try {
      providers = await this.options.listProviders();
    } catch (error) {
      this.endBusy("Ошибка", red);
      this.appendMessage("error", getErrorMessage(error));
      await this.showRolePicker();
      return;
    }
    this.endBusy("Готово", dim);

    const list = new SelectList([
      ...providers.map((provider) => ({
        value: provider.name,
        label: provider.name === role.provider ? `* ${provider.name}` : provider.name,
        description: [
          provider.defaultModel ?? "—",
          provider.reachable === true ? `online${provider.modelCount !== undefined ? ` · ${provider.modelCount}` : ""}` : provider.reachable === false ? "offline" : "",
          shortHost(provider.baseUrl),
        ].filter(Boolean).join("  ·  "),
      })),
      { value: "__back__", label: "←  Назад к ролям", description: "без изменений" },
    ], Math.min(10, providers.length + 1), selectTheme);

    const overlay = modalSurface();
    overlay.addChild(new Text(
      `${boldCyan(`${role.role}: провайдер`)}\n${dim(`сейчас ${role.provider} / ${role.model}`)}\n`,
      1,
      1,
    ));
    overlay.addChild(list);
    const handle = this.tui.showOverlay(overlay, { width: "82%", minWidth: 56, maxHeight: "70%", anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
    list.onCancel = () => {
      close();
      void this.showRolePicker();
    };
    list.onSelect = (item) => {
      close();
      if (item.value === "__back__") {
        void this.showRolePicker();
        return;
      }
      const provider = providers.find((candidate) => candidate.name === item.value);
      if (provider) void this.showRoleModelPicker(role.role, provider, role.model);
      else void this.showRolePicker();
    };
    this.tui.setFocus(list);
  }

  /** Model list from provider /models API + manual id. Returns to roles dashboard. */
  private async showRoleModelPicker(role: string, provider: TuiProvider, currentModel: string): Promise<void> {
    this.beginBusy(`Модели ${provider.name}...`);
    let listed: { provider: string; models: string[]; current: string; detail?: string };
    try {
      listed = await this.options.listModels(provider.name);
    } catch (error) {
      this.endBusy("Список моделей недоступен", yellow);
      this.appendMessage("system", `Не удалось загрузить /models: ${getErrorMessage(error)}. Введите id вручную.`);
      this.showRoleModelForm(role, provider, currentModel);
      return;
    }
    this.endBusy("Готово", dim);

    if (listed.detail) this.appendMessage("system", listed.detail);

    const preferred = currentModel || provider.defaultModel || "";
    const items: SelectItem[] = [
      ...listed.models.map((model) => ({
        value: model,
        label: model === preferred ? `* ${model}` : model,
        description: model === preferred ? "текущая" : provider.name,
      })),
      ...(provider.defaultModel && !listed.models.includes(provider.defaultModel)
        ? [{ value: provider.defaultModel, label: provider.defaultModel, description: "defaultModel провайдера" }]
        : []),
      { value: "__custom__", label: "Ввести id вручную…", description: "если модели нет в списке" },
      { value: "__back__", label: "←  Назад", description: "к выбору провайдера" },
    ];

    const list = new SelectList(items, Math.min(14, items.length), selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(
      `${boldCyan(`${role}: модель · ${provider.name}`)}\n${dim(listed.models.length ? `${listed.models.length} с API` : "список пуст — введите id")}\n`,
      1,
      1,
    ));
    overlay.addChild(list);
    const handle = this.tui.showOverlay(overlay, { width: "82%", minWidth: 56, maxHeight: "75%", anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
    list.onCancel = () => {
      close();
      void this.showRoleProviderPicker({ role, provider: provider.name, model: currentModel });
    };
    list.onSelect = (item) => {
      close();
      if (item.value === "__back__") {
        void this.showRoleProviderPicker({ role, provider: provider.name, model: currentModel });
        return;
      }
      if (item.value === "__custom__") {
        this.showRoleModelForm(role, provider, preferred || currentModel);
        return;
      }
      void this.saveRoleAndReturn(role, provider.name, item.value);
    };
    this.tui.setFocus(list);
  }

  private showRoleModelForm(role: string, provider: TuiProvider, currentModel: string): void {
    const overlay = modalSurface();
    const input = new Input();
    overlay.addChild(new Text(
      `${boldCyan(`${role}: модель`)}\n${dim(`провайдер ${provider.name}`)}\n`,
      1,
      1,
    ));
    overlay.addChild(input);
    const handle = this.tui.showOverlay(overlay, { width: "72%", minWidth: 52, maxHeight: 8, anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
    input.setValue(currentModel || provider.defaultModel || "");
    input.onEscape = () => {
      close();
      void this.showRoleModelPicker(role, provider, currentModel);
    };
    input.onSubmit = (value) => {
      const model = value.trim();
      if (!model) return;
      close();
      void this.saveRoleAndReturn(role, provider.name, model);
    };
    this.tui.setFocus(input);
  }

  private async saveRoleAndReturn(role: string, provider: string, model: string): Promise<void> {
    try {
      this.appendMessage("system", await this.options.configureRole(role, provider, model));
      this.refreshHeader();
      this.setStatus(`${role} → ${provider}/${model}`, green);
    } catch (error) {
      this.appendMessage("error", getErrorMessage(error));
    }
    // Loop back so you can set the next role without retyping /roles.
    await this.showRolePicker();
  }

  /** Public system message (e.g. proactive KAIROS tips). */
  appendSystem(content: string): void {
    this.appendMessage("system", content);
  }

  private appendMessage(label: MessageLabel, content: string): void {
    const color = messageStyles[label];
    this.transcript.addChild(new Text(color(label.toUpperCase()), 1, 1));
    this.transcript.addChild(new Markdown(content, 1, 0, markdownTheme));
    this.transcript.addChild(new Text(""));
    this.scheduleRender(true);
  }

  private showWelcome(): void {
    this.appendMessage("system", [
      "Добро пожаловать в Fuse.",
      "",
      "Часто нужно:",
      "  /roles     — модель на роль",
      "  /models    — одна модель на всех",
      "  /provider  — провайдер",
      "  /yolo      — auto-approve",
      "  /help      — полный список",
      "",
      "Ctrl+K — палитра · Ctrl+O — свернуть thinking/tools",
    ].join("\n"));
  }

  private ensureLiveActivity(): LiveActivityPanel {
    if (this.liveActivity && !this.liveActivity.frozen) return this.liveActivity;
    const heading = new Text(messageStyles.tool("АКТИВНОСТЬ"), 1, 0);
    const body = new Text("", 1, 0);
    const spacer = new Text("");
    this.transcript.addChild(heading);
    this.transcript.addChild(body);
    this.transcript.addChild(spacer);
    const panel: LiveActivityPanel = {
      heading,
      body,
      spacer,
      tools: [],
      frozen: false,
      // Live view shows tools; after freeze defaults to collapsed.
      expanded: true,
      startedAt: Date.now(),
    };
    this.liveActivity = panel;
    this.activityBlocks.push(panel);
    if (this.activityBlocks.length > 24) this.activityBlocks.shift();
    this.registerCollapsible({
      kind: "activity",
      getExpanded: () => panel.expanded,
      setExpanded: (value) => {
        panel.expanded = value;
        this.paintActivityPanel(panel);
      },
    });
    return panel;
  }

  private paintActivityPanel(panel: LiveActivityPanel): void {
    const elapsedMs = panel.elapsedMs ?? (Date.now() - panel.startedAt);
    const elapsed = formatDuration(elapsedMs);
    const summary = formatActivitySummary(panel.tools, elapsedMs) || "…";
    const running = panel.tools.find((tool) => tool.status === "running");

    if (panel.frozen && !panel.expanded) {
      panel.heading.setText(dim(`АКТИВНОСТЬ  ▸  ${summary}  ·  Ctrl+O`));
      panel.body.setText("");
      this.scheduleRender(true);
      return;
    }

    if (panel.frozen && panel.expanded) {
      panel.heading.setText(dim(`АКТИВНОСТЬ  ▾  ${summary}  ·  Ctrl+O свернуть`));
      const body = formatActivityBody(panel.tools, undefined, 20);
      panel.body.setText(body ? yellow(body) : "");
      this.scheduleRender(true);
      return;
    }

    // Live (not frozen): compact by default when collapsed mid-run, full when expanded.
    const title = running
      ? `АКТИВНОСТЬ  ${panel.expanded ? "▾" : "▸"}  ${running.name}${running.meta ? ` ${clipMeta(running.meta, 40)}` : ""}  ·  ${elapsed}`
      : `АКТИВНОСТЬ  ${panel.expanded ? "▾" : "▸"}  ${summary}  ·  ${elapsed}`;
    panel.heading.setText(messageStyles.tool(`${title}  ·  Ctrl+O`));
    if (panel.expanded) {
      const body = formatActivityBody(panel.tools, panel.progress, 8);
      panel.body.setText(body ? yellow(body) : "");
    } else {
      // Collapsed live: only current running line.
      if (running) {
        panel.body.setText(yellow(formatToolLine(running, true)));
      } else {
        panel.body.setText("");
      }
    }
    this.scheduleRender();
  }

  private paintLiveActivity(): void {
    if (this.liveActivity && !this.liveActivity.frozen) this.paintActivityPanel(this.liveActivity);
  }

  private updateActivityTool(role: string, detail: string): void {
    const panel = this.ensureLiveActivity();
    const parsed = parseToolEventDetail(detail);
    if (parsed.status === "running") {
      panel.tools = panel.tools.filter((tool) => tool.status !== "running");
      panel.tools.push({
        name: parsed.name,
        role,
        status: "running",
        meta: parsed.meta,
        startedAt: Date.now(),
      });
      if (panel.tools.length > 20) panel.tools = panel.tools.slice(-20);
      this.paintLiveActivity();
      return;
    }
    const open = [...panel.tools].reverse().find((tool) =>
      tool.status === "running" && tool.name === parsed.name && tool.role === role,
    );
    if (open) {
      open.status = parsed.status;
      open.meta = parsed.meta || open.meta;
      open.elapsedMs = Math.max(0, Date.now() - open.startedAt);
    } else {
      panel.tools.push({
        name: parsed.name,
        role,
        status: parsed.status,
        meta: parsed.meta,
        startedAt: Date.now(),
        elapsedMs: 0,
      });
      if (panel.tools.length > 20) panel.tools = panel.tools.slice(-20);
    }
    this.paintLiveActivity();
  }

  private updateActivityProgress(detail: string): void {
    const panel = this.ensureLiveActivity();
    panel.progress = detail;
    this.paintLiveActivity();
  }

  /** Freeze live panel: collapsed one-liner by default, expandable with Ctrl+O. */
  private freezeLiveActivity(): void {
    const panel = this.liveActivity;
    if (!panel || panel.frozen) return;
    panel.tools = panel.tools.map((tool) =>
      tool.status === "running"
        ? { ...tool, status: "done" as const, elapsedMs: Math.max(0, Date.now() - tool.startedAt) }
        : tool,
    );
    if (!panel.tools.length && !panel.progress) {
      this.transcript.removeChild(panel.heading);
      this.transcript.removeChild(panel.body);
      this.transcript.removeChild(panel.spacer);
      this.activityBlocks = this.activityBlocks.filter((item) => item !== panel);
      this.rebuildCollapsibles();
      this.liveActivity = undefined;
      this.scheduleRender(true);
      return;
    }
    panel.elapsedMs = Date.now() - panel.startedAt;
    panel.progress = undefined;
    panel.frozen = true;
    panel.expanded = false; // default: collapsed one-liner
    this.liveActivity = undefined;
    this.paintActivityPanel(panel);
  }

  private rebuildCollapsibles(): void {
    this.collapsibles = [];
    for (const block of this.thinkingBlocks) {
      this.registerCollapsible({
        kind: "thinking",
        getExpanded: () => block.expanded,
        setExpanded: (value) => {
          block.expanded = value;
          this.applyThinkingVisibility(block);
        },
      });
    }
    for (const panel of this.activityBlocks) {
      this.registerCollapsible({
        kind: "activity",
        getExpanded: () => panel.expanded,
        setExpanded: (value) => {
          panel.expanded = value;
          this.paintActivityPanel(panel);
        },
      });
    }
  }

  private applyThinkingVisibility(block: ThinkingBlock): void {
    const chars = block.text.length;
    const lines = block.text ? block.text.split("\n").length : 0;
    if (block.expanded) {
      block.heading.setText(dim(`${block.role.toUpperCase()} РАЗМЫШЛЕНИЕ  ▾  ${lines} стр. · Ctrl+O свернуть`));
      block.component.setText(dim(block.text || "…"));
      this.scheduleRender(true);
      return;
    }
    if (block.streaming) {
      block.heading.setText(dim(`${block.role.toUpperCase()} РАЗМЫШЛЕНИЕ  ▸ … · Ctrl+O`));
      const last = block.text.split("\n").filter(Boolean).at(-1) ?? "…";
      block.component.setText(dim(`  ${last.slice(0, 100)}${last.length > 100 ? "…" : ""}`));
      this.scheduleRender();
      return;
    }
    block.heading.setText(dim(`${block.role.toUpperCase()} РАЗМЫШЛЕНИЕ  ▸  ${formatChars(chars)} · Ctrl+O раскрыть`));
    block.component.setText("");
    this.scheduleRender(true);
  }

  private appendThinking(role: string, delta: string): void {
    if (!delta) return;
    if (!this.liveThinking || this.liveThinking.role !== role || !this.liveThinking.streaming) {
      this.finalizeThinking();
      const component = new Text("", 1, 0);
      const heading = new Text("", 1, 1);
      this.transcript.addChild(heading);
      this.transcript.addChild(component);
      this.transcript.addChild(new Text(""));
      const block: ThinkingBlock = { role, text: "", component, heading, expanded: false, streaming: true };
      this.thinkingBlocks.push(block);
      this.liveThinking = block;
      if (this.thinkingBlocks.length > 24) this.thinkingBlocks.shift();
      this.registerCollapsible({
        kind: "thinking",
        getExpanded: () => block.expanded,
        setExpanded: (value) => {
          block.expanded = value;
          this.applyThinkingVisibility(block);
        },
      });
    }
    this.liveThinking.text += delta;
    const limit = 8_000;
    if (this.liveThinking.text.length > limit) {
      this.liveThinking.text = this.liveThinking.text.slice(-limit);
    }
    this.applyThinkingVisibility(this.liveThinking);
  }

  private finalizeThinking(role?: string): void {
    if (!this.liveThinking || (role && this.liveThinking.role !== role)) return;
    this.liveThinking.streaming = false;
    this.liveThinking.expanded = false;
    this.applyThinkingVisibility(this.liveThinking);
    this.liveThinking = undefined;
  }

  private async showCommandPalette(): Promise<void> {
    const items: SelectItem[] = getPaletteItems();
    const list = new SelectList(items, 14, selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(
      `${boldCyan("Команды")}\n${dim("/help · группы: сессия · модели · режим · память")}\n`,
      1,
      1,
    ));
    overlay.addChild(list);
    const handle = this.tui.showOverlay(overlay, { width: "78%", minWidth: 54, maxHeight: "70%", anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
   list.onSelect = (item) => {
     close();
     this.editor.setText(`${item.value} `);
      this.tui.requestRender();
   };
    list.onCancel = close;
    this.tui.setFocus(list);
  }

  refreshHeader(): void {
    const session = this.options.getSession();
    const mode = this.options.getMode();
    const provider = this.options.getProvider();
    const model = this.options.getModel();
    const yolo = this.options.getYolo?.() ?? false;
    const msgs = session.messageCount > 0 ? `  ${dim(`${session.messageCount} msg`)}` : "";
    const yoloBadge = yolo ? `  ${red("YOLO")}` : "";
    this.header.setText(
      `${boldCyan("FUSE")}  ${cyan(mode.toUpperCase())}  ${yellow(provider)}/${white(model)}${yoloBadge}  ${dim(session.id.slice(0, 8))}${msgs}  ${white(session.title)}`,
    );
    this.modeFooter.setText(
      yolo
        ? `РЕЖИМ: ${mode.toUpperCase()} · YOLO · ${provider}/${model}`
        : `РЕЖИМ: ${mode.toUpperCase()} · ${provider}/${model}`,
    );
    this.scheduleRender(true);
  }

  private setStatus(message: string, color: (text: string) => string, immediate = true): void {
    this.status.setText(color(message));
    this.scheduleRender(immediate);
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    this.loader.stop();
    this.tui.stop();
    this.resolveExit?.();
  }
}

function clipMeta(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function shortHost(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.host + (url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/v1/" ? "" : url.pathname.replace(/\/$/, ""));
  } catch {
    return baseUrl;
  }
}

function formatChars(count: number): string {
  if (count < 1000) return `${count} симв.`;
  return `${(count / 1000).toFixed(1)}k симв.`;
}

function formatRelativeTime(value: string): string {
  const age = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes}м назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}д назад`;
  return value.slice(0, 10);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
