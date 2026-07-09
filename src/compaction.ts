import { runAgent, type AgentEvent } from "./agent.ts";
import type { ChatMessage, JevioConfig, ToolContext } from "./types.ts";

const SUMMARY_PREFIX = "Compacted context from the earlier conversation:";
const SUMMARY_ACKNOWLEDGEMENT = "Understood. I will continue from this compacted context.";

export interface CompactionResult {
  summary: string;
  history: ChatMessage[];
  retainedMessages: ChatMessage[];
}

export function historyCharacters(history: ChatMessage[]): number {
  return history.reduce((total, message) => total + String(message.content ?? "").length, 0);
}

export function estimateHistoryTokens(history: ChatMessage[]): number {
  let units = 0;
  for (const message of history) {
    const content = String(message.content ?? "");
    for (const character of content) units += character.codePointAt(0)! <= 0x7f ? 0.25 : 0.65;
    units += 6;
  }
  return Math.ceil(units);
}

export function estimateTextTokens(content: string): number {
  return estimateHistoryTokens([{ role: "user", content }]) - 6;
}

function retainedCount(config: JevioConfig): number {
  const configured = Math.max(0, Math.floor(config.compaction.keepRecentMessages));
  return configured - (configured % 2);
}

export function needsAutoCompaction(
  history: ChatMessage[],
  config: JevioConfig,
  additionalContext = "",
): boolean {
  const keep = retainedCount(config);
  const tokenLimit = Math.max(
    1_024,
    config.compaction.contextWindowTokens - config.compaction.reservedTokens,
  );
  return config.compaction.auto
    && history.length > keep + 2
    && (estimateHistoryTokens(history) + estimateTextTokens(additionalContext) >= tokenLimit
      || historyCharacters(history) + additionalContext.length >= config.compaction.triggerCharacters);
}

export function buildCompactedHistory(summary: string, retainedMessages: ChatMessage[]): ChatMessage[] {
  return [
    { role: "user", content: `${SUMMARY_PREFIX}\n\n${summary.trim()}` },
    { role: "assistant", content: SUMMARY_ACKNOWLEDGEMENT },
    ...retainedMessages,
  ];
}

export function fitCompactedHistory(
  summary: string,
  sourceHistory: ChatMessage[],
  requestedRecentMessages: number,
): { history: ChatMessage[]; retainedMessages: ChatMessage[] } {
  const sourceTokens = estimateHistoryTokens(sourceHistory);
  let keep = Math.max(0, Math.floor(requestedRecentMessages));
  keep -= keep % 2;
  let retainedMessages = keep ? sourceHistory.slice(-keep) : [];
  let history = buildCompactedHistory(summary, retainedMessages);
  while (retainedMessages.length && estimateHistoryTokens(history) >= sourceTokens) {
    retainedMessages = retainedMessages.slice(2);
    history = buildCompactedHistory(summary, retainedMessages);
  }
  if (estimateHistoryTokens(history) >= sourceTokens) {
    throw new Error("Compaction summary did not reduce the estimated context size.");
  }
  return { history, retainedMessages };
}

export async function compactConversation(options: {
  history: ChatMessage[];
  config: JevioConfig;
  toolContext: ToolContext;
  instruction?: string;
  onEvent?: (event: AgentEvent) => void;
  runner?: typeof runAgent;
}): Promise<CompactionResult> {
  if (!options.history.length) throw new Error("There is no conversation context to compact.");
  const customInstruction = options.instruction?.trim()
    ? `\nAdditional user priority: ${options.instruction.trim()}`
    : "";
  const result = await (options.runner ?? runAgent)({
    role: "compactor",
    task: `Compact the conversation history into a continuation summary.
${options.config.compaction.prompt}${customInstruction}

Return only the summary. Do not wrap it in commentary or markdown fences.`,
    config: options.config,
    toolContext: options.toolContext,
    history: options.history,
    maxTurns: 1,
    onEvent: options.onEvent,
  });
  const summary = result.content.trim().slice(0, Math.max(1000, options.config.compaction.maxSummaryCharacters));
  if (!summary || summary === "The model returned an empty response.") {
    throw new Error("The compactor model returned no usable summary.");
  }
  const fitted = fitCompactedHistory(summary, options.history, retainedCount(options.config));
  return { summary, ...fitted };
}
