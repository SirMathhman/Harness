/**
 * The user-input channel (v0.7.0 spec §2.1, §3.2).
 *
 * A `UserInputChannel` is the presentation surface's way of asking the user a
 * small batch of structured questions and waiting for the answers. The
 * `ask_questions` tool (spec §3.1) is bound to one at session-creation time and
 * calls `ask` when the model invokes it. The channel is shared by reference
 * across the whole agent tree, so every agent — main and subagent alike —
 * reaches the same surface; `scope.depth` tags which agent is asking.
 *
 * The channel is a side-channel like a provider: it is not a graph node, has no
 * `ResourceId`, and is threaded through `AgentContext` rather than resolved
 * from the resource graph.
 */

/** One question in a batch (v0.7.0 spec §2.1). */
export interface Question {
  /** Stable key for this question's answer; unique within the batch. */
  id: string;
  /** The question prompt shown to the user. */
  text: string;
  /**
   * The choices, when this is a choice question. Omitted for a free-text
   * question.
   */
  options?: string[];
  /**
   * How many options may be chosen. `"single"` (the default) means exactly
   * one; `"multiple"` means one or more. Only meaningful with `options`.
   */
  select?: "single" | "multiple";
}

/** The user's answer to one question (v0.7.0 spec §2.1). */
export interface QuestionAnswer {
  /** The chosen option labels (empty for a free-text answer). */
  selected: string[];
  /** Free text the user added in addition to (or instead of) choosing. */
  text: string;
}

/** The outcome of an `ask` call (v0.7.0 spec §2.1). */
export interface AskResult {
  /** `"answered"` when the user submitted; `"cancelled"` when they aborted. */
  status: "answered" | "cancelled";
  /**
   * The answers keyed by question id. Empty when `status` is `"cancelled"`.
   */
  answers: Record<string, QuestionAnswer>;
}

/**
 * The surface the `ask_questions` tool asks the user through (v0.7.0 spec
 * §2.1). Implemented by the REPL (spec §3.3) and the agent-server (spec §3.6).
 */
export interface UserInputChannel {
  /**
   * Ask the user `questions` and wait for the result. `scope.depth` is the
   * asking agent's nesting depth (0 for the main agent); the surface may use
   * it to attribute the prompt.
   */
  ask(questions: Question[], scope: { depth: number }): Promise<AskResult>;
  /**
   * Cancel any in-flight `ask`, resolving it as `{ status: "cancelled",
   * answers: {} }`. A no-op when nothing is pending. Called on abort and on
   * disconnect so a blocked tool call does not hang the turn.
   */
  cancelPending(): void;
}
