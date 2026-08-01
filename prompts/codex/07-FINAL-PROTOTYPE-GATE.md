# Codex Task — Final Prototype 0 Gate

Complete milestones **M7.1–M7.2**. This is a verification, stabilization, and documentation task, not a feature-expansion task.

## Goal

Prove that a clean checkout on the target Windows host can run the first AICL Mission Control prototype end to end with repeatable setup and explicit failure semantics.

## Required clean-checkout flow

From a clean working tree or disposable clone:

1. run the toolchain check
2. install dependencies using the documented command
3. initialize/migrate Core and Connector databases
4. generate or verify the installed Codex schema compatibility gate
5. start Web, Core, and Connector
6. open the browser UI
7. create/open a Session with an allowed project root and configured account profile
8. submit a real Codex prompt
9. observe first delta, final message, command output, and diff/approval when exercised
10. refresh/reconnect without losing durable state
11. reject a duplicate command without redispatch
12. interrupt a Turn
13. kill the provider during a controlled fixture Turn and verify lost runtime plus `outcome_unknown` where terminal outcome cannot be proven
14. restart services and resume through a new provider process without claiming reattach

## Full checks

Run all repository-supported:

- formatting/linting
- type checking
- unit tests
- database contract and migration tests
- integration tests
- frontend accessibility tests
- protocol compatibility checks
- failure/fault-injection tests that are safe on the fixture project
- production builds

Record exact commands, versions, durations, failures, reruns, and final results. Do not erase evidence of a failed first attempt; document the fix.

## Documentation gate

Ensure these are accurate:

- `README.md`
- `START-HERE.md`
- `.env.example`
- `docs/04-ACCEPTANCE-TESTS.md`
- `docs/05-IMPLEMENTATION-STATUS.md`
- `docs/06-HANDOFF-LOG.md`
- `docs/EXECUTION-PLAN.md`
- operator recovery steps
- known limitations

## Release boundary

Prototype 0 must not claim:

- exactly-once provider execution across crashes
- provider-process reattachment on Windows stdio
- certainty after ambiguous side effects
- multi-user or public-internet security
- Claude/Grok provider control unless separately implemented and tested
- production notification delivery

Finish with a go/no-go assessment and a list of only the smallest next-phase risks. Do not start Phase 1 features.
