// Browser coverage for the bounded conversation viewport.
//
// These run against the real Vite app with only the WebSocket transport
// replaced (see fixture.ts). They cover two things the Bun suite cannot: the
// mounted-render-item budget, which only exists once a real layout engine has
// measured real rows, and the scroll/anchor/focus behaviour that depends on it.
//
// Timing is *recorded*, not asserted: absolute thresholds are machine-specific
// and would be flaky in CI. The report written at the end of the run carries the
// numbers for the reference environment.

import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emit,
  history,
  interleavedSubagents,
  mountedItems,
  openApp,
  scrollTo,
  scrollToHeader,
  scrollUntil,
  setFollow,
  snapshot,
  subagentRun,
  tokens,
  totalHeight,
  type Event,
} from "./fixture";

/**
 * The hard budget. Derived from the fixture: a 900px-tall viewport, render
 * items of at least 24px, and `overscan: 8` each side — about 38 visible plus
 * 16 overscan plus at most one extra item kept mounted for focus. 64 leaves
 * headroom for the shorter conversation area inside the app chrome without
 * ever admitting an unbounded window.
 *
 * This is a budget on *render items*, not on DOM nodes: one enormous Markdown
 * message is still one render item with as many descendants as its content
 * needs.
 */
const MAX_MOUNTED = 64;

const HERE = dirname(fileURLToPath(import.meta.url));
const report: Record<string, unknown> = {
  environment: {
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    note: "Chromium via Playwright, 1280x900 viewport, overscan 8.",
  },
};

test.afterAll(() => {
  const dir = join(HERE, "report");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "conversation-perf.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );
});

/** Metrics of the current window. */
async function windowStats(page: Page): Promise<{
  mounted: number;
  minHeight: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  firstId: string | null;
}> {
  return page.evaluate(() => {
    const el = document.querySelector(".conversation") as HTMLElement;
    const items = Array.from(document.querySelectorAll<HTMLElement>(".vitem"));
    const heights = items.map((n) => n.getBoundingClientRect().height);
    const box = el.getBoundingClientRect();
    const first = items
      .filter((n) => n.getBoundingClientRect().bottom > box.top + 1)
      .sort(
        (a, b) =>
          a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      )[0];
    return {
      mounted: items.length,
      minHeight: heights.length ? Math.min(...heights) : 0,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      firstId: first?.getAttribute("data-item-id") ?? null,
    };
  });
}

test.describe("bounded rendering", () => {
  for (const size of [100, 1_000, 10_000]) {
    test(`mounts at most ${MAX_MOUNTED} render items for ${size} history rows`, async ({
      page,
    }) => {
      await openApp(page);
      const started = Date.now();
      await emit(page, [snapshot(history(size))]);
      const ingestMs = Date.now() - started;

      const top = await windowStats(page);
      expect(top.mounted).toBeGreaterThan(0);
      expect(top.mounted).toBeLessThanOrEqual(MAX_MOUNTED);
      // The budget is stated for items of at least 24px; check the premise.
      expect(top.minHeight).toBeGreaterThanOrEqual(24);

      await scrollTo(page, "end");
      const bottom = await windowStats(page);
      expect(bottom.mounted).toBeLessThanOrEqual(MAX_MOUNTED);

      await scrollTo(page, Math.floor(bottom.scrollHeight / 2));
      const middle = await windowStats(page);
      expect(middle.mounted).toBeLessThanOrEqual(MAX_MOUNTED);

      // Repeat scrolling must not accumulate mounted items.
      for (let i = 0; i < 6; i++) {
        await scrollTo(page, i % 2 === 0 ? 0 : "end");
      }
      const after = await windowStats(page);
      expect(after.mounted).toBeLessThanOrEqual(MAX_MOUNTED);

      report[`snapshot_${size}`] = {
        ingestMs,
        mountedTop: top.mounted,
        mountedBottom: bottom.mounted,
        mountedAfterRepeatScroll: after.mounted,
        scrollHeight: bottom.scrollHeight,
        clientHeight: bottom.clientHeight,
      };
    });
  }

  test("reopening a large subagent obeys the same budget", async ({ page }) => {
    await openApp(page);
    await emit(page, [snapshot(history(50))]);
    await emit(page, subagentRun("big", 3_000));

    // The run has ended, so it is collapsed: none of its children are rendered.
    await expect(page.locator(".row-in-group")).toHaveCount(0);
    await setFollow(page, false);
    await scrollToHeader(page);
    const header = page.locator(".subagent-toggle").first();
    await expect(header).toHaveAttribute("aria-expanded", "false");

    await header.click();
    await page.evaluate(() => window.__vise.settle());
    await expect(header).toHaveAttribute("aria-expanded", "true");

    const expanded = await windowStats(page);
    expect(expanded.mounted).toBeLessThanOrEqual(MAX_MOUNTED);
    // The children really are in the sequence now, just not all mounted.
    expect(await page.locator(".row-in-group").count()).toBeGreaterThan(0);

    await scrollTo(page, "end");
    expect((await windowStats(page)).mounted).toBeLessThanOrEqual(MAX_MOUNTED);

    report.largeSubagent = {
      children: 3_000,
      mountedWhenExpanded: expanded.mounted,
      scrollHeight: expanded.scrollHeight,
    };
  });

  test("a closed reasoning body and a closed run mount no descendants", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot(history(20), { turnActive: true })]);
    await emit(page, [
      { type: "reasoning", scope: { kind: "main" }, text: "step one\n\nstep two" },
    ]);
    // While reasoning streams the block is open and its Markdown is mounted.
    await expect(page.locator(".reasoning .markdown")).toHaveCount(1);

    await emit(page, [
      { type: "turnEnd", answer: "", kind: "text", finished: true },
    ]);
    // Closed: the row is still mounted, its body is not.
    await expect(page.locator("details.reasoning")).toHaveCount(1);
    await expect(page.locator(".reasoning .markdown")).toHaveCount(0);

    await emit(page, subagentRun("s1", 40));
    await setFollow(page, false);
    await scrollToHeader(page);
    await expect(page.locator(".subagent-toggle")).toHaveCount(1);
    await expect(page.locator(".row-in-group")).toHaveCount(0);
  });
});

