// Deterministic browser fixtures for the conversation viewport.
//
// The specs drive the real Vite app. Only the transport is replaced: a mock
// `WebSocket` installed before the app's own script runs, so the page exercises
// the production client, store, view model and viewport end to end without an
// agent-server, a provider or any local user config. There is no debug endpoint
// in the shipped app.

import type { Page } from "@playwright/test";

/** Mirrors `gui/src/types.ts` (which mirrors `src/server/protocol.ts`). */
export type Scope = { kind: "main" } | { kind: "sub"; id: string; depth: number };

export interface UIStateFixture {
  activeProfile: string;
  activeModel: string | null;
  cwd: string;
  context: { promptTokens: number | null; maxContext: number };
  profiles: { name: string; origin: string }[];
  models: { name: string; baseUrl: string; providerName: string | null }[];
  skills: { name: string; description: string }[];
  hooks: { events: string[]; source: string; tools?: string[] }[];
  hooksEnabled: boolean;
  turnActive: boolean;
}

// Loosely typed on purpose: the fixture is a wire producer, and the spec should
// be free to build any protocol-shaped payload without re-deriving the union.
export type Event = Record<string, unknown>;

/** The same `basicState` the Bun store tests use, with `turnActive` exposed. */
export function basicState(turnActive = false): UIStateFixture {
  return {
    activeProfile: "Agent",
    activeModel: "m",
    cwd: "/work",
    context: { promptTokens: 120, maxContext: 8192 },
    profiles: [{ name: "Agent", origin: "builtin" }],
    models: [{ name: "m", baseUrl: "http://localhost:8080", providerName: null }],
    skills: [],
    hooks: [],
    hooksEnabled: true,
    turnActive,
  };
}

/** A `snapshot` event. */
export function snapshot(
  history: Event[],
  options: { inflight?: Event[]; turnActive?: boolean } = {},
): Event {
  return {
    type: "snapshot",
    history,
    inflight: options.inflight ?? [],
    state: basicState(options.turnActive ?? false),
  };
}

/**
 * `n` history items with a repeating shape: a user message, a Markdown answer,
 * a tool call and its result. Each item's text carries its ordinal so a spec
 * can assert exact content and ordering.
 */
export function history(n: number): Event[] {
  const out: Event[] = [];
  for (let i = 0; i < n; i++) {
    switch (i % 4) {
      case 0:
        out.push({ kind: "userMessage", text: `user ${i}` });
        break;
      case 1:
        out.push({
          kind: "assistantMessage",
          text: `### answer ${i}\n\nSome **markdown** with \`code\` and a list:\n\n- one\n- two\n`,
        });
        break;
      case 2:
        out.push({ kind: "toolCall", name: "read_file", args: { path: `f${i}.ts` } });
        break;
      default:
        out.push({
          kind: "toolResult",
          name: "read_file",
          ok: true,
          summary: `read f${i - 1}.ts`,
        });
    }
  }
  return out;
}

/** Stream `count` token deltas into one scope. */
export function tokens(scope: Scope, count: number, prefix = "t"): Event[] {
  const out: Event[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ type: "token", scope, text: `${prefix}${i} ` });
  }
  return out;
}

/** A subagent run: tokens, tool activity, `childCount` rows, then its end. */
export function subagentRun(
  id: string,
  childCount: number,
  options: { end?: boolean; depth?: number } = {},
): Event[] {
  const depth = options.depth ?? 1;
  const scope: Scope = { kind: "sub", id, depth };
  const out: Event[] = [];
  for (let i = 0; i < childCount; i++) {
    if (i % 2 === 0) {
      out.push({ type: "toolCall", scope, name: "grep", args: { q: `q${i}` } });
    } else {
      out.push({
        type: "toolResult",
        scope,
        name: "grep",
        ok: true,
        summary: `hit ${i}`,
      });
    }
  }
  if (options.end !== false) {
    out.push({ type: "subagentEnd", scope, ok: true, label: id, depth });
  }
  return out;
}

/** Two same-depth subagents interleaving, as concurrent spawns really do. */
export function interleavedSubagents(rowsEach: number): Event[] {
  const a: Scope = { kind: "sub", id: "sa", depth: 1 };
  const b: Scope = { kind: "sub", id: "sb", depth: 1 };
  const out: Event[] = [];
  for (let i = 0; i < rowsEach; i++) {
    out.push({ type: "token", scope: a, text: `a${i} ` });
    out.push({ type: "token", scope: b, text: `b${i} ` });
    out.push({ type: "toolCall", scope: a, name: "t", args: { i } });
    out.push({ type: "toolCall", scope: b, name: "t", args: { i } });
  }
  out.push({ type: "subagentEnd", scope: a, ok: true, label: "sa", depth: 1 });
  out.push({ type: "subagentEnd", scope: b, ok: true, label: "sb", depth: 1 });
  return out;
}

/** What the fixture exposes on `window` inside the page. */
export interface ViseFixtureApi {
  /** Deliver events to the app, in order, as separate socket frames. */
  emit: (events: unknown[]) => void;
  /** Commands the app sent back over the socket. */
  sent: () => string[];
  /** Force the app's event scheduler to settle (two animation frames). */
  settle: () => Promise<void>;
  /** Long tasks (>50ms) observed since load. */
  longTasks: () => { start: number; duration: number }[];
  /** Mark the given render item's DOM node so later checks can detect a swap. */
  markNode: (itemId: string, mark: string) => boolean;
  /** Whether the node for the render item still carries the mark. */
  nodeStillMarked: (itemId: string, mark: string) => boolean;
  /** Mutations recorded inside a marked node's subtree since it was marked. */
  mutationsSince: (mark: string) => number;
}

