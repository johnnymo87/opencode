# fix(instance): eliminate dual InstanceStore.Service materialization per directory

**Closes:** #TODO-issue-number (from the companion issue)

## Bug

The `Question` tool prompt hangs on submit. Root cause: `InstanceStore.Service` materializes **twice** per directory at startup. The two services own separate `InstanceState` `ScopedCache`s, which split downstream services (notably `Question.Service`) into two parallel instance trees. `Question.ask` lands on one tree's pending map; `Question.reply` arrives at the other and is rejected as `reply for unknown request`.

## Reproduction

Deterministic. With `opencode serve` running:

1. Connect via TUI in a directory.
2. Send a prompt that triggers the `Question` tool (e.g. "Use the Question tool to ask me which color I prefer.").
3. When the question UI appears, pick an option.
4. **Form hangs.** Server log shows `service=question requestID=que_... reply for unknown request`.

Pre-fix, this is 100% reproducible on every `Question` tool invocation. Post-fix, the form dismisses cleanly every time.

## Root cause

`opencode serve` runs **two HTTP pipelines** that share the same routes blueprint but get built with different `Layer.MemoMap` instances:

| Pipeline | Built at | memoMap |
|---|---|---|
| TCP listener (external HTTP) | `server.ts:129` | `Layer.makeMemoMapUnsafe()` — fresh per listener |
| In-process `Default` webHandler (SDK client `Server.App().fetch()`) | `httpapi/server.ts:247-253` | shared `@opencode-ai/core/effect/memo-map` |

Both pipelines depend on `InstanceStore.Service` via `InstanceLayer.layer`. With distinct memoMaps, `Layer.buildWithMemoMap` cannot dedupe across them — each pipeline ends up materializing its OWN `InstanceStore.Service` for the same directory.

The diagnostic evidence (a local patch added a random `serviceId` annotation to the `creating instance` log) shows two distinct serviceIds for one directory within ~4 seconds of startup. Stack traces confirm one comes from `onNodeHTTPRequest` (the listener) and the other from `fetch (...)` (the in-process webHandler).

### Why PR #27825 didn't fix this

#27825 fixed the `bus.publish` symptom of this partition by capturing `Bus.Service` at layer-init and threading `InstanceContext` via `attachWith`. That made `Bus.publish` consistent across fibers within a session. But `Question.ask` and `Question.reply` access `Question.Service` (not `Bus.Service`), and the partition exists at the `InstanceStore` / `InstanceState` layer **below** the bus. Any service that holds per-directory state via `InstanceState` is vulnerable to the same boundary-crossing partition.

## Fix

**Two commits.**

### Commit 1: `refactor(project): make InstanceBootstrap injectable into InstanceLayer.layer`

`InstanceLayer.layer` previously baked in `InstanceBootstrap.defaultLayer` via `Layer.provide(InstanceBootstrap.defaultLayer)`. This commit pulls `InstanceBootstrap` out as an external dependency so different runtimes (production, tests, experiments) can swap it. Updates 4 call sites (`app-runtime.ts`, `worktree/index.ts`, `httpapi/server.ts`) to provide `InstanceBootstrap.defaultLayer` explicitly alongside `InstanceLayer.layer`. Test files updated similarly.

This commit alone is a no-op behavior change; it's a testability improvement. It enables the lifecycle audit that motivated the fix in commit 2, and keeps the door open for swappable bootstraps later (e.g., test instrumentation, lazy-init experiments).

**Drop-able if reviewers prefer a minimal PR.** The two commits are independent; the fix in commit 2 stands alone.

### Commit 2: `fix(server): share memoMap between TCP listener and in-process webHandler`

The actual fix. One line plus one import at `packages/opencode/src/server/server.ts`:

```ts
import { memoMap } from "@opencode-ai/core/effect/memo-map"
// ...
function startListener(opts: ListenOptions, port: number) {
  const scope = Scope.makeUnsafe()
  return Layer.buildWithMemoMap(listenerLayer(opts, port), memoMap, scope).pipe(
//                                                         ^^^^^^^^ was Layer.makeMemoMapUnsafe()
    Effect.provide(HttpApiApp.context),
    // ...
```

