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
}

export interface InteractiveTuiOptions {
  workspace: string;
  submit(input: string): Promise<{ output?: string; exit?: boolean }>;
  listSessions(): Promise<TuiSession[]>;
  resumeSession(id: string): Promise<string>;
  getSession(): { id: string; title: string; messageCount: number };
  getMode(): "team" | "direct" | "orchestrate";
  getProvider(): string;
  listProviders(): Promise<TuiProvider[]>;
  selectProvider(name: string): Promise<string>;
  addProvider(provider: { name: string; baseUrl: string; apiKey?: string; model: string }): Promise<string>;
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

const style = (code: number) => (text: string): string => `\x1b[${code}m${text}\x1b[0m`;
const boldCyan = (text: string): string => `\x1b[1;36m${text}\x1b[0m`;
const dim = style(2);
const cyan = style(36);
const green = style(32);
const yellow = style(33);
const red = style(31);
const white = style(37);
const modalBackground = (text: string): string => `\x1b[48;5;236m${text}\x1b[0m`;

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
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
  italic: (text) => `\x1b[3m${text}\x1b[0m`,
  strikethrough: dim,
  underline: (text) => `\x1b[4m${text}\x1b[0m`,
  codeBlockIndent: "  ",
};

export class InteractiveTui {
  private readonly options: InteractiveTuiOptions;
  private readonly tui: TUI;
  private readonly root = new Container();
  private readonly transcript = new Container();
  private readonly header = new Text();
  private readonly status = new Text();
  private readonly loader: Loader;
  private readonly editor: Editor;
  private busy = false;
  private resolveExit?: () => void;
  private stopped = false;
  private dismissOverlay?: () => void;

