// Protocol types, mirroring src/server.ts (GUI spec §6.1).

export type Scope =
  | { kind: "main" }
  | { kind: "subagent"; id: string; depth: number };

export type ServerEvent =
  | {
      type: "snapshot";
      history: ConversationItem[];
      inflight: ServerEvent[];
      state: UIState;
    }
  | { type: "token"; scope: Scope; text: string }
  | { type: "reasoning"; scope: Scope; text: string }
  | {
      type: "toolCall";
      scope: Scope;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "toolResult";
      scope: Scope;
      name: string;
      ok: boolean;
      summary: string;
    }
  | { type: "compacting"; scope: Scope }
  | {
      type: "subagentEnd";
      scope: Scope;
      ok: boolean;
      label: string;
      depth: number;
    }
  | {
      type: "turnEnd";
      answer: string;
      kind: "finished" | "cap" | "text" | "aborted";
      finished: boolean;
    }
  | { type: "error"; message: string; kind: "llm" | "other" }
  | { type: "state"; patch: Partial<UIState> }
  | {
      type: "commandResult";
      ok: boolean;
      error?: string;
      data?: Record<string, unknown>;
    }
  | { type: "cleared" }
  | { type: "pong" }
  | { type: "serverEvent"; name: string; payload: Record<string, unknown> }
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "sessionSaved"; name: string }
  | {
      type: "sessionLoaded";
      name: string;
      profile: string;
      model: string;
      messageCount: number;
    }
  | { type: "sessionDeleted"; name: string };

export type ClientCommand =
  | { type: "task"; text: string }
  | { type: "abort" }
  | { type: "switchProfile"; name: string }
  | { type: "switchModel"; ref: string }
  | { type: "clear" }
  | { type: "newSession" }
  | { type: "hooks"; enabled: boolean }
  | { type: "ping" }
  | { type: "save"; name?: string }
  | { type: "load"; name: string }
  | { type: "sessions" }
  | { type: "rename"; old: string; new: string }
  | { type: "delete"; name: string };

/** A saved session as listed by the server (v0.8.0 spec §2.2). */
export interface SessionInfo {
  name: string;
  title: string;
  model: string;
  savedAt: string;
  readable: boolean;
}

export type ConversationItem =
  | { kind: "userMessage"; text: string }
  | { kind: "assistantMessage"; text: string }
  | { kind: "reasoningBlock"; text: string }
  | { kind: "toolCall"; name: string; args: Record<string, unknown> }
  | { kind: "toolResult"; name: string; ok: boolean; summary: string }
  | { kind: "compactionNotice" }
  | { kind: "systemNotice"; text: string };

export interface UIState {
  activeProfile: string;
  activeModel: string | null;
  /** The working directory the agent-server (and its tools) run in. */
  cwd: string;
  context: { promptTokens: number | null; maxContext: number };
  profiles: { name: string; origin: string }[];
  models: { name: string; baseUrl: string; providerName: string | null }[];
  skills: { name: string; description: string }[];
  hooks: { events: string[]; source: string; tools?: string[] }[];
  hooksEnabled: boolean;
  turnActive: boolean;
}