test.describe("streaming", () => {
  test("a live token neither replaces nor mutates a historical node", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot(history(400), { turnActive: true })]);
    await setFollow(page, false);
    await scrollTo(page, "end");
    // Step off the end so the "stay pinned while the bottom grows" path cannot
    // scroll the marked row out of the window.
    const atEnd = await windowStats(page);
    await scrollTo(page, Math.max(atEnd.scrollTop - 300, 0));

    const stats = await windowStats(page);
    const markedId = stats.firstId!;
    expect(markedId).not.toBeNull();
    expect(
      await page.evaluate(
        (id) => window.__vise.markNode(id, "historical"),
        markedId,
      ),
    ).toBe(true);

    const before = await page.evaluate(
      (id) =>
        document.querySelector(`[data-item-id="${id}"]`)!.innerHTML,
      markedId,
    );

    const started = Date.now();
    await emit(page, tokens({ kind: "main" }, 400, "live"));
    const streamMs = Date.now() - started;

    const stillSame = await page.evaluate(
      (id) => window.__vise.nodeStillMarked(id, "historical"),
      markedId,
    );
    const mutations = await page.evaluate(() =>
      window.__vise.mutationsSince("historical"),
    );
    const after = await page.evaluate(
      (id) => document.querySelector(`[data-item-id="${id}"]`)!.innerHTML,
      markedId,
    );

    expect(stillSame).toBe(true);
    expect(mutations).toBe(0);
    expect(after).toBe(before);

    // The live text landed, exactly once, in a single row.
    const liveRow = page.locator(".row-assistantMessage").last();
    await scrollTo(page, "end");
    await expect(liveRow).toContainText("live399");
    report.streaming = { deltas: 400, streamMs };
  });

  test("batched deltas produce exactly the delivered text, in order", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot([], { turnActive: true })]);
    const a = { kind: "sub" as const, id: "sa", depth: 1 };
    const events: Event[] = [];
    for (let i = 0; i < 50; i++) {
      events.push({ type: "token", scope: { kind: "main" }, text: `m${i} ` });
      events.push({ type: "token", scope: a, text: `s${i} ` });
    }
    await emit(page, events);
    await emit(page, [
      { type: "subagentEnd", scope: a, ok: true, label: "sa", depth: 1 },
    ]);

    const mainText = await page
      .locator(".vitem")
      .first()
      .locator(".markdown")
      .innerText();
    const expected = Array.from({ length: 50 }, (_, i) => `m${i}`).join(" ");
    expect(mainText.replace(/\s+/g, " ").trim()).toBe(expected);

    // The subagent's own text is one row inside its run, not fragments.
    await setFollow(page, false);
    await scrollToHeader(page);
    await page.locator(".subagent-toggle").first().click();
    await page.evaluate(() => window.__vise.settle());
    const subText = await page
      .locator(".row-in-group.row-assistantMessage")
      .first()
      .innerText();
    expect(subText.replace(/\s+/g, " ").trim()).toBe(
      Array.from({ length: 50 }, (_, i) => `s${i}`).join(" "),
    );
  });

  test("a mid-turn reconnect snapshot replays in-flight events without duplicates", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [
      snapshot(history(12), {
        turnActive: true,
        inflight: [
          { type: "token", scope: { kind: "main" }, text: "partial " },
          { type: "token", scope: { kind: "main" }, text: "answer" },
        ],
      }),
    ]);
    await scrollTo(page, "end");
    const text = await page.locator(".conversation").innerText();
    expect(text.match(/partial answer/g)?.length ?? 0).toBe(1);
    // History is not duplicated either.
    expect(text.match(/user 0/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});

