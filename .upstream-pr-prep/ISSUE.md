# Bug: InstanceStore.Service materializes twice per directory, causing Question tool to hang on submit

## Summary

The `Question` tool prompt hangs on submit. Root cause: `InstanceStore.Service` materializes **twice** per directory at startup, splitting downstream services (notably `Question.Service`) into two parallel instance trees. `Question.ask` is hosted by one tree; `Question.reply` arrives at the other and is rejected as `reply for unknown request`. The form never dismisses.

## Reproduction

Deterministic. Any single-option `Question` tool prompt reproduces it:

1. Start `opencode serve` and connect via TUI.
2. Send a prompt that uses the `Question` tool, e.g.:
   > "I have a question for you: do you prefer option A, option B, or option C? Use the Question tool to ask me."
3. When the inline-keyboard question appears, pick an option.
4. Form does not dismiss. Server log shows:
   ```
   service=question requestID=que_... reply for unknown request
   ```
5. User cannot submit a different answer, cannot Esc, cannot Ctrl-C. Recovery requires killing the terminal.

## Root cause (confirmed empirically)

`opencode serve` runs **two HTTP-handling pipelines** that share the same routes blueprint but get built with **different `Layer.MemoMap` instances**:

- **TCP listener** (`packages/opencode/src/server/server.ts:129`): built with `Layer.makeMemoMapUnsafe()` — a fresh memoMap per listener.
- **In-process `Default` webHandler** (`packages/opencode/src/server/routes/instance/httpapi/server.ts:247`): built with the shared `@opencode-ai/core/effect/memo-map` `memoMap`.

Both pipelines depend on `InstanceStore.Service` via `InstanceLayer.layer`. With distinct memoMaps, `Layer.buildWithMemoMap` cannot dedupe the build: each pipeline materializes its OWN `InstanceStore.Service` for the same directory. Each `InstanceStore.Service` owns its own `InstanceState` `ScopedCache`, which means each `Question.layer` materialization gets its own pending-question `Map`.

When `Question.ask` runs from a tool-execution fiber, it stores in pending map A. When `Question.reply` runs from an HTTP-handler fiber on the OTHER pipeline, it reads from pending map B. The request ID is not in B → `reply for unknown request`.

### Evidence (diagnostic build with stack capture)

A local diagnostic patch added a `serviceId` annotation to the `creating instance` log line. Within ~4 seconds of `opencode serve` startup, two events fire for the same directory:

```
INFO service=default
  stack=Error | ... at onNodeHTTPRequest (node:_http_server:373:22)
  serviceId=cy5eoxd9
  directory=/home/dev/projects/pigeon
  creating instance

INFO service=default
  stack=Error | ... at fetch (/$bunfs/root/chunk-wv3z9c79.js:657:9882)
        | at async <anonymous> (/home/dev/projects/pigeon/packages/opencode-plugin/src/index.ts:231:53)
  serviceId=uabp6bnk
  directory=/home/dev/projects/pigeon
  creating instance
```

- **Two distinct `serviceId`s** — `cy5eoxd9` and `uabp6bnk` — for one directory.
- Stack 1 originates in `onNodeHTTPRequest` (the TCP listener).
- Stack 2 originates in `fetch` (the in-process Default webHandler called by an SDK client's `Server.App().fetch()` invocation).
- Both saw `cacheHadBefore=false` — neither pipeline could see the other's `InstanceStore.Service`.

## Why PR #27825 didn't fix this

#27825 (`fix(sync): publish events on injected project bus`) addressed the **bus.publish** manifestation of this partition: it captured `Bus.Service` at layer-init and threaded `InstanceContext` via `attachWith` so `Bus.publish` resolves consistently across fibers within a single session.

But `Question.ask` and `Question.reply` access `Question.Service` (not `Bus.Service`), and the partition exists at the `InstanceStore` / `InstanceState` layer **below** the bus. Any service that holds per-directory state via `InstanceState` (Question, Plugin, anything using `InstanceState.make`) is vulnerable to the same boundary-crossing partition.

## Proposed fix

One-line change at `packages/opencode/src/server/server.ts:129`:

```ts
// Before
return Layer.buildWithMemoMap(listenerLayer(opts, port), Layer.makeMemoMapUnsafe(), scope).pipe(

// After
return Layer.buildWithMemoMap(listenerLayer(opts, port), memoMap, scope).pipe(
```

(plus an import: `import { memoMap } from "@opencode-ai/core/effect/memo-map"`).

With both pipelines pulling from the same shared memoMap, `Layer.buildWithMemoMap` dedupes `InstanceStore.Service` keyed by Layer reference. One `InstanceStore.Service` per directory. The `Question.Service` pending map is unified. The form dismisses.

### Risk assessment

The current per-listener `Layer.makeMemoMapUnsafe()` appears deliberate in spirit — `server.ts` also installs a fresh `ConfigProvider` per listener (line 116) for env-isolation. So this isn't an accidental bug; it's a design choice that has the side effect of partitioning `InstanceStore.Service`.

Two risks to evaluate:

1. **Service identity bleeding across listeners.** If anything depends on "fresh services per listener," it'll regress. Audit shows `startListener` is the entrypoint with few callers; risk seems low but worth a careful look.
2. **Lifecycle subtleties.** Services built via the shared memoMap are owned by the shared memoMap's lifecycle, not the per-listener scope. Disposing a listener shouldn't dispose services held by the shared memoMap; this MIGHT be the intended behavior or might break expectations.

## Local burn-in evidence

Deployed as a local patch (`opencode-patched/patches/instance-state-partition.patch`) on cloudbox since 2026-05-26 ~16:30 EDT. Tier 1 validation results:

- ✅ One `creating instance` event per directory across 4 distinct directories.
- ✅ 11/11 Question tool form submissions completed cleanly (Telegram + TUI surfaces).
- ✅ Zero `reply for unknown request` / `reject for unknown request` warnings in the validation log.

Multi-day (Tier 3) burn-in across cloudbox + devbox is in progress; will share results in the follow-up PR.

## Question for maintainers

Happy to open a PR. Would prefer feedback on the fix direction before opening it. Three specific questions:

1. **Is the per-listener fresh memoMap intentional, and if so, what is it protecting against?** (i.e., is there a use case that the shared-memoMap change would regress?)
2. **Would you prefer the fix at `server.ts:129`, or would you rather change the architecture more broadly** (e.g., refactor `app-runtime.ts` so `AppRuntime` doesn't pre-populate the shared memoMap with `InstanceStore.Service` at module load)?
3. **Any preference on whether the PR also includes a refactor making `InstanceBootstrap` injectable into `InstanceLayer.layer`** — useful for testability but adds 8 files to the diff. (Without it the fix is just 2 lines; with it, the bootstrap is swappable for future tests / experimentation.)

I have a complete design + investigation document I can share if useful.

---

(All "upstream" references in this issue and the accompanying PR target `anomalyco/opencode`. The fix applies cleanly against v1.15.10.)
