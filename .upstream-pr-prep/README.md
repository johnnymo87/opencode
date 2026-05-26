# Upstream PR prep — ephemeral

This directory holds the draft issue + PR description for the upstream submission of the InstanceState partition fix (`anomalyco/opencode`).

**This directory is ephemeral and will be removed before the upstream PR is actually opened** (Task 11 of the implementation plan).

## Files

- [`ISSUE.md`](./ISSUE.md) — draft issue body. File the issue first, then reference its number from the PR body.
- [`PR.md`](./PR.md) — draft PR body. Two commits land in the actual PR: the refactor (`refactor(project): make InstanceBootstrap injectable into InstanceLayer.layer`) and the fix (`fix(server): share memoMap between TCP listener and in-process webHandler`). They sit directly on top of `anomalyco/opencode dev` on this branch.

## Branch layout on the fork (`johnnymo87/opencode`)

- **`wip/instance-state-partition`** — what you're looking at. Three commits on `dev`: refactor → fix → this prep commit. Task 11 will drop this prep commit, then push the remaining two commits as the upstream PR.
- **`archive/instance-state-partition-exploration`** — preserves the failed regression-test attempt + its revert + the v1.15.10-based history. Useful if anyone asks "did you consider an automated regression test?" — the rabbit hole is fully recoverable from this branch.

## Why these docs live on the fork

To keep all the artifacts in one place during the burn-in window. They do NOT ship as part of the actual PR — Task 11 will remove this directory before pushing the upstream-bound branch.

## Companion docs (in the pigeon repo)

The complete investigation lives in pigeon:
- `docs/plans/2026-05-26-instancestate-partition-fix-design.md` — design + diagnostic finding + Tier 1 result
- `docs/plans/2026-05-26-instancestate-partition-fix-plan.md` — implementation plan (Tasks 1–11)
- `docs/plans/2026-05-22-bus-fix-investigation-HANDOFF.md` — full investigation history