test.describe("navigation", () => {
  test("follow off never pulls the reader down; follow on jumps to latest", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot(history(600), { turnActive: true })]);
    await setFollow(page, false);
    await scrollTo(page, 0);

    const before = await windowStats(page);
    await emit(page, tokens({ kind: "main" }, 200, "x"));
    const after = await windowStats(page);
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2);
    expect(after.firstId).toBe(before.firstId);

    // Turning follow on jumps to the newest output immediately.
    await setFollow(page, true);
    const followed = await windowStats(page);
    expect(
      followed.scrollHeight - followed.scrollTop - followed.clientHeight,
    ).toBeLessThanOrEqual(40);
  });

  test("follow on during a turn stays at the latest output", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot(history(300), { turnActive: true })]);
    await setFollow(page, true);
    await scrollTo(page, 0);
    await emit(page, tokens({ kind: "main" }, 120, "y"));
    const stats = await windowStats(page);
    expect(
      stats.scrollHeight - stats.scrollTop - stats.clientHeight,
    ).toBeLessThanOrEqual(40);
  });

  test("idle follow does not yank a reader who is scrolled up", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot(history(300))]); // turnActive: false
    await setFollow(page, true);
    await scrollTo(page, 0);
    const before = await windowStats(page);
    await emit(page, [
      { type: "toolCall", scope: { kind: "main" }, name: "t", args: {} },
    ]);
    const after = await windowStats(page);
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2);
  });

  test("the oldest and newest rows stay reachable with exact text", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot(history(2_000))]);
    await scrollTo(page, 0);
    await expect(page.locator(".vitem").first()).toContainText("user 0");
    await scrollTo(page, "end");
    await expect(page.locator(".vitem").last()).toContainText("read f1998.ts");
  });

  test("expanding and collapsing a run keeps the reading anchor in place", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot(history(40))]);
    await emit(page, subagentRun("s1", 200));
    await emit(page, [
      ...Array.from({ length: 200 }, (_, i) => ({
        type: "toolCall",
        scope: { kind: "main" },
        name: "after",
        args: { i },
      })),
    ]);
    await setFollow(page, false);

    // Park the run's header at the top of the viewport: it is then the anchor
    // the virtualizer re-anchors on when the content below it changes size.
    await scrollToHeader(page);
    await page.evaluate(() => {
      const el = document.querySelector(".conversation") as HTMLElement;
      const head = document.querySelector(".subagent-toggle")!.closest(".vitem")!;
      el.scrollTop +=
        head.getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
    await page.evaluate(() => window.__vise.settle());

    const anchorId = await page.evaluate(
      () =>
        document
          .querySelector(".subagent-toggle")!
          .closest(".vitem")!
          .getAttribute("data-item-id")!,
    );
    const topOf = (): Promise<number> =>
      page.evaluate(
        (id) =>
          document.querySelector(`[data-item-id="${id}"]`)!.getBoundingClientRect()
            .top,
        anchorId,
      );
    const beforeY = await topOf();

    // Expanding inserts 200 rows below the anchor.
    await page.locator(".subagent-toggle").first().click();
    await page.evaluate(() => window.__vise.settle());
    await page.evaluate(() => window.__vise.settle());
    expect(Math.abs((await topOf()) - beforeY)).toBeLessThanOrEqual(2);

    // Collapsing removes them again.
    await page.locator(".subagent-toggle").first().click();
    await page.evaluate(() => window.__vise.settle());
    await page.evaluate(() => window.__vise.settle());
    expect(Math.abs((await topOf()) - beforeY)).toBeLessThanOrEqual(2);
  });
});

