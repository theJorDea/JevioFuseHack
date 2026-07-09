import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Loader,
  Markdown,
  ProcessTerminal,
  SelectList,
  Text,
  TUI,
  type MarkdownTheme,
  type SelectItem,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import { SLASH_COMMANDS } from "./slash-commands.ts";

export interface TuiSession {
  id: string;
  title: string;
  updatedAt: string;
}

export interface InteractiveTuiOptions {
  workspace: string;
  submit(input: string): Promise<{ output?: string; exit?: boolean }>;
  listSessions(): Promise<TuiSession[]>;
  resumeSession(id: string): Promise<string>;
  getSession(): { id: string; title: string; messageCount: number };
  getMode(): "team" | "direct" | "orchestrate";
}

const style = (code: number) => (text: string): string => `\x1b[${code}m${text}\x1b[0m`;
const boldCyan = (text: string): string => `\x1b[1;36m${text}\x1b[0m`;
const dim = style(2);
const cyan = style(36);
const green = style(32);
const yellow = style(33);
const red = style(31);
const white = style(37);

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

  constructor(options: InteractiveTuiOptions) {
    this.options = options;
    this.tui = new TUI(new ProcessTerminal());
    this.loader = new Loader(this.tui, cyan, dim, "Ready", { frames: [".", "o", "O", "o"], intervalMs: 120 });
    this.editor = new Editor(this.tui, { borderColor: cyan, selectList: selectTheme }, { paddingX: 1, autocompleteMaxVisible: 8 });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
      SLASH_COMMANDS.map((command) => ({
        name: command.name,
        description: command.argumentHint ? `${command.description} ${command.argumentHint}` : command.description,
        argumentHint: command.argumentHint,
      })),
      options.workspace,
    ));
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

  reportEvent(event: { type: "thinking" | "tool"; role: string; detail: string }): void {
    const label = event.type === "tool" ? `${event.role} -> ${event.detail}` : `${event.role}: ${event.detail}`;
    this.setStatus(label, event.type === "tool" ? cyan : dim);
  }

  async confirm(message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const overlay = new Container();
      overlay.addChild(new Text(yellow(`${message}\n\n`), 1, 1));
      const choices = new SelectList([
        { value: "yes", label: "Approve", description: "Allow this operation" },
        { value: "no", label: "Reject", description: "Keep the current state" },
      ], 2, selectTheme);
      overlay.addChild(choices);
      const close = (answer: boolean) => {
        handle.hide();
        this.tui.setFocus(this.editor);
        resolve(answer);
      };
      choices.onSelect = (choice) => close(choice.value === "yes");
      choices.onCancel = () => close(false);
      const handle = this.tui.showOverlay(overlay, { width: "60%", minWidth: 44, maxHeight: 8, anchor: "center", margin: 2 });
    });
  }

  private async handleSubmit(input: string): Promise<void> {
    const value = input.trim();
    if (!value || this.busy) return;
    if (/^\/(?:sessions?|resume)(?:\s*)$/i.test(value)) {
      this.editor.addToHistory(input);
      this.editor.setText("");
      try {
        await this.showSessionPicker();
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
    this.loader.setMessage(value.startsWith("/") ? "Applying command" : "Jevio is working");
    this.loader.start();
    this.setStatus("Working...", cyan);
    try {
      const result = await this.options.submit(input);
      if (result.output) this.appendMessage("jevio", result.output, green);
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
      this.appendMessage("jevio", "No saved sessions in this workspace.", dim);
      return;
    }
    const items: SelectItem[] = sessions.map((session) => ({
      value: session.id,
      label: session.title,
      description: `${session.id.slice(0, 8)}  ${session.updatedAt.replace("T", " ").slice(0, 16)}`,
    }));
    const list = new SelectList(items, 10, selectTheme);
    const overlay = new Container();
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
      this.appendMessage("jevio", await this.options.resumeSession(id), green);
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

  private appendMessage(label: string, content: string, color: (text: string) => string): void {
    this.transcript.addChild(new Text(color(label.toUpperCase()), 1, 1));
    this.transcript.addChild(new Markdown(content, 1, 0, markdownTheme));
    this.transcript.addChild(new Text(""));
    this.tui.requestRender();
  }

  private refreshHeader(): void {
    const session = this.options.getSession();
    const mode = this.options.getMode();
    this.header.setText(`${boldCyan("JEVIO")}  ${cyan(mode.toUpperCase())}  ${dim(session.id.slice(0, 8))}  ${white(session.title)}`);
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
