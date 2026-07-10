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
} from "@earendil-works/pi-tui";
import { isExactSlashCommand, SLASH_COMMANDS } from "./slash-commands.ts";

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
}

export interface InteractiveTuiOptions {
  workspace: string;
  submit(input: string): Promise<{ output?: string; exit?: boolean }>;
  listSessions(): Promise<TuiSession[]>;
  resumeSession(id: string): Promise<string>;
  getSession(): { id: string; title: string; messageCount: number };
  getMode(): "team" | "direct" | "orchestrate" | "council-plan" | "council-review";
  getProvider(): string;
  listProviders(): Promise<TuiProvider[]>;
  selectProvider(name: string): Promise<string>;
  addProvider(provider: { name: string; baseUrl: string; apiKey?: string; model: string; transport?: "chat_completions" | "responses" }): Promise<string>;
  listRoleConfigs(): Promise<Array<{ role: string; provider: string; model: string }>>;
  configureRole(role: string, provider: string, model: string): Promise<string>;
  setupReport(): Promise<string>;
}

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
  private liveThinking?: { role: string; text: string; component: Text; heading: Text; expanded: boolean };

  constructor(options: InteractiveTuiOptions) {
    this.options = options;
    this.tui = new TUI(new ProcessTerminal());
    this.loader = new Loader(this.tui, cyan, dim, "", { frames: [] });
    this.editor = new Editor(this.tui, { borderColor: cyan, selectList: selectTheme }, { paddingX: 1, autocompleteMaxVisible: 8 });
    const autocomplete = new CombinedAutocompleteProvider(
      SLASH_COMMANDS.map((command) => ({
        name: command.name,
        description: command.argumentHint ? `${command.description} ${command.argumentHint}` : command.description,
        argumentHint: command.argumentHint,
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
    this.help.setText(dim("Enter отправить · Tab подсказки · Ctrl+K команды · Esc закрыть · Ctrl+C выход"));
    this.root.addChild(this.help);
    this.root.addChild(this.editor);
    this.root.addChild(this.modeFooter);
    this.tui.addChild(this.root);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => {
      if (data === "\x03") {
        if (this.busy) {
          this.setStatus("Агент еще работает. Дождитесь завершения текущей задачи.", yellow);
        } else {
          this.stop();
        }
        return { consume: true };
      }
      if (data === "\x0f" && this.liveThinking) {
        this.toggleThinking();
        return { consume: true };
      }
      if (data === "\x0b" && !this.busy) {
        void this.showCommandPalette();
        return { consume: true };
      }
      if (data === "\x1b" && this.dismissOverlay) {
        this.dismissOverlay();
        return { consume: true };
      }
      return undefined;
    });
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
    this.tui.requestRender();
  }

  reportEvent(event: { type: "thinking" | "thinking_delta" | "thinking_done" | "tool" | "progress"; role: string; detail: string }): void {
    switch (event.type) {
      case "thinking_delta":
        this.loader.setMessage("Размышляю...");
        this.setStatus("Размышляю...", dim);
        this.appendThinking(event.role, event.detail);
        return;
      case "thinking_done":
        this.finalizeThinking(event.role);
        return;
      case "tool":
        this.loader.setMessage("Выполняю инструмент...");
        this.setStatus(`Выполняю: ${event.detail}`, messageStyles.tool);
        return;
      case "progress":
        this.loader.setMessage("Планирую...");
        this.setStatus(event.detail || "Планирую...", green);
        return;
      case "thinking":
        this.loader.setMessage("Размышляю...");
        this.setStatus(event.detail || "Размышляю...", dim);
        return;
    }
  }

  async confirm(message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.loader.setMessage("Жду подтверждения...");
      this.setStatus("Жду подтверждения", yellow);
      const overlay = modalSurface();
      overlay.addChild(new Text(yellow(`${message}\n\n`), 1, 1));
      const choices = new SelectList([
        { value: "yes", label: "Разрешить", description: "Разрешить операцию" },
        { value: "no", label: "Отклонить", description: "Оставить текущее состояние" },
      ], 2, selectTheme);
      overlay.addChild(choices);
      const close = (answer: boolean) => {
        handle.hide();
        this.dismissOverlay = undefined;
        this.tui.setFocus(this.editor);
        this.loader.setMessage("Размышляю...");
        this.setStatus("Работаю...", cyan);
        resolve(answer);
      };
      choices.onSelect = (choice) => close(choice.value === "yes");
      choices.onCancel = () => close(false);
      const handle = this.tui.showOverlay(overlay, { width: "60%", minWidth: 44, maxHeight: 8, anchor: "center", margin: 2 });
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
        this.loader.setMessage("Размышляю...");
        this.setStatus("Работаю...", cyan);
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

  private showQuestionInput(question: string, resolve: (answer: string) => void): void {
    const overlay = modalSurface();
    overlay.addChild(new Text(boldCyan(`ТРЕБУЕТСЯ ВАШ ОТВЕТ\n${question}\n`), 1, 1));
    const input = new Input();
    overlay.addChild(input);
    const close = (answer: string) => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
      this.loader.setMessage("Размышляю...");
      this.setStatus("Работаю...", cyan);
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
    if (/^\/clear$/i.test(value)) {
      this.transcript.clear();
      this.setStatus("История очищена", dim);
      this.tui.requestRender();
      return;
    }
    if (/^\/(?:sessions?|resume|provider|setup|roles)(?:\s*)$/i.test(value)) {
      this.editor.addToHistory(input);
      this.editor.setText("");
      try {
        if (/^\/setup\s*$/i.test(value)) {
          this.appendMessage("system", await this.options.setupReport());
          await this.showProviderPicker();
        } else if (/^\/provider\s*$/i.test(value)) await this.showProviderPicker();
        else if (/^\/roles\s*$/i.test(value)) await this.showRolePicker();
        else await this.showSessionPicker();
      } catch (error) {
        this.appendMessage("error", getErrorMessage(error));
      }
      return;
    }

    this.busy = true;
    this.editor.disableSubmit = true;
    this.editor.addToHistory(input);
    this.editor.setText("");
    if (!value.startsWith("/")) this.appendMessage("you", input);
   this.loader.setMessage(value.startsWith("/") ? "Выполняю команду..." : "Размышляю...");
    this.loader.setIndicator({ frames: ["-", "\\", "|", "/"], intervalMs: 120 });
   this.loader.start();
    this.setStatus("Работаю...", cyan);
    let failed = false;
    try {
      const result = await this.options.submit(input);
      if (result.output) this.appendMessage("fuse", result.output);
      this.refreshHeader();
      if (result.exit) this.stop();
      else if (!result.output) this.setStatus("Готово", dim);
    } catch (error) {
      failed = true;
      this.appendMessage("error", getErrorMessage(error));
      this.setStatus("Задача завершилась с ошибкой", red);
   } finally {
     this.loader.stop();
      this.loader.setIndicator({ frames: [] });
     this.loader.setMessage("");
      if (!failed) this.setStatus("Готово", dim);
      this.busy = false;
      this.editor.disableSubmit = false;
      this.tui.setFocus(this.editor);
      this.tui.requestRender();
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
    this.busy = true;
    this.editor.disableSubmit = true;
   this.loader.setMessage("Загружаю сессию");
    this.loader.setIndicator({ frames: ["-", "\\", "|", "/"], intervalMs: 120 });
   this.loader.start();
    try {
      this.appendMessage("system", await this.options.resumeSession(id));
      this.refreshHeader();
      this.setStatus("Готово", dim);
    } catch (error) {
      this.appendMessage("error", getErrorMessage(error));
   } finally {
     this.loader.stop();
      this.loader.setIndicator({ frames: [] });
     this.loader.setMessage("");
      this.busy = false;
      this.editor.disableSubmit = false;
      this.tui.setFocus(this.editor);
      this.tui.requestRender();
    }
  }

  private async showProviderPicker(): Promise<void> {
    const providers = await this.options.listProviders();
    const currentProvider = this.options.getProvider();
    const items: SelectItem[] = [
      ...providers.map((provider) => ({
        value: provider.name,
        label: provider.name === currentProvider ? `> ${provider.name}` : provider.name,
        description: `${provider.baseUrl}${provider.apiKeyEnv ? `  ${provider.apiKeyEnv}` : ""}`,
      })),
      ...(!providers.some((provider) => provider.name === "kimi")
        ? [{ value: "__preset_kimi__", label: "Kimi Code", description: "api.kimi.com/coding/v1  Kimi K2.7" }]
        : []),
      ...(!providers.some((provider) => provider.name === "openrouter")
        ? [{ value: "__preset_openrouter__", label: "OpenRouter", description: "400+ моделей через OpenAI-compatible API" }]
        : []),
      ...(!providers.some((provider) => provider.name === "nvidia-nim")
        ? [{ value: "__preset_nvidia_nim__", label: "NVIDIA NIM", description: "integrate.api.nvidia.com/v1" }]
        : []),
      ...(!providers.some((provider) => provider.name === "openai-codex")
        ? [{ value: "__preset_openai_codex__", label: "OpenAI Codex API", description: "Responses API; нужен OpenAI API key" }]
        : []),
      { value: "__add_provider__", label: "Добавить провайдера", description: "Configure an OpenAI-compatible endpoint" },
    ];
    const list = new SelectList(items, 10, selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(boldCyan("Настроенные провайдеры\n"), 1, 1));
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
      if (item.value === "__preset_kimi__") this.showProviderForm({
        name: "kimi",
        baseUrl: "https://api.kimi.com/coding/v1",
        model: "Kimi K2.7",
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
      this.setStatus("Готово", dim);
    } catch (error) {
      this.appendMessage("error", getErrorMessage(error));
    }
  }

  private showProviderForm(preset: Partial<{ name: string; baseUrl: string; model: string; transport: "chat_completions" | "responses" }> = {}): void {
    const fields: Array<{ label: string; key: "name" | "baseUrl" | "apiKey" | "model"; optional?: boolean; initial?: string }> = [
      { label: "Имя провайдера", key: "name", initial: preset.name },
      { label: "Базовый URL OpenAI-совместимого API", key: "baseUrl", initial: preset.baseUrl },
      { label: "API-ключ (хранится локально, не в Git)", key: "apiKey", optional: true },
      { label: "Название модели для ролей Fuse", key: "model", initial: preset.model },
    ];
    const values: Partial<{ name: string; baseUrl: string; apiKey: string; model: string }> = {};
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
      values[field.key] = value;
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

  private async saveProvider(values: Partial<{ name: string; baseUrl: string; apiKey: string; model: string }>, transport?: "chat_completions" | "responses"): Promise<void> {
    try {
      const name = values.name ?? "";
      const baseUrl = values.baseUrl ?? "";
      const message = await this.options.addProvider({ name, baseUrl, apiKey: values.apiKey || undefined, model: values.model ?? "", transport });
      this.appendMessage("system", message);
      this.refreshHeader();
      this.setStatus("Готово", dim);
    } catch (error) {
      this.appendMessage("error", getErrorMessage(error));
    }
  }

  private async showRolePicker(): Promise<void> {
    const roles = await this.options.listRoleConfigs();
    const list = new SelectList(roles.map((role) => ({ value: role.role, label: role.role, description: `${role.provider} / ${role.model}` })), 8, selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(boldCyan("Настройка ролей\n"), 1, 1));
    overlay.addChild(list);
    const handle = this.tui.showOverlay(overlay, { width: "72%", minWidth: 52, maxHeight: "60%", anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
    list.onCancel = close;
    list.onSelect = (item) => {
      const role = roles.find((candidate) => candidate.role === item.value);
      close();
      if (role) void this.showRoleProviderPicker(role);
    };
    this.tui.setFocus(list);
  }

  private async showRoleProviderPicker(role: { role: string; provider: string; model: string }): Promise<void> {
    const providers = await this.options.listProviders();
    const list = new SelectList(providers.map((provider) => ({
      value: provider.name,
      label: provider.name === role.provider ? `> ${provider.name}` : provider.name,
      description: provider.defaultModel ?? provider.baseUrl,
    })), 9, selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(boldCyan(`${role.role}: провайдер\n`), 1, 1));
    overlay.addChild(list);
    const handle = this.tui.showOverlay(overlay, { width: "72%", minWidth: 52, maxHeight: "60%", anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
    list.onCancel = close;
    list.onSelect = (item) => {
      const provider = providers.find((candidate) => candidate.name === item.value);
      close();
      if (provider) this.showRoleModelForm(role.role, provider, role.model);
    };
    this.tui.setFocus(list);
  }

  private showRoleModelForm(role: string, provider: TuiProvider, currentModel: string): void {
    const overlay = modalSurface();
    const input = new Input();
    overlay.addChild(new Text(boldCyan(`${role}: модель для ${provider.name}\n`), 1, 1));
    overlay.addChild(input);
    const handle = this.tui.showOverlay(overlay, { width: "72%", minWidth: 52, maxHeight: 7, anchor: "center", margin: 2 });
    const close = () => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
    };
    this.dismissOverlay = close;
    input.setValue(provider.defaultModel ?? currentModel);
    input.onEscape = close;
    input.onSubmit = (value) => {
      const model = value.trim();
      if (!model) return;
      close();
      void this.options.configureRole(role, provider.name, model).then((message) => {
        this.appendMessage("system", message);
        this.refreshHeader();
      }).catch((error) => this.appendMessage("error", getErrorMessage(error)));
    };
    this.tui.setFocus(input);
  }

  private appendMessage(label: MessageLabel, content: string): void {
    const color = messageStyles[label];
    this.transcript.addChild(new Text(color(label.toUpperCase()), 1, 1));
    this.transcript.addChild(new Markdown(content, 1, 0, markdownTheme));
    this.transcript.addChild(new Text(""));
    this.tui.requestRender();
  }

  private showWelcome(): void {
    this.appendMessage("system", "Добро пожаловать в Fuse.\n\nНажмите Ctrl+K или введите `/`, чтобы открыть команды. Используйте `/provider` для смены модели или `/sessions` для продолжения работы.");
  }

  private appendThinking(role: string, delta: string): void {
    if (!delta) return;
    if (!this.liveThinking || this.liveThinking.role !== role) {
      this.finalizeThinking();
      const component = new Text("", 1, 0);
      const heading = new Text(dim(`${role.toUpperCase()} РАЗМЫШЛЕНИЕ  (Ctrl+O раскрыть)`), 1, 1);
      this.transcript.addChild(heading);
      this.transcript.addChild(component);
      this.transcript.addChild(new Text(""));
      this.liveThinking = { role, text: "", component, heading, expanded: false };
    }
    this.liveThinking.text += delta;
    const limit = 6_000;
    if (this.liveThinking.text.length > limit) {
      this.liveThinking.text = this.liveThinking.text.slice(-limit);
    }
    const visible = this.liveThinking.expanded
      ? this.liveThinking.text
      : this.liveThinking.text.split("\n").slice(-12).join("\n");
    this.liveThinking.component.setText(dim(visible));
    this.tui.requestRender();
  }

  private finalizeThinking(role?: string): void {
    if (!this.liveThinking || (role && this.liveThinking.role !== role)) return;
    this.liveThinking = undefined;
    this.tui.requestRender();
  }

  private toggleThinking(): void {
    if (!this.liveThinking) return;
    this.liveThinking.expanded = !this.liveThinking.expanded;
    this.liveThinking.heading.setText(dim(`${this.liveThinking.role.toUpperCase()} РАЗМЫШЛЕНИЕ  (Ctrl+O: ${this.liveThinking.expanded ? "свернуть" : "раскрыть"})`));
    const visible = this.liveThinking.expanded
      ? this.liveThinking.text
      : this.liveThinking.text.split("\n").slice(-12).join("\n");
    this.liveThinking.component.setText(dim(visible));
    this.tui.requestRender();
  }

  private async showCommandPalette(): Promise<void> {
    const items: SelectItem[] = SLASH_COMMANDS.map((command) => ({
      value: `/${command.name}`,
      label: `/${command.name}`,
      description: command.argumentHint ? `${command.description} ${command.argumentHint}` : command.description,
    }));
    const list = new SelectList(items, 12, selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(boldCyan("Команды\n"), 1, 1));
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

  private refreshHeader(): void {
    const session = this.options.getSession();
    const mode = this.options.getMode();
    this.header.setText(`${boldCyan("FUSE")}  ${cyan(mode.toUpperCase())}  ${yellow(this.options.getProvider())}  ${dim(session.id.slice(0, 8))}  ${white(session.title)}`);
    this.modeFooter.setText(`РЕЖИМ: ${mode.toUpperCase()}`);
  }

  private setStatus(message: string, color: (text: string) => string): void {
    this.status.setText(color(message));
    this.tui.requestRender();
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.loader.stop();
    this.tui.stop();
    this.resolveExit?.();
  }
}

function formatRelativeTime(value: string): string {
  const age = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return "updated " + minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return "updated " + hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 30) return "updated " + days + "d ago";
  return "updated " + value.slice(0, 10);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
