# M9 Authoritative Baseline

Date: 2026-08-03 (Asia/Bangkok)

## Repository isolation

- Main branch: `master`
- Main HEAD: `4ebd88d77a25e26245862259af5414e0a56c0bd4`
- Main worktree: clean before and after verification
- Grok worktree: `C:\Projects\AI-RC-mission-control-grok`
- Grok branch/commit: `grok/spacex-ui` / `c2f1d4813e80bf7d401424572c1fb890aa7a5e2b`
- Grok commit contains only `apps/web/index.html`, `apps/web/src/App.tsx`, and `apps/web/src/styles.css`; it was not merged or modified.
- `stash@{0}: pre-m9 visual experiment (preserved by Codex)` remains untouched. It is not the selected visual baseline.
- Frozen Web files remained byte/time stable for 15 seconds and no repository-writing process targeted main.

## Commands and results

```text
pnpm install --frozen-lockfile  PASS (lockfile unchanged)
pnpm migrate                    PASS, Core 5 / Connector 3, migrated=false
pnpm migrate                    PASS, Core 5 / Connector 3, migrated=false
pnpm build                      PASS, production bundles and Web build
pnpm check                      PASS in 87 s
git diff --check                PASS
```

`pnpm check` passed strict TypeScript, ESLint, production builds, 107 automated tests, compiled lifecycle, M8 maintenance/restore/corruption, clean-directory production, and fake-CLI Tailscale automation. Its opt-in real-provider test was skipped by design (1 skipped), not counted as passed.

Exact-head Real Codex E2E was then run explicitly:

```text
AICL_REAL_CODEX=1 pnpm --filter @aicl/core exec vitest run \
  test/real-codex.e2e.test.ts --reporter verbose
PASS: 1/1, test 70.39 s, total 71.15 s
```

It proved streaming, active-Turn rejection, interrupt, provider death classification, lost-Runtime fencing, new-process resume, and no prompt replay on the M8.6 HEAD.

## Production status and exclusions

The lifecycle gate started and stopped isolated compiled instances successfully; production was left stopped after the baseline. No external test was blocked. Remote second-device M8.5, Google identity, and Cloudflare remain deferred outside M9. No frontend visual acceptance was rerun in main because the frozen Grok checkpoint has its separate evidence.