declare global {
  interface Window {
    __vise: ViseFixtureApi;
  }
}

/**
 * Install the mock transport. Must run before navigation so it is in place
 * before the app constructs its client.
 */
export async function installFixture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sockets: { onmessage?: (e: { data: string }) => void }[] = [];
    const sent: string[] = [];
    const longTasks: { start: number; duration: number }[] = [];
    const marks = new Map<
      string,
      { node: Element; observer: MutationObserver; count: number }
    >();

    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 0;
      onopen: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      constructor(readonly url: string) {
        sockets.push(this as never);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.({});
        }, 0);
      }
      send(data: string): void {
        sent.push(data);
      }
      close(): void {
        this.readyState = 3;
        this.onclose?.({});
      }
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;

    if (typeof PerformanceObserver !== "undefined") {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push({ start: entry.startTime, duration: entry.duration });
          }
        }).observe({ entryTypes: ["longtask"] });
      } catch {
        // longtask is not observable everywhere; the report notes its absence.
      }
    }

    const nodeFor = (itemId: string): Element | null =>
      document.querySelector(`[data-item-id="${itemId}"]`);

    window.__vise = {
      emit: (events) => {
        for (const event of events) {
          const frame = JSON.stringify(event);
          for (const socket of sockets) socket.onmessage?.({ data: frame });
        }
      },
      sent: () => sent.slice(),
      settle: () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(resolve, 0)),
          );
        }),
      longTasks: () => longTasks.slice(),
      markNode: (itemId, mark) => {
        const node = nodeFor(itemId);
        if (!node) return false;
        const entry = { node, count: 0, observer: null as never };
        const observer = new MutationObserver((records) => {
          entry.count += records.length;
        });
        observer.observe(node, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
        (entry as { observer: MutationObserver }).observer = observer;
        marks.set(mark, entry);
        return true;
      },
      nodeStillMarked: (itemId, mark) => {
        const entry = marks.get(mark);
        const node = nodeFor(itemId);
        return entry !== undefined && node !== null && entry.node === node;
      },
      mutationsSince: (mark) => {
        const entry = marks.get(mark);
        if (!entry) return -1;
        entry.observer.takeRecords().forEach(() => (entry.count += 1));
        return entry.count;
      },
    };
  });
}

/** Navigate to the app with the fixture installed and the socket open. */
export async function openApp(page: Page): Promise<void> {
  await installFixture(page);
  await page.goto("/");
  await page.waitForFunction(() => typeof window.__vise?.emit === "function");
  await page.waitForSelector(".conversation");
}

/** Send events into the page and wait for the scheduler to settle. */
export async function emit(page: Page, events: Event[]): Promise<void> {
  await page.evaluate((batch) => window.__vise.emit(batch), events as unknown[]);
  await page.evaluate(() => window.__vise.settle());
}

/** The number of mounted render items. */
export async function mountedItems(page: Page): Promise<number> {
  return page.locator(".vitem").count();
}

/** The virtualizer's measured total height (the spacer), not the clamped scrollHeight. */
export async function totalHeight(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.round(
      parseFloat(
        (document.querySelector(".conversation-spacer") as HTMLElement).style
          .height,
      ),
    ),
  );
}

/** Scroll the conversation to an absolute offset (or the end) and settle. */
export async function scrollTo(page: Page, top: number | "end"): Promise<void> {
  await page.evaluate((target) => {
    const el = document.querySelector(".conversation") as HTMLElement;
    el.scrollTop = target === "end" ? el.scrollHeight : target;
  }, top);
  await page.evaluate(() => window.__vise.settle());
}

/**
 * Scroll from the top until `selector` is mounted.
 *
 * Only what is inside the window exists in the DOM, so a test that wants to
 * interact with a row has to go and find it first. Returns the scroll offset it
 * stopped at.
 */
export async function scrollUntil(page: Page, selector: string): Promise<number> {
  await scrollTo(page, 0);
  for (let i = 0; i < 200; i++) {
    if ((await page.locator(selector).count()) > 0) {
      return page.evaluate(
        () => (document.querySelector(".conversation") as HTMLElement).scrollTop,
      );
    }
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".conversation") as HTMLElement;
      const before = el.scrollTop;
      el.scrollTop += 400;
      return el.scrollTop !== before;
    });
    await page.evaluate(() => window.__vise.settle());
    if (!moved) break;
  }
  throw new Error(`never found ${selector} while scrolling the conversation`);
}

/** Scroll until a subagent run's header is mounted. */
export async function scrollToHeader(page: Page): Promise<void> {
  await scrollUntil(page, ".subagent-toggle");
}

/** Set the follow toggle (it starts on). */
export async function setFollow(page: Page, on: boolean): Promise<void> {
  const button = page.locator(".follow-toggle");
  const isOn = ((await button.textContent()) ?? "").includes("on");
  if (isOn !== on) await button.click();
  await page.evaluate(() => window.__vise.settle());
}
