import type { Tool } from "../types.js";
import type {
  AskResult,
  Question,
  UserInputChannel,
} from "../agent/userInput.js";

/**
 * The exact result string returned when the session has no user-input channel
 * (v0.7.0 spec §3.5). A result string, not a thrown error — the model reads it
 * and proceeds on its own judgment.
 */
export const NO_CHANNEL_RESULT =
  "The user is not available to answer questions right now. Make your best " +
  "decision and proceed without asking.";

/**
 * Build the `ask_questions` tool (v0.7.0 spec §3.1).
 *
 * `channel` is the session's user-input channel; `depth` is the nesting depth
 * of the agent the tool is bound to (0 for the main agent). Both are captured
 * at construction time. When `channel` is absent (headless), the tool is still
 * registered but returns the unavailable string (§3.5) instead of calling
 * `channel.ask`.
 */
export function makeAskQuestionsTool(
  channel: UserInputChannel | undefined,
  depth: number,
): Tool {
  return {
    name: "ask_questions",
    mutating: false,
    // The result is the payload (≤ 3 questions) — exempt from
    // `maxToolOutputChars`, like `read_skill` (spec §3.4).
    noTruncate: true,
    description:
      "Ask the user a small batch of structured questions (1–3) and wait for " +
      "their answers before continuing. Each question is either a choice " +
      '(provide `options`; `select` is `"single"` for exactly one or ' +
      '`"multiple"` for one or more) or a free-text question (omit ' +
      "`options`). The user may always add free text in addition to choosing " +
      "options. Use this when a decision has several reasonable alternatives " +
      "and you want the user's input rather than guessing.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          maxItems: 3,
          description: "The questions to ask (1–3).",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Stable key for this question's answer. Unique within the batch.",
              },
              text: {
                type: "string",
                description: "The question prompt.",
              },
              options: {
                type: "array",
                items: { type: "string" },
                description: "The choices. Omit for a free-text question.",
              },
              select: {
                type: "string",
                enum: ["single", "multiple"],
                description:
                  'How many options may be chosen. Default "single". Only with options.',
              },
            },
            required: ["id", "text"],
          },
        },
      },
      required: ["questions"],
    },
    async handler(args) {
      const questions = args.questions as Question[] | undefined;
      if (!Array.isArray(questions) || questions.length === 0) {
        return 'parameter "questions" must be a non-empty array';
      }
      if (channel === undefined) {
        return NO_CHANNEL_RESULT;
      }
      const result: AskResult = await channel.ask(questions, { depth });
      return JSON.stringify(result);
    },
  };
}
