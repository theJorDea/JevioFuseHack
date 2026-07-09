import { runAgent, type AgentEvent } from "./agent.ts";
import type { AgentResult, ChatMessage, JevioConfig, ToolContext } from "./types.ts";

export interface TeamOptions {
  task: string;
  config: JevioConfig;
  toolContext: ToolContext;
  history?: ChatMessage[];
  onEvent?: (event: AgentEvent) => void;
  runner?: typeof runAgent;
}

export interface TeamResult extends AgentResult {
  plan: string;
  review: string;
  fixesApplied: number;
}

export async function runTeam(options: TeamOptions): Promise<TeamResult> {
  const runner = options.runner ?? runAgent;
  const planResult = await runner({
    role: "architect",
    task: `Design a concrete implementation plan for this request:\n\n${options.task}`,
    config: options.config,
    toolContext: options.toolContext,
    history: options.history,
    maxTurns: Math.min(10, options.config.agent.maxTurns),
    onEvent: options.onEvent,
  });

  let implementation = await runner({
    role: "coder",
    task: `Implement the user's request. The architecture agent produced this advisory plan; verify it
against the repository and adjust it when necessary.\n\nUSER REQUEST:\n${options.task}\n\nPLAN:\n${planResult.content}`,
    config: options.config,
    toolContext: options.toolContext,
    history: options.history,
    onEvent: options.onEvent,
  });

  let review = await runner({
    role: "reviewer",
    task: `Review the implementation for this request:\n\n${options.task}\n\nImplementation agent report:\n${implementation.content}`,
    config: options.config,
    toolContext: options.toolContext,
    history: options.history,
    maxTurns: Math.min(12, options.config.agent.maxTurns),
    onEvent: options.onEvent,
  });

  let fixesApplied = 0;
  while (review.content.includes("<verdict>FIX</verdict>") && fixesApplied < options.config.agent.maxReviewFixes) {
    fixesApplied += 1;
    implementation = await runner({
      role: "coder",
      task: `Fix the review findings that are valid, then rerun relevant checks.\n\nORIGINAL REQUEST:\n${options.task}\n\nREVIEW:\n${review.content}`,
      config: options.config,
      toolContext: options.toolContext,
      history: options.history,
      onEvent: options.onEvent,
    });
    review = await runner({
      role: "reviewer",
      task: `Re-review the current workspace after fixes for this request:\n\n${options.task}\n\nFix report:\n${implementation.content}`,
      config: options.config,
      toolContext: options.toolContext,
      history: options.history,
      maxTurns: Math.min(12, options.config.agent.maxTurns),
      onEvent: options.onEvent,
    });
  }

  return {
    content: implementation.content,
    turns: planResult.turns + implementation.turns + review.turns,
    plan: planResult.content,
    review: review.content,
    fixesApplied,
  };
}
