# Codex Task — Real Browser-to-Codex First-Token Vertical Slice

Complete milestones **M2.1–M2.3**. Deliver the first real end-to-end Codex path on the target Windows host.

## Goal

From the browser, start or resume a Codex-backed Session, submit one prompt, observe the first normalized assistant delta, stream the final message, and exercise interrupt and provider-loss behavior.

## Prerequisites

- M0 measurement report is complete.
- M1 mock walking skeleton passes.
- The installed Codex binary is authenticated.

## Source of truth

Generate and inspect app-server schemas from the installed Codex binary. Do not copy method names from old prose without verifying them. Store generated code under an adapter-internal generated directory and record:

- Codex version
- schema fingerprint
- supported compatibility range or exact known version
- compatibility-gate result

The web application must not import generated Codex types.

## Required implementation

1. Implement a Codex adapter inside Connector using app-server stdio.
2. Add initialization, process supervision, bounded line parsing, request correlation, timeout handling, stderr capture, and graceful/forced termination.
3. Normalize only the event subset needed for:
   - session/thread identity
   - Turn start
   - assistant message delta and completed message
   - Turn terminal state
   - structured provider/protocol error
4. Persist or project enough provider identity to resume the Session in a new process, but do not claim active-process reattachment.
5. Enforce one executing Turn per Session.
6. Implement interrupt through the verified installed schema.
7. If Connector or provider process dies during unresolved active work:
   - mark the runtime lost
   - mark the Turn `outcome_unknown` unless history proves a terminal result
   - never resend the prompt automatically
8. Add a compatibility error that prevents startup when the installed schema/version is unrecognized.

## Required demo

Demonstrate all of the following with real Codex:

1. Browser submits a prompt.
2. UI receives a normalized first delta and final assistant message.
3. A second prompt while the Turn is active receives `TURN_ALREADY_ACTIVE`.
4. Interrupt transitions to a verified terminal state or a clearly classified uncertainty.
5. Killing the provider process during a Turn never reports false success and never auto-replays.
6. Starting a new provider process can resume the provider Session where supported, without reattaching the old runtime.

## Tests

Add tests for:

- generated-schema compatibility gate
- line framing and malformed payload handling
- provider request correlation
- normalized-event mapping
- no raw provider-event leakage
- duplicate client `commandId`
- active-Turn rejection
- provider death → lost runtime / `outcome_unknown`
- process-tree termination behavior on Windows, with an explicit platform test or documented target-host evidence

Do not implement SQLite durability, approvals, command output, or full diff review beyond what is essential for this first-token path.
