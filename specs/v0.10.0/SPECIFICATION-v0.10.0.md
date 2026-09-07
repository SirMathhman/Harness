# System Specification: Backend Capacity and the Subagent Model Gate

**Version:** 0.10.0
**Date:** 2026-09-07
**Builds on:** v0.9.0 (the runtime context window)

---

## 1. Purpose and Scope

### 1.1 Purpose

Stop a subagent from evicting the model its parent is running on.

A llama.cpp **router** hosts many models on one server but holds at most
`--models-max` of them resident at a time. When a subagent's profile selects a
_different_ model on that same server, the router makes room the only way it can:
it evicts the parent's model, loads the subagent's, and reloads the parent when
the subagent returns.

```
models_max reached, request for name=<subagent model> queued at position 1
evicting idle LRU name=<parent model> to make room for name=<subagent model>
```

Each of those reloads is tens of seconds of pure overhead, and nothing in the
system asked for it — the parent's conversation is unchanged, its KV cache is
saved and restored around the nested run (KV spec §3), and yet the weights
themselves are thrown away and re-read from disk twice.

Through v0.9.0 nothing checked. A profile that named a second model simply got
one, and the eviction was invisible until it showed up as latency.

The fix is to ask first. Before a subagent switches to a different model on the
same backend, the backend is asked whether it can hold both. If it cannot, the
subagent **fails** with an actionable message rather than running at the cost of
its parent's residency.

Failing is deliberate. Silently falling back to the parent's model would run the
subagent on a model its profile did not ask for — the wrong prompt paired with
the wrong weights, invisibly. A refusal that names the problem is more useful
than a substitution that hides it.

### 1.2 Scope

In scope:

- A read-only capacity question on the provider seam: `Provider.admitModel()`.
- A `LlamaProvider` implementation of it: slot count from `GET /props` →
  `max_instances`, plus an optional host-supplied VRAM probe.
- A gate in the subagent runner that consults it and refuses (E-P9).

Out of scope:

- **Automatic VRAM discovery.** llama.cpp exposes no device memory over HTTP;
  see §2.3. The host supplies it or it is not checked.
- **Choosing a different model to satisfy a profile.** The gate refuses; it never
  re-selects. A whitelist that matches several models still takes the first.
- **Anything cross-provider.** Two providers are two servers and do not contend.

---

## 2. Domain Model

### 2.1 Capacity is a property of a backend

Not of a model, and not of the graph. A router started with `--models-max 2`
holds two models; the same models on a `--models-max 1` server contend. The
number is knowable only by asking the server, and only the provider knows how.

### 2.2 Residency is observed, never assumed

`GET /v1/models` marks a resident model by giving it a `meta` object; an entry
the router has never loaded carries none. That is the only authority on what is
loaded, and it is the provider's to read — a caller knows its own model and
nothing about what else the server happens to be holding.

This is why `admitModel(model)` takes one model and determines residency itself,
rather than taking a caller-supplied list of resident models. A caller that
guessed "just my parent's model" would be wrong whenever anything else was
resident.

### 2.3 VRAM is not observable

Slot count is discoverable; free memory is not. On a router:

| Endpoint             | What it gives                                        |
| -------------------- | ---------------------------------------------------- |
| `GET /props`         | `max_instances`, and nothing about memory            |
| `GET /v1/models`     | `meta.size` (bytes) **only for already-loaded models** |
| `/metrics`, `/slots` | HTTP 400 in router mode                              |
| `/devices`, `/memory`| 404                                                  |

Nor can the question be answered by trying: a failed load still evicts the
resident model first, which is precisely what the gate exists to prevent.

So VRAM enters through the host, as `LlamaProviderOptions.freeVramMiB` — a
callback the user supplies (typically shelling out to `nvidia-smi`). Vise does
not shell out to a GPU tool itself; a platform-neutral harness does not acquire a
dependency on one vendor's CLI.

Two consequences follow, and both resolve toward permitting the run:

- **No probe configured** → VRAM is never checked; the slot count gates alone.
- **Size unknown** → a model that has never been resident has no `meta.size`, so
  there is nothing to compare. Allowed.

`meta.size` is also weights only — it excludes the KV cache and compute buffers,
so it is a floor on the real cost, not the real cost. With `--fit on` a tight fit
does not fail; the new model's context is shrunk toward `--fit-ctx` instead. A
passing VRAM check therefore means _the weights fit_, and a caller who cares
about the resulting window should pin `ctx-size` per model on the server.

---

## 3. Behavior

### 3.1 The provider seam

```ts
interface ModelAdmission {
  ok: boolean;
  reason?: string;
  loaded: string[];
}

admitModel?(model: string): Promise<ModelAdmission | null>;
```

Optional, like `contextWindow()` and for the same reason: not every backend can
answer. Read-only, never forces a load, and never throws — "cannot say" is
`null`. `loaded` accompanies every verdict so a refusal can name the alternatives
without a second round trip.

