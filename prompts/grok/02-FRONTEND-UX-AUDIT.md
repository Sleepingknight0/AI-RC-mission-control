# Grok Task — Read-Only Frontend UX Audit

Perform a frontend-only audit of the current AICL Mission Control prototype. Do not modify source code unless the operator explicitly changes this task.

## Inspect

- `apps/web/**`
- `packages/ui-kit/**` when present
- frontend protocol fixtures
- `docs/03-FRONTEND-MISSION-CONTROL-BRIEF.md`
- relevant acceptance tests

## Evaluate

- one-second readability of Session state
- information density without visual noise
- streaming timeline stability and scroll anchoring
- approval visibility without interrupting reading
- diff-review clarity
- mobile approval/interrupt usability
- keyboard and screen-reader basics
- offline/reconnect/lost/unknown-state clarity
- loading, empty, error, and large-output states
- visual consistency and unnecessary animation
- whether UI invents or leaks provider-specific concepts

## Report

Write or return findings sorted by severity:

```text
P0 blocks safe operation
P1 causes likely operator error or inaccessible critical action
P2 meaningful usability or maintainability issue
P3 polish
```

Each finding must include location, evidence, concrete user impact, and a narrow remediation. Distinguish observed defects from subjective preferences. Save the report to `reviews/grok/frontend-ux-audit.md` when tool permissions allow.
