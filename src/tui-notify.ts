/**
 * Terminal desktop notifications after long agent turns.
 * OSC-9 / Kitty desktop notifications after long agent turns.
 */

export interface TaskNotifyOptions {
 ok: boolean;
 /** Short user-facing body (task snippet or "Готово"). */
 body: string;
 /** Elapsed ms of the turn. */
 durationMs: number;
 /** Only notify if slower than this (ms). Failures always notify. Default 2500. */
 minDurationMs?: number;
}

function sanitize(text: string, max = 160): string {
 return text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function formatElapsed(ms: number): string {
 if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
 if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
 const minutes = Math.floor(ms / 60_000);
 const seconds = Math.round((ms % 60_000) / 1000);
 return `${minutes}m ${seconds}s`;
}

/**
 * Build escape sequences for desktop / terminal attention.
 * Safe to write even if the terminal ignores them.
 */
export function buildTaskNotificationSequences(options: TaskNotifyOptions): string[] {
 const minDuration = options.minDurationMs ?? 2_500;
 if (options.ok && options.durationMs < minDuration) return [];

 const title = options.ok ? "Fuse · готово" : "Fuse · ошибка";
 const body = sanitize(`${options.body} · ${formatElapsed(options.durationMs)}`);
 const sequences: string[] = [];

 // Terminal bell — flash / taskbar attention in many hosts.
 sequences.push("\x07");

 // OSC 9 — iTerm2 / some others: desktop notification with message.
 sequences.push(`\x1b]9;${sanitize(`${title}: ${body}`, 200)}\x07`);

 // Kitty desktop notifications (OSC 99): title then body, same id.
 // https://sw.kovidgoyal.net/kitty/desktop-notifications/
 const kittyTitle = sanitize(title, 80);
 const kittyBody = sanitize(body, 180);
 sequences.push(`\x1b]99;i=fuse:d=0:p=title;${kittyTitle}\x1b\\`);
 sequences.push(`\x1b]99;i=fuse:p=body;${kittyBody}\x1b\\`);

 return sequences;
}

/** Write notification sequences to a terminal-like writer. */
export function emitTaskNotification(
 write: (data: string) => void,
 options: TaskNotifyOptions,
): boolean {
 const sequences = buildTaskNotificationSequences(options);
 if (!sequences.length) return false;
 for (const sequence of sequences) {
 try {
 write(sequence);
 } catch {
 // Ignore write failures (closed TTY).
 }
 }
 return true;
}