Both pipelines now share the process-global `memoMap`. `Layer.buildWithMemoMap` dedupes `InstanceStore.Service` keyed by Layer reference. One `InstanceStore.Service` per directory. The `Question.Service` pending map is unified. The form dismisses.

## Test

**No automated regression test ships with this PR.**

The natural test design (a counting `InstanceBootstrap` swapped into `InstanceLayer.layer`, asserting the counter is `1` after both pipelines hit the same directory) doesn't work in the current test framework. The process-global shared `memoMap` is pre-populated by `app-runtime.ts:119`'s `ManagedRuntime.make(AppLayer, { memoMap })` before any test runs, which pre-caches a production `InstanceStore.Service` in the shared memoMap. The webHandler pipeline reuses that pre-cached service in BOTH pre-fix and post-fix runs, bypassing the test's counting bootstrap. The counter reports 1 with or without the fix.

Workarounds considered:
- Refactor `app-runtime.ts` to use a fresh memoMap → too invasive for this PR.
- Add a unique `storeId` to `InstanceStore.Service` → an originally-considered design (`Option 4` in the design doc) that turned out to be redundant with the fix.

Manual verification instead:

- **Pre-fix evidence**: diagnostic build shows two `creating instance` events for the same directory at startup. Available on request; the relevant log excerpts are in this PR description and in the linked issue.
- **Post-fix evidence**: post-deploy log shows exactly one `creating instance` event per directory across many directories, and Question tool submissions dismiss cleanly. Will share burn-in numbers below.

If reviewers have a preferred path to add an automated regression test — a way to construct a fresh shared memoMap for the test, or a different observation strategy — happy to follow up.

## Burn-in evidence

Deployed as a local patch (`opencode-patched/patches/instance-state-partition.patch`) on cloudbox since 2026-05-26 ~16:30 EDT and on devbox since [DATE-TBD]. Results across multi-day burn-in:

- ✅ One `creating instance` event per directory across N distinct directories and M sessions (N == M, no duplicates).
- ✅ Zero `reply for unknown request` / `reject for unknown request` warnings across the burn-in window.
- ✅ K Question tool form submissions, all completed cleanly (Telegram bot integration + TUI).
- ✅ Side effect: Telegram stop-notification reliability also improved (related downstream symptom of the same partition; bus-level fix in #27825 left this at the InstanceStore level).
- ✅ No regressions observed in normal use: MCP, vim mode, file operations, session lifecycle all behaving as on v1.15.10.

(Specific N / M / K numbers will be filled in just before opening this PR.)

## Connection to existing fixes

PR #27825 fixed the `bus.publish` manifestation of this partition. This PR fixes the partition itself, which also resolves the `Question` tool hang and prevents future partition-induced bugs in other services using `InstanceState`.

The two PRs are complementary: #27825's `attachWith` threading keeps `Bus.Service` lookups consistent across fibers, and this PR ensures the underlying `InstanceStore.Service` is unique-per-directory in the first place.

## Risk

The current per-listener `Layer.makeMemoMapUnsafe()` appears deliberate in spirit — `server.ts:116` also installs a fresh `ConfigProvider` per listener for env-isolation. So this isn't an accidental bug; it's a design choice that had the side effect of partitioning `InstanceStore.Service`.

Two risk vectors to consider:

1. **Service identity bleeding across listeners.** Audit: `startListener` is the entrypoint, called from very few places; no callers depend on "fresh services per listener" as far as I can tell.
2. **Lifecycle / disposal subtleties.** Services materialized via the shared memoMap are owned by the shared memoMap's lifecycle, not the per-listener scope. Disposing a listener should NOT dispose services held by the shared memoMap. This is the actual desired behavior for `InstanceStore.Service` (which should live as long as the process) but I'd appreciate a sanity check.

Burn-in across cloudbox + devbox for multiple days has surfaced no lifecycle anomalies; the system shuts down and restarts as cleanly as on stock v1.15.10.

---

Happy to discuss tradeoffs, drop commit 1 if you prefer the minimal diff, or rework the architecture more broadly if the per-listener fresh memoMap turns out to be load-bearing somewhere I missed.