test.describe("interaction state", () => {
  test("a manual expansion survives scrolling out of the window", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot(history(40))]);
    await emit(page, subagentRun("s1", 60));
    await emit(page, [
      ...Array.from({ length: 600 }, (_, i) => ({
        type: "toolCall",
        scope: { kind: "main" },
        name: "after",
        args: { i },
      })),
    ]);
    await setFollow(page, false);
    await scrollToHeader(page);

    const header = page.locator(".subagent-toggle").first();
    await header.click();
    await page.evaluate(() => window.__vise.settle());
    await expect(header).toHaveAttribute("aria-expanded", "true");

    // Scroll far past it, so the header and its children unmount, then back.
    await scrollTo(page, "end");
    await scrollToHeader(page);
    await expect(page.locator(".subagent-toggle").first()).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // The children are back in the sequence too — found by scrolling, since
    // only what is inside the window is in the DOM.
    await scrollUntil(page, ".row-in-group");
    expect(await page.locator(".row-in-group").count()).toBeGreaterThan(0);
  });

  test("completion collapses a run and the end of the turn does not reopen it", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot(history(10), { turnActive: true })]);
    await emit(page, subagentRun("s1", 20, { end: false }));
    await setFollow(page, false);
    await scrollToHeader(page);
    const header = page.locator(".subagent-toggle").first();
    await expect(header).toHaveAttribute("aria-expanded", "true");

    await emit(page, [
      { type: "subagentEnd", scope: { kind: "sub", id: "s1", depth: 1 }, ok: true, label: "s1", depth: 1 },
    ]);
    await expect(header).toHaveAttribute("aria-expanded", "false");

    await emit(page, [
      { type: "turnEnd", answer: "", kind: "text", finished: true },
    ]);
    await expect(header).toHaveAttribute("aria-expanded", "false");
  });

  test("interleaved same-depth runs render as separate labelled groups", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot([], { turnActive: true })]);
    await emit(page, interleavedSubagents(4));
    await setFollow(page, false);
    await scrollToHeader(page);
    const headers = page.locator(".subagent-toggle");
    expect(await headers.count()).toBeGreaterThanOrEqual(2);
    await expect(headers.first()).toContainText("subagent");
    for (const text of await headers.allTextContents()) {
      expect(text).toMatch(/subagent (running|done), \d+ rows?/);
    }
  });

  test("keyboard focus keeps its render item mounted", async ({ page }) => {
    await openApp(page);
    await emit(page, [snapshot(history(30))]);
    await emit(page, subagentRun("s1", 20));
    await emit(page, [
      ...Array.from({ length: 800 }, (_, i) => ({
        type: "toolCall",
        scope: { kind: "main" },
        name: "after",
        args: { i },
      })),
    ]);
    await setFollow(page, false);
    await scrollToHeader(page);

    const header = page.locator(".subagent-toggle").first();
    await header.focus();
    const focusedId = await page.evaluate(
      () =>
        document.activeElement
          ?.closest("[data-item-id]")
          ?.getAttribute("data-item-id") ?? null,
    );
    expect(focusedId).not.toBeNull();

    await scrollTo(page, "end");
    const stats = await windowStats(page);
    expect(stats.mounted).toBeLessThanOrEqual(MAX_MOUNTED);
    // The focused control is still in the document, kept by the range extractor.
    expect(
      await page.evaluate(
        (id) => document.querySelector(`[data-item-id="${id}"]`) !== null,
        focusedId,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.activeElement?.classList.contains("subagent-toggle") ?? false,
      ),
    ).toBe(true);
  });

  test("collapsing a run that holds focus moves focus to its header", async ({
    page,
  }) => {
    await openApp(page);
    await emit(page, [snapshot(history(6), { turnActive: true })]);
    await emit(page, [
      { type: "reasoning", scope: { kind: "sub", id: "s1", depth: 1 }, text: "why" },
      { type: "toolCall", scope: { kind: "sub", id: "s1", depth: 1 }, name: "t", args: {} },
    ]);
    // Focus a child control inside the open run.
    await setFollow(page, false);
    await scrollToHeader(page);
    const childSummary = page.locator(".row-in-group summary").first();
    await childSummary.focus();
    await page.locator(".subagent-toggle").first().click();
    await page.evaluate(() => window.__vise.settle());
    expect(
      await page.evaluate(
        () => document.activeElement?.classList.contains("subagent-toggle") ?? false,
      ),
    ).toBe(true);
  });
});

