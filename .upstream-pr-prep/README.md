# Upstream PR prep — ephemeral

This directory holds the draft issue + PR description for the upstream submission of the InstanceState partition fix (`anomalyco/opencode`).

**This directory is ephemeral and will be removed before the upstream PR is actually opened** (Task 11 of the implementation plan).

## Files

- [`ISSUE.md`](./ISSUE.md) — draft issue body. File the issue first, then reference its number from the PR body.
- [`PR.md`](./PR.md) — draft PR body. Two commits: `d338e3af7` (refactor) + the actual fix commit on `wip/instance-state-partition`. PR cherry-picks them onto a clean branch off `v1.15.10`.

## Why these live on the fork

These docs are committed to the `wip/instance-state-partition` branch on the personal fork (`johnnymo87/opencode`) to keep all the artifacts in one place during the burn-in window. They do NOT ship as part of the actual PR — Task 11 will remove this directory in a commit before pushing the upstream-bound branch.

## Companion docs (in the pigeon repo)

The complete investigation lives in pigeon:
- `docs/plans/2026-05-26-instancestate-partition-fix-design.md` — design + diagnostic finding + Tier 1 result
- `docs/plans/2026-05-26-instancestate-partition-fix-plan.md` — implementation plan (Tasks 1–11)
- `docs/plans/2026-05-22-bus-fix-investigation-HANDOFF.md` — full investigation history