### 3.2 The slot check

`GET /props` → `max_instances`, compared against the number of resident entries.

A positive reading is cached for the provider's lifetime: it is fixed by the
server's command line and cannot change while that server runs. A reading that
fails is **not** cached — a momentarily unreachable server must not be recorded
as permanently unknowable.

A server that reports no `max_instances` and is not a router holds exactly one
model, which is an answer of `1`, not an unknown. A *router* that reports none is
genuinely unknown, and the gate treats that as a refusal: capacity that cannot be
established cannot be relied on.

### 3.3 The VRAM check

Applies only when a `freeVramMiB` probe is configured **and** the candidate's
size has been learned. Sizes are learned opportunistically — every `/v1/models`
response the provider reads for any reason has its `meta.size` values recorded.

The probe is user code sitting on a path contracted never to throw, so a throw is
caught and treated as `null`, exactly like a probe that declines to answer.

### 3.4 The gate

In the subagent runner, after model selection and **before** `resolveProfile`, so
a refusal costs no materialization.

| Case                                                     | Outcome                          |
| -------------------------------------------------------- | -------------------------------- |
| Profile has no `models` whitelist (inherits the parent)  | Allowed, unchanged, never asks   |
| Candidate is the parent's own model                      | Allowed; already resident        |
| Candidate's provider differs from the parent's           | Allowed; no contention           |
| Either side has no provider (`reg.createModel()`)        | Allowed; nothing to ask          |
| Provider has no `admitModel()`                           | Allowed                          |
| `admitModel()` returns `null` or throws                  | Allowed                          |
| `admitModel()` returns `ok: true`                        | Allowed                          |
| `admitModel()` returns `ok: false`                       | **Refused (E-P9)**               |

A refusal emits `{ kind: "end", ok: false, label: "failed" }` and returns a
string. It is never thrown: a subagent failure is data the parent model reads and
reacts to, not control flow (E18–E20).

```
subagent failed: profile "Explore" requested model "<model>" on provider
"llama_0", which has no free model slot (1 of 1 in use). Try a model that is
already loaded on "llama_0" (currently loaded: <models>) or a different provider.
```

---

## 4. Errors

| Condition                                        | Behavior                                                     |
| ------------------------------------------------ | ------------------------------------------------------------ |
| **E-P9** — backend cannot hold the chosen model  | The subagent fails with the message above. Not fatal.        |
| Provider has no `admitModel()`                   | Allowed. Not fatal.                                          |
| `admitModel()` throws                            | Treated as `null` → allowed; the turn is unaffected.          |
| Backend unreachable during the check             | `null` → allowed.                                             |
| Router reports no `max_instances`                | Refused — unestablished capacity is not assumed.              |
| `freeVramMiB` throws or returns a non-number     | Treated as unknown → the slot check stands alone.             |

---

## 5. Acceptance Criteria

| #   | Criterion                                                            | Test                                                                    |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | A free slot admits the model                                         | `providers.test.ts` "admits a model when a slot is free"                 |
| 2   | No free slot refuses, and names what is loaded                       | `providers.test.ts` "refuses when every slot is in use"                  |
| 3   | An already-resident model is always admitted                         | `providers.test.ts` "always admits a model that is already loaded"       |
| 4   | An unknown size is admitted on the slot check alone                  | `providers.test.ts` "admits a model whose size is unknown"               |
| 5   | A known size larger than free VRAM is refused                        | `providers.test.ts` "refuses when the model is larger than free VRAM"    |
| 6   | A VRAM probe that throws is treated as unknown                       | `providers.test.ts` "a VRAM probe that throws"                           |
| 7   | Without a probe, VRAM is not checked                                 | `providers.test.ts` "does not check VRAM without a probe"                |
| 8   | A router that reports no `max_instances` is refused                  | `providers.test.ts` "refuses when a router will not report capacity"     |
| 9   | A plain single-model server counts as one slot                       | `providers.test.ts` "treats a plain server as a single slot"             |
| 10  | A positive slot count is cached; a failed read is not                | `providers.test.ts` "caches a positive slot count"                       |
| 11  | An unreachable server reports `null`, never throws                   | `providers.test.ts` "reports null for an unreachable server"             |
| 12  | The parent's own model is admitted without asking the backend        | `providers.test.ts` "never asks about the parent's own model"            |
| 13  | A different provider is never gated                                  | `providers.test.ts` "never gates a model on a different provider"        |
| 14  | An admitted model runs the subagent normally                         | `providers.test.ts` "runs the subagent when the backend admits"          |
| 15  | A refused model fails the subagent with an actionable message        | `providers.test.ts` "fails the subagent when the backend refuses"        |
| 16  | A provider without `admitModel()` is never gated                     | `providers.test.ts` "never gates a provider that cannot answer"          |
