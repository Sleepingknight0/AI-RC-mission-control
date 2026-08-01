# Codex Task — Run and Analyze the Windows App-Server Spike

You are the primary AICL implementation owner. Complete only milestone group **M0.1–M0.3** as far as the target Windows machine permits.

## Goal

Measure the installed Codex app-server rather than relying on assumed protocol behavior. Produce evidence that informs batching, payload limits, process-loss semantics, and adapter compatibility.

## Read first

- `AGENTS.md`
- `docs/00-PROTOTYPE-0-SCOPE.md`
- `docs/01-ARCHITECTURE-DECISIONS.md`
- `docs/04-ACCEPTANCE-TESTS.md`
- `docs/05-IMPLEMENTATION-STATUS.md`
- `spikes/codex-app-server/README.md`
- `docs/measurements/CODEX-SPIKE-RESULTS.md`

## Required work

1. Run `scripts/Check-Toolchain.ps1` and record exact versions of Windows, Node.js, Git, Codex CLI, and the generated schema fingerprint.
2. Run the real spike at least three times against `spikes/fixture-project` unless a project path was explicitly supplied by the operator.
3. Do not use the mock runner as evidence of real provider behavior. The mock is only a harness check.
4. Preserve raw artifacts locally. Do not paste secrets or full sensitive traces into documentation.
5. Aggregate at least:
   - request-to-first-delta latency
   - delta count and delta rate
   - peak 100 ms and one-second burst rate
   - payload p50, p95, and max
   - inter-arrival p50, p95, and max
   - methods/events observed
   - behavior when the app-server process tree is terminated during an active Turn
   - what `thread/read` and `thread/resume` reveal after restart
   - whether any active work can be proven complete, failed, or only unknown
6. Inspect generated schemas from the installed binary. Record observed method/type names without leaking generated provider types into the frontend contract.
7. Fill in `docs/measurements/CODEX-SPIKE-RESULTS.md` with exact evidence, environment, run IDs, and limitations.
8. Update status and handoff files. Mark milestones complete only when evidence exists.

## Safety and correctness

- Use the fixture project by default; do not run destructive prompts against a valuable repository.
- Do not auto-resubmit the killed prompt.
- Unexpected approvals must be declined by the spike unless the operator explicitly configured a safe test.
- Treat provider death during an unresolved Turn as `outcome_unknown` unless the persisted provider history proves a terminal outcome.
- Do not start product infrastructure in this task.

## Expected output

The repository should contain a completed measurement report and links/paths to the local artifact directories. Report any inability to run the real binary as a blocker with the failing command and stderr.
