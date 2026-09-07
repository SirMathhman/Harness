// The main application component (GUI spec §3.9–§3.11).
import {
  batch,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { Client } from "./client";
import { createStore } from "./store";
import { ConversationViewport } from "./conversation/ConversationViewport";
import {
  createEventQueue,
  documentVisibility,
} from "./conversation/eventQueue";
import type { UIState } from "./types";

// UI preferences live in localStorage (GUI spec §3.11, §6.3).
const PREFS_KEY = "vise.gui.prefs";
type Theme = "light" | "dark" | "system";
interface Prefs {
  theme: Theme;
}
function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { theme: "system", ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { theme: "system" };
}
function savePrefs(p: Prefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

export function App() {
  const client = new Client();
  const store = createStore();
  onCleanup(() => client.dispose());

  // Apply every server event to the store, through the frame scheduler: at
  // token rates the network delivers far more deltas than the display can use,
  // and applying each one separately means one reactive update and one Markdown
  // parse per delta. Ordering and content are unchanged (GUI spec §5).
  const queue = createEventQueue({
    apply: (event) => store.applyEvent(event),
    batch,
    onVisibilityChange: documentVisibility,
  });
  const unsubscribe = client.subscribe((event) => queue.push(event));
  onCleanup(() => {
    unsubscribe();
    queue.dispose();
  });

  // Preferences.
  const [prefs, setPrefs] = createSignal<Prefs>(loadPrefs());
  const setTheme = (theme: Theme) => {
    const next = { ...prefs(), theme };
    setPrefs(next);
    savePrefs(next);
  };
  createEffect(() => {
    const theme = prefs().theme;
    const dark =
      theme === "dark" ||
      (theme === "system" &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  });

  // Task input.
  const [task, setTask] = createSignal("");
  const submit = () => {
    const text = task().trim();
    if (!text) return;
    // Through the queue, so the optimistic user message lands after any output
    // still pending rather than jumping ahead of it.
    queue.pushAction(() => store.pushUserMessage(text));
    client.send({ type: "task", text });
    setTask("");
  };

  // User-facing auto-scroll toggle (default on): when on, the view follows the
  // newest output while a turn streams; when off, the user scrolls freely.
  // Scrolling itself lives in the virtual viewport, which owns the measurements
  // the decision depends on.
  const [follow, setFollow] = createSignal(true);
  const state = () => store.state();
  const turnActive = () => state()?.turnActive ?? false;

  // Sessions panel (v0.8.0). The list is server-authoritative: we request it on
  // connect and after every mutation; the server replies with a `sessions`
  // event that the store applies.
  const [saveName, setSaveName] = createSignal("");
  const refreshSessions = () => client.send({ type: "sessions" });
  createEffect(() => {
    if (client.connectionState() === "open") refreshSessions();
  });
  const doSave = () => {
    const name = saveName().trim();
    client.send(name ? { type: "save", name } : { type: "save" });
    setSaveName("");
    refreshSessions();
  };
  const doLoad = (name: string) => client.send({ type: "load", name });
  const doRename = (name: string) => {
    const next = window.prompt("Rename session to:", name);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === name) return;
    client.send({ type: "rename", old: name, new: trimmed });
    refreshSessions();
  };
  const doDelete = (name: string) => {
    if (!window.confirm(`Delete session "${name}"?`)) return;
    client.send({ type: "delete", name });
    refreshSessions();
  };

  return (
    <div class="app">
      <header class="topbar">
        <span class="brand">vise</span>
        <select
          class="control"
          value={state()?.activeProfile ?? ""}
          disabled={turnActive()}
          onChange={(e) =>
            client.send({
              type: "switchProfile",
              name: (e.target as HTMLSelectElement).value,
            })
          }
        >
          <For each={state()?.profiles ?? []}>
            {(p) => <option value={p.name}>{p.name}</option>}
          </For>
        </select>
        <select
          class="control"
          value={state()?.activeModel ?? ""}
          disabled={turnActive()}
          onChange={(e) =>
            client.send({
              type: "switchModel",
              ref: (e.target as HTMLSelectElement).value,
            })
          }
        >
          <For each={state()?.models ?? []}>
            {(m) => <option value={m.name}>{m.name}</option>}
          </For>
        </select>
        <span class="context" title="context usage">
          {contextLabel(state())}
        </span>
        <Show when={state()}>
          <span class="cwd" title="working directory">
            {state()!.cwd}
          </span>
        </Show>
        <button
          class="control"
          disabled={!turnActive()}
          onClick={() => client.send({ type: "abort" })}
        >
          abort
        </button>
        <button
          class="control"
          disabled={turnActive()}
          onClick={() => client.send({ type: "clear" })}
        >
          clear
        </button>
        <button
          class="control"
          disabled={turnActive()}
          onClick={() => client.send({ type: "newSession" })}
        >
          new
        </button>
        <button
          class={`control follow-toggle${follow() ? " on" : ""}`}
          title={
            follow()
              ? "Auto-scroll is on: the view follows live output. Click to scroll freely."
              : "Auto-scroll is off: you can scroll freely. Click to follow live output."
          }
          // Enabling immediately jumps to the newest output; the viewport
          // watches this signal and does the measured scroll.
          onClick={() => setFollow((f) => !f)}
        >
          {follow() ? "follow: on" : "follow: off"}
        </button>
        <label class="control hooks-toggle">
          <input
            type="checkbox"
            checked={state()?.hooksEnabled ?? true}
            onChange={(e) =>
              client.send({
                type: "hooks",
                enabled: (e.target as HTMLInputElement).checked,
              })
            }
          />
          hooks
        </label>
        <select
          class="control"
          value={prefs().theme}
          onChange={(e) =>
            setTheme((e.target as HTMLSelectElement).value as Theme)
          }
        >
          <option value="light">light</option>
          <option value="dark">dark</option>
          <option value="system">system</option>
        </select>
        <span class={`conn conn-${client.connectionState()}`}>
          {client.connectionState()}
        </span>
      </header>

      <main class="layout">
        <ConversationViewport
          store={store}
          follow={follow}
          turnActive={turnActive}
        />

        <aside class="sidebar">
          <Panel title={`sessions (${store.sessions().length})`}>
            <div class="session-save">
              <input
                class="session-name"
                placeholder="name (optional)"
                value={saveName()}
                onInput={(e) =>
                  setSaveName((e.target as HTMLInputElement).value)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") doSave();
                }}
              />
              <button
                class="control"
                disabled={turnActive()}
                onClick={doSave}
              >
                save
              </button>
            </div>
            <Show
              when={store.sessions().length > 0}
              fallback={<div class="panel-item muted">no saved sessions</div>}
            >
              <For each={store.sessions()}>
                {(s) => (
                  <div class="session-item">
                    <div class="session-meta" title={s.savedAt}>
                      <span class="session-title">{s.title}</span>
                      <span class="session-sub">
                        {s.model || "—"} · {s.savedAt}
                      </span>
                    </div>
                    <div class="session-actions">
                      <button
                        class="control"
                        disabled={turnActive() || !s.readable}
                        onClick={() => doLoad(s.name)}
                      >
                        load
                      </button>
                      <button
                        class="control"
                        disabled={!s.readable}
                        onClick={() => doRename(s.name)}
                      >
                        rename
                      </button>
                      <button
                        class="control danger"
                        onClick={() => doDelete(s.name)}
                      >
                        delete
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Panel>
          <Panel title={`skills (${state()?.skills.length ?? 0})`}>
            <For each={state()?.skills ?? []}>
              {(s) => (
                <div class="panel-item" title={s.description}>
                  {s.name}
                </div>
              )}
            </For>
          </Panel>
          <Panel title={`hooks (${state()?.hooks.length ?? 0})`}>
            <For each={state()?.hooks ?? []}>
              {(h) => (
                <div class="panel-item" title={h.source}>
                  {h.events.join(", ")}
                  {h.tools && h.tools.length > 0
                    ? ` [${h.tools.join(", ")}]`
                    : ""}
                </div>
              )}
            </For>
          </Panel>
        </aside>
      </main>

      <footer class="inputbar">
        <textarea
          class="task-input"
          placeholder="Send a task… (Enter to send, Shift+Enter for newline)"
          value={task()}
          rows={2}
          onInput={(e) => setTask((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button class="send" onClick={submit} disabled={turnActive()}>
          send
        </button>
      </footer>
    </div>
  );
}

/** A titled sidebar panel. */
function Panel(props: { title: string; children: JSX.Element }) {
  return (
    <div class="panel">
      <h3>{props.title}</h3>
      <div class="panel-body">{props.children}</div>
    </div>
  );
}

/** Format the context readout (GUI spec §3.10). */
function contextLabel(state: UIState | null): string {
  if (!state) return "context: —";
  const { promptTokens, maxContext } = state.context;
  if (promptTokens === null || maxContext === 0) return "context: —";
  const pct = Math.round((promptTokens / maxContext) * 100);
  return `context: ${promptTokens} / ${maxContext} (${pct}%)`;
}