test.describe("layout and lifecycle", () => {
  test("a viewport resize re-measures without drifting or looping", async ({
    page,
  }) => {
    await openApp(page);
    // Long prose, so narrowing genuinely re-wraps it. Rows are capped at 75ch,
    // so the viewport has to get narrower than that cap for anything to change.
    const para =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod " +
      "tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim " +
      "veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea " +
      "commodo consequat. Duis aute irure dolor in reprehenderit in voluptate.";
    await emit(page, [
      snapshot(
        Array.from({ length: 30 }, (_, i) => ({
          kind: "assistantMessage",
          text: `${para} (${i})`,
        })),
      ),
    ]);
    await setFollow(page, false);
    await scrollTo(page, 0);
    // The measured total, not `scrollHeight` — the latter is clamped to the
    // client height and hides the change when content is short.
    const wide = await totalHeight(page);

    await page.setViewportSize({ width: 520, height: 900 });
    await page.evaluate(() => window.__vise.settle());
    await page.evaluate(() => window.__vise.settle());
    const narrow = await totalHeight(page);
    expect(narrow).toBeGreaterThan(wide);

    // Settling again must not keep changing the height (no re-measure loop).
    await page.evaluate(() => window.__vise.settle());
    const settled = await totalHeight(page);
    expect(Math.abs(settled - narrow)).toBeLessThanOrEqual(2);
    expect((await windowStats(page)).mounted).toBeLessThanOrEqual(MAX_MOUNTED);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => window.__vise.settle());
    await page.evaluate(() => window.__vise.settle());
    // Widening shrinks it back. Not to the exact original total: re-measuring
    // clears the size cache, so rows outside the window fall back to estimates
    // until they are rendered again. What matters is that the correction runs
    // in both directions.
    const restored = await totalHeight(page);
    expect(restored).toBeLessThan(narrow);
  });

  test("an image corrects its row's measurement once it loads", async ({
    page,
  }) => {
    await openApp(page);
    // Generated in the page so the bytes are certainly a decodable PNG.
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 120;
      canvas.height = 90;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#2563eb";
      ctx.fillRect(0, 0, 120, 90);
      return canvas.toDataURL("image/png");
    });
    await emit(page, [
      snapshot([
        { kind: "assistantMessage", text: "before" },
        { kind: "assistantMessage", text: `![shape](${png})` },
        { kind: "assistantMessage", text: "after" },
      ]),
    ]);
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>(".markdown img");
      return img !== null && img.complete && img.naturalHeight > 0;
    });
    await page.evaluate(() => window.__vise.settle());
    await page.evaluate(() => window.__vise.settle());
    const imageItemHeight = await page.evaluate(() => {
      const img = document.querySelector<HTMLImageElement>(".markdown img")!;
      return img.closest(".vitem")!.getBoundingClientRect().height;
    });
    // 90px of image plus the row's own spacing: the estimate (72px) has been
    // replaced by a real measurement.
    expect(imageItemHeight).toBeGreaterThan(95);
    expect(await totalHeight(page)).toBeGreaterThan(imageItemHeight);
  });

  test("clear and a fresh snapshot reset the viewport", async ({ page }) => {
    await openApp(page);
    await emit(page, [snapshot(history(500))]);
    await scrollTo(page, "end");
    await emit(page, [{ type: "cleared" }]);
    await expect(page.locator(".empty")).toBeVisible();
    expect(await mountedItems(page)).toBe(0);

    await emit(page, [snapshot(history(8))]);
    await expect(page.locator(".empty")).toHaveCount(0);
    const stats = await windowStats(page);
    expect(stats.mounted).toBeGreaterThan(0);
    expect(stats.mounted).toBeLessThanOrEqual(MAX_MOUNTED);
    await expect(page.locator(".vitem").first()).toContainText("user 0");
  });

  test("records long tasks and steady-state cost for the report", async ({
    page,
  }) => {
    await openApp(page);
    const ingestStart = Date.now();
    await emit(page, [snapshot(history(10_000), { turnActive: true })]);
    const ingestMs = Date.now() - ingestStart;
    const ingestTasks = await page.evaluate(() => window.__vise.longTasks());

    const streamStart = Date.now();
    await emit(page, tokens({ kind: "main" }, 600, "s"));
    const streamMs = Date.now() - streamStart;
    const allTasks = await page.evaluate(() => window.__vise.longTasks());
    const steadyTasks = allTasks.slice(ingestTasks.length);

    report.baseline = {
      historySize: 10_000,
      ingestMs,
      ingestLongTasks: ingestTasks.length,
      streamDeltas: 600,
      streamMs,
      steadyStateLongTasks: steadyTasks.length,
      steadyStateLongestMs: steadyTasks.reduce(
        (max, t) => Math.max(max, t.duration),
        0,
      ),
      mounted: (await windowStats(page)).mounted,
      note: "Snapshot ingestion is O(history) by design; steady-state streaming is not.",
    };

    // Not a timing assertion: the budget is what is gated. Steady-state work
    // must at least stay bounded in *item* terms.
    expect((await windowStats(page)).mounted).toBeLessThanOrEqual(MAX_MOUNTED);
  });
});
