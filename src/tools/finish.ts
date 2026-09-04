import type { Tool } from "../types.js";

/**
 * finish (spec §3.3 #8). Terminal tool: signals the end of the turn.
 * The handler returns the answer; the agent loop treats a `finish` call as
 * the turn's final output.
 */
export const finishTool: Tool = {
  name: "finish",
  mutating: false,
  description:
    "End the current task. Call this with a clear summary once the task is complete.",
  parameters: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "The final answer / summary for the user.",
      },
    },
    required: ["answer"],
  },
  async handler(args) {
    return String(args.answer);
  },
};
