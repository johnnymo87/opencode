import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceLayer } from "../../src/project/instance-layer"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// void Log.init({ print: false })  // disabled for debugging

// Counter incremented every time InstanceBootstrap.run fires. Reset per-test
// in `testStateLayer`'s finalizer chain. Module-scoped so the override layer
// closes over it.
let bootstrapCalls = 0

// Counter for InstanceBootstrap construction (how many times the Layer.effect
// resolves). Separately from `bootstrapCalls` which counts invocations of `run`.
let bootstrapServiceConstructions = 0

import { InstanceRef } from "../../src/effect/instance-ref"

const countingBootstrap = Layer.effect(
  InstanceBootstrap.Service,
  Effect.sync(() => {
    bootstrapServiceConstructions++
    const serviceId = bootstrapServiceConstructions
    // eslint-disable-next-line no-console
    console.log("DEBUG bootstrap Service constructed, id =", serviceId)
    const myRun = Effect.gen(function* () {
      bootstrapCalls++
      // eslint-disable-next-line no-console
      console.log("DEBUG MY-RUN bootstrap.run fired (serviceId =", serviceId, "), calls now =", bootstrapCalls)
      yield* Effect.void
    })
    // eslint-disable-next-line no-console
    console.log("DEBUG Service.of called with myRun for serviceId", serviceId)
    return InstanceBootstrap.Service.of({
      run: myRun,
    })
  }),
)

// InstanceLayer.layer wired with the counting bootstrap. Routes built from this
// layer go through InstanceStore.Service whose `boot` calls our counting `run`.
// Project.defaultLayer is provided here (not in `createRoutes`'s big provide
// list — the test only swaps the bootstrap; Project stays default).
const countingInstanceLayer = InstanceLayer.layer.pipe(
  Layer.provide(countingBootstrap),
  Layer.provide(Project.defaultLayer),
)

// Routes layer wired with the counting bootstrap. Used by BOTH pipelines:
// the listener (via `Server.listenWithRoutes`) and the webHandler (via
// `HttpApiApp.webHandlerFor`). Built once at module load (mirrors production's
// module-level `routes`) so both pipelines reference the same Layer blueprint
// — the memoMap split is the only source of divergence.
const countingRoutes = HttpApiApp.createRoutes(undefined, countingInstanceLayer)

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    bootstrapCalls = 0
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await disposeAllInstances()
        await resetDatabase()
      }),
    )
  }),
)

const it = testEffect(Layer.mergeAll(testStateLayer, CrossSpawnSpawner.defaultLayer))

describe("InstanceStore partition (listener vs in-process webHandler)", () => {
  it.live(
    "listener and webHandler share a single InstanceStore.Service for the same directory",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })

        // Pipeline B FIRST: in-process webHandler (uses shared `memoMap`).
        const handler = HttpApiApp.webHandlerFor(countingRoutes)
        try {
          const inProcessResponse = yield* Effect.promise(() =>
            Promise.resolve(
              handler.handler(
                new Request("http://localhost/path", {
                  headers: { "x-opencode-directory": dir },
                }),
                undefined as never,
              ),
            ),
          )
          const body = yield* Effect.promise(() => Promise.resolve(inProcessResponse.text()))
          // eslint-disable-next-line no-console
          console.log("DEBUG webHandler body =", body.slice(0, 200))
          // eslint-disable-next-line no-console
          console.log("DEBUG webHandler status =", inProcessResponse.status, "calls so far =", bootstrapCalls)
          expect(inProcessResponse.status).toBeLessThan(500)

          // Pipeline A: real TCP listener (uses `Layer.makeMemoMapUnsafe()`).
          const listener = yield* Effect.promise(() =>
            Server.listenWithRoutes({ hostname: "127.0.0.1", port: 0 }, countingRoutes),
          )
          try {
            const listenerResponse = yield* Effect.promise(() =>
              fetch(new URL("/path", listener.url), {
                headers: { "x-opencode-directory": dir },
              }),
            )
            const listenerBody = yield* Effect.promise(() => listenerResponse.text())
            // eslint-disable-next-line no-console
            console.log("DEBUG listener status =", listenerResponse.status, "body =", listenerBody.slice(0, 200), "calls so far =", bootstrapCalls)
            expect(listenerResponse.status).toBeLessThan(500)
          } finally {
            yield* Effect.promise(() => listener.stop(true)).pipe(Effect.ignore)
          }
        } finally {
          yield* Effect.promise(() => handler.dispose()).pipe(Effect.ignore)
        }

        // After the fix at server.ts:129 (use shared memoMap), the listener and
        // webHandler resolve to the SAME `InstanceStore.Service`, so the second
        // `load(dir)` hits the in-memory cache and skips `boot` → `bootstrap.run`
        // runs exactly once.
        //
        // Before the fix, the listener uses `Layer.makeMemoMapUnsafe()` (fresh
        // memoMap), giving it its own `InstanceStore.Service` with its own
        // cache. Both pipelines call `boot` for the same dir → `bootstrap.run`
        // runs TWICE.
        // eslint-disable-next-line no-console
        console.log("DEBUG bootstrapCalls =", bootstrapCalls, "listenerStatus =", "(see above)")
        expect(bootstrapCalls).toBe(1)
      }),
    10_000,
  )
})