  constructor(options: InteractiveTuiOptions) {
    this.options = options;
    this.tui = new TUI(new ProcessTerminal());
    this.loader = new Loader(this.tui, cyan, dim, "Ready", { frames: [".", "o", "O", "o"], intervalMs: 120 });
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
    this.root.addChild(new Text(""));
    this.root.addChild(this.transcript);
    this.root.addChild(this.loader);
    this.root.addChild(this.status);
    this.root.addChild(this.editor);
    this.tui.addChild(this.root);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => {
      if (data === "\x03") {
        if (this.busy) {
          this.setStatus("Agent is still working. Wait for the current task to finish.", yellow);
        } else {
          this.stop();
        }
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
    this.setStatus("/ opens commands. Tab accepts a suggestion. Shift+Enter adds a line.", dim);
    this.tui.start();
    this.tui.requestRender(true);
    await new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  reportEvent(event: { type: "thinking" | "tool" | "progress"; role: string; detail: string }): void {
    const label = event.type === "tool"
      ? `${event.role.toUpperCase()}  tool  ${event.detail}`
      : event.type === "progress"
        ? `${event.role.toUpperCase()}  plan  ${event.detail}`
        : `${event.role.toUpperCase()}  ${event.detail}`;
    const color = event.type === "tool" ? cyan : event.type === "progress" ? green : dim;
    this.appendActivity(label, color);
    this.setStatus(label, color);
  }

  async confirm(message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const overlay = modalSurface();
      overlay.addChild(new Text(yellow(`${message}\n\n`), 1, 1));
      const choices = new SelectList([
        { value: "yes", label: "Approve", description: "Allow this operation" },
        { value: "no", label: "Reject", description: "Keep the current state" },
      ], 2, selectTheme);
      overlay.addChild(choices);
      const close = (answer: boolean) => {
        handle.hide();
        this.dismissOverlay = undefined;
        this.tui.setFocus(this.editor);
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
      this.loader.setMessage("Waiting for your answer");
      this.setStatus("Waiting for your answer", yellow);
      const overlay = modalSurface();
      overlay.addChild(new Text(boldCyan(`FUSE NEEDS INPUT\n${question}\n`), 1, 1));
      const items: SelectItem[] = [
        ...options.map((option) => ({ value: option.label, label: option.label, description: option.description })),
        { value: "__custom_answer__", label: "Other...", description: "Type a custom response" },
      ];
      const choices = new SelectList(items, 8, selectTheme);
      overlay.addChild(choices);
      const close = (answer: string) => {
        handle.hide();
        this.dismissOverlay = undefined;
        this.tui.setFocus(this.editor);
        if (answer && answer !== "[cancelled]") this.appendMessage("you", answer, cyan);
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
    overlay.addChild(new Text(boldCyan(`FUSE NEEDS INPUT\n${question}\n`), 1, 1));
    const input = new Input();
    overlay.addChild(input);
    const close = (answer: string) => {
      handle.hide();
      this.dismissOverlay = undefined;
      this.tui.setFocus(this.editor);
      if (answer && answer !== "[cancelled]") this.appendMessage("you", answer, cyan);
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
    if (/^\/(?:sessions?|resume|provider)(?:\s*)$/i.test(value)) {
      this.editor.addToHistory(input);
      this.editor.setText("");
      try {
        if (/^\/provider\s*$/i.test(value)) await this.showProviderPicker();
        else await this.showSessionPicker();
      } catch (error) {
        this.appendMessage("error", (error as Error).message, red);
      }
      return;
    }

    this.busy = true;
    this.editor.disableSubmit = true;
    this.editor.addToHistory(input);
    this.editor.setText("");
    if (!value.startsWith("/")) this.appendMessage("you", input, cyan);
    this.loader.setMessage(value.startsWith("/") ? "Applying command" : "Fuse is working");
    this.loader.start();
    this.setStatus("Working...", cyan);
    try {
      const result = await this.options.submit(input);
      if (result.output) this.appendMessage("fuse", result.output, green);
      this.refreshHeader();
      if (result.exit) this.stop();
      else if (!result.output) this.setStatus("Ready", dim);
    } catch (error) {
      this.appendMessage("error", (error as Error).message, red);
      this.setStatus("Task failed", red);
    } finally {
      this.loader.stop();
      this.busy = false;
      this.editor.disableSubmit = false;
      this.tui.setFocus(this.editor);
      this.tui.requestRender();
    }
  }

  private async showSessionPicker(): Promise<void> {
    const sessions = await this.options.listSessions();
    if (!sessions.length) {
      this.appendMessage("fuse", "No saved sessions in this workspace.", dim);
      return;
    }
    const items: SelectItem[] = sessions.map((session) => ({
      value: session.id,
      label: session.title,
      description: `${session.id.slice(0, 8)}  ${session.updatedAt.replace("T", " ").slice(0, 16)}`,
    }));
    const list = new SelectList(items, 10, selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(boldCyan("Saved sessions\n"), 1, 1));
    overlay.addChild(list);
    const handle = this.tui.showOverlay(overlay, { width: "78%", minWidth: 54, maxHeight: "60%", anchor: "center", margin: 2 });
    list.onSelect = (item) => void this.resumeFromPicker(item.value, handle);
    list.onCancel = () => {
      handle.hide();
      this.tui.setFocus(this.editor);
    };
  }

  private async resumeFromPicker(id: string, handle: { hide(): void }): Promise<void> {
    handle.hide();
    this.tui.setFocus(this.editor);
    this.busy = true;
    this.editor.disableSubmit = true;
    this.loader.setMessage("Loading session");
    this.loader.start();
    try {
      this.appendMessage("fuse", await this.options.resumeSession(id), green);
      this.refreshHeader();
      this.setStatus("Ready", dim);
    } catch (error) {
      this.appendMessage("error", (error as Error).message, red);
    } finally {
      this.loader.stop();
      this.busy = false;
      this.editor.disableSubmit = false;
      this.tui.setFocus(this.editor);
    }
  }

  private async showProviderPicker(): Promise<void> {
    const providers = await this.options.listProviders();
    const items: SelectItem[] = [
      ...providers.map((provider) => ({
      value: provider.name,
      label: provider.name,
      description: `${provider.baseUrl}${provider.apiKeyEnv ? `  ${provider.apiKeyEnv}` : ""}`,
      })),
      { value: "__add_provider__", label: "Add provider", description: "Configure an OpenAI-compatible endpoint" },
    ];
    const list = new SelectList(items, 10, selectTheme);
    const overlay = modalSurface();
    overlay.addChild(new Text(boldCyan("Configured providers\n"), 1, 1));
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
      if (item.value === "__add_provider__") this.showProviderForm();
      else void this.chooseProvider(item.value);
    };
    list.onCancel = close;
    this.tui.setFocus(list);
  }

  private async chooseProvider(name: string): Promise<void> {
    try {
      this.appendMessage("fuse", await this.options.selectProvider(name), green);
      this.refreshHeader();
      this.setStatus("Ready", dim);
    } catch (error) {
      this.appendMessage("error", (error as Error).message, red);
    }
  }

  private showProviderForm(): void {
    const fields: Array<{ label: string; key: "name" | "baseUrl" | "apiKey" | "model"; optional?: boolean }> = [
      { label: "Provider name", key: "name" },
      { label: "OpenAI-compatible base URL", key: "baseUrl" },
      { label: "API key (stored locally, not in Git)", key: "apiKey", optional: true },
      { label: "Model name for Fuse roles", key: "model" },
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
      title.setText(`${boldCyan("Add provider")}\n${field.label}${field.optional ? " (optional)" : ""}\n`);
      input.setValue("");
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
      values[field.key] = value;
      index += 1;
      if (index < fields.length) {
        renderField();
        return;
      }
      close();
      void this.saveProvider(values);
    };
    const handle = this.tui.showOverlay(overlay, { width: "70%", minWidth: 52, maxHeight: 8, anchor: "center", margin: 2 });
    this.dismissOverlay = close;
    this.tui.setFocus(input);
    renderField();
  }

  private async saveProvider(values: Partial<{ name: string; baseUrl: string; apiKey: string; model: string }>): Promise<void> {
    try {
      const name = values.name ?? "";
      const baseUrl = values.baseUrl ?? "";
      const message = await this.options.addProvider({ name, baseUrl, apiKey: values.apiKey || undefined, model: values.model ?? "" });
      this.appendMessage("fuse", message, green);
      this.refreshHeader();
      this.setStatus("Ready", dim);
    } catch (error) {
      this.appendMessage("error", (error as Error).message, red);
    }
  }

  private appendMessage(label: string, content: string, color: (text: string) => string): void {
    this.transcript.addChild(new Text(color(label.toUpperCase()), 1, 1));
    this.transcript.addChild(new Markdown(content, 1, 0, markdownTheme));
    this.transcript.addChild(new Text(""));
    this.tui.requestRender();
  }

  private appendActivity(content: string, color: (text: string) => string): void {
    this.transcript.addChild(new Text(color(`> ${content}`), 1, 0));
    this.tui.requestRender();
  }

  private refreshHeader(): void {
    const session = this.options.getSession();
    const mode = this.options.getMode();
    this.header.setText(`${boldCyan("FUSE")}  ${cyan(mode.toUpperCase())}  ${yellow(this.options.getProvider())}  ${dim(session.id.slice(0, 8))}  ${white(session.title)}`);
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
