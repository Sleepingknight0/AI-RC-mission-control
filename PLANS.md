# Execution Plans

Use a living execution plan for any milestone that changes more than one process, package, database schema, or protocol family.

The active plan is `docs/EXECUTION-PLAN.md`.

## Required sections

- Purpose and observable outcome
- Scope and explicit non-goals
- Current repository state
- Implementation sequence
- Protocol/schema changes
- Tests and fault scenarios
- Progress checklist
- Surprises and measurements
- Decision log
- Final outcome and remaining risks

## Rules

- Keep the plan updated while working; do not write it once and ignore it.
- Each step must be independently verifiable.
- Prefer a running vertical slice over broad unfinished scaffolding.
- Record deviations from the specification and the evidence that justified them.
- Never mark a step complete without a command, test, trace, or visible behavior that proves it.
