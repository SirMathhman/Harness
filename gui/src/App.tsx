// The main application component (GUI spec §3.9–§3.11).
import {
  createEffect,
  createSignal,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { Client } from "./client";
import { createStore } from "./store";
import { Row } from "./Markdown";
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

  // Apply every server event to the store.
  client.subscribe((event) => store.applyEvent(event));

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
    store.pushUserMessage(text);
    client.send({ type: "task", text });
    setTask("");
  };

  // Auto-scroll only when the user is at the bottom (GUI spec §3.9).
  const scrollRef = { current: null as HTMLElement | null };
  const [atBottom, setAtBottom] = createSignal(true);
  createEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottom()) return;
    el.scrollTop = el.scrollHeight;
  });

  const state = () => store.state();
  const turnActive = () => state()?.turnActive ?? false;

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
          {(state()?.profiles ?? []).map((p) => (
            <option value={p.name}>{p.name}</option>
          ))}
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
          {(state()?.models ?? []).map((m) => (
            <option value={m.name}>{m.name}</option>
          ))}
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
        <section
          class="conversation"
          ref={(el) => (scrollRef.current = el)}
          onScroll={(e) => {
            const el = e.currentTarget;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }}
        >
          <Show
            when={store.rows().length === 0}
            fallback={store.rows().map((row, i) => (
              <Row
                depth={row.depth}
                item={row.item}
                active={store.activeIdx() === i}
              />
            ))}
          >
            <div class="empty">
              <p>Connected to Vise. Send a task to begin.</p>
            </div>
          </Show>
        </section>

        <aside class="sidebar">
          <Panel title={`skills (${state()?.skills.length ?? 0})`}>
            {(state()?.skills ?? []).map((s) => (
              <div class="panel-item" title={s.description}>
                {s.name}
              </div>
            ))}
          </Panel>
          <Panel title={`hooks (${state()?.hooks.length ?? 0})`}>
            {(state()?.hooks ?? []).map((h) => (
              <div class="panel-item" title={h.source}>
                {h.events.join(", ")}
                {h.tools && h.tools.length > 0
                  ? ` [${h.tools.join(", ")}]`
                  : ""}
              </div>
            ))}
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
