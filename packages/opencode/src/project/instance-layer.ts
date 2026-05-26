import { InstanceStore } from "./instance-store"

// `InstanceStore.layer` requires `InstanceBootstrap.Service`. Production
// callers provide `InstanceBootstrap.defaultLayer` alongside this layer
// (see `routes/instance/httpapi/server.ts:createRoutes`, `worktree/index.ts`,
// `effect/app-runtime.ts`). Keeping the bootstrap external rather than
// baking it in here lets tests override `InstanceBootstrap` with a stub
// (e.g. a counting bootstrap for regression tests) without rebuilding the
// full layer graph.
export const layer = InstanceStore.layer

export * as InstanceLayer from "./instance-layer"
