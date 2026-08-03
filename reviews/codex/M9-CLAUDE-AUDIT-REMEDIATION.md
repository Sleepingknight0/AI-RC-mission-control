# M9 Claude Audit Remediation

Date: 2026-08-03

Audited baseline: `b6cd01576ed0f817cc07ea7735dfc1ce86305c9d`

Evidence reviewed: both isolated Claude reports and their read-only probes at
audit-only commits `fae8648`, `edc1a24`, and `d32eaed`. None of those commits
was merged or cherry-picked. Codex reproduced accepted findings through public
Core/Connector/protocol seams before implementing the fixes.

## Verdict

**PASS, with one bounded Medium operational deferral.** Every frontend blocker
and accepted High/security finding is remediated. The remaining retention-policy
finding is deferred because deleting authoritative commands, events, approval
audits, or evidence without an accepted retention/export policy would weaken
replay and incident evidence. It does not grant authority or block Grok
integration; its remaining risk is unbounded long-term database growth.

Implementation commits:

- `7cc955a` — fail closed on unverified Codex account, probe, native-Session,
  sandbox, network, and approval-scope authority.
- `02af515` — Core schema 12, strict Session authority, catalog revision,
  authoritative capability projection, resume/journal recovery, realistic
  performance, and protocol-violation regressions.
- `1d888b1` — reuse a thread prepared by the current Codex app-server process
  instead of issuing a redundant `thread/resume` that the installed provider
  rejects before a rollout exists.
- `0b70ba7` — align the unchanged Real Codex gate and production schema checks
  with authoritative registry discovery, explicit Session creation, and fresh
  post-restart capability evidence.

## Finding register

| Finding | Decision | Reproduction and remediation | Regression evidence | Remaining risk / Grok |
|---|---|---|---|---|
| C-M9-01 unsafe sandbox default | Accepted, High | Migration 006/default and null-project translation reproduced write-capable defaults. Schema 12 rebuilds settings with `read_only`/`denied`, fails legacy/unbound/ambiguous/null-project rows closed, and permits retention of an explicit write posture only for a ready binding with an explicit project. Connector maps null-project workspace write to provider read-only. (`7cc955a`, `02af515`) | `database-contract`: schema-12 fresh/idempotent and legacy upgrade; `codex-adapter`: null-project workspace write | None known; unblocks Grok. |
| C-M9-02 `turn.submit` creation bypass | Accepted, High | Unknown Session submission and optimistic catalog authority reproduced. Submit/subscribe no longer create rows; first Turn requires an existing ready binding and fresh exact provider/account/project/model/capability authority. Catalog control also requires `ready`. (`02af515`) | `session-lifecycle`: unknown Session, invalid provider/account/model, inventory-only provider, validated first Turn; migrated WebSocket fixtures create explicitly | None known; unblocks Grok. |
| C-M9-03 concurrent native resume | Accepted, High | Two simultaneous imports could both pass the precheck. Settlement now rechecks uniqueness inside the serialized transaction and deterministically fails the loser with `PROVIDER_SESSION_ALREADY_IMPORTED`. (`02af515`) | `session-lifecycle`: concurrent import collision leaves one ready and one failed command | Provider-side work may already have occurred, but no duplicate Core writer or replay occurs; unblocks Grok. |
| C-M9-04 unvalidated sends / journal stranding | Accepted, High | Core sends lacked the boundary validator and permanently invalid artifact/activity events could throw before acknowledgement. Every Core-to-Connector command now parses through the strict schema; authenticated but invalid durable events are consumed and safely dropped, including artifact cleanup, so a poison journal row cannot retry forever. (`02af515`) | `security-boundaries`: malformed outbound command rejected; `database-contract`: invalid runtime/artifact input returns a terminal drop and duplicate receipt is consumed | Dropped invalid provider evidence is intentionally absent from the timeline; bounded Core logging remains the diagnostic path. Unblocks Grok. |
| C-M9-05 catalog cursor invalidation | Accepted, High | A durable activity between pages reproduced a stale cursor. Event sequence no longer mutates `sessions.updated_at`; schema-12 triggers advance catalog ordering only for Turn/approval/catalog-visible changes. (`02af515`) | `session-catalog`: active Turn and ordinary concurrent event preserve page two; rename still rejects the stale cursor | None known; unblocks Grok. |
| C-M9-06 unrealistic scale fixture | Accepted, Medium | The prior 1,000 empty-row/20-second case did not exercise correlated history. The fixture now includes 100 Turns and 10 pending approvals, adds indexed Turn/approval lookups, isolates query timing, and enforces a 2-second query budget. (`02af515`) | `session-catalog`: realistic 1,000-Session catalog and history projection | Sustained soak remains operational work, not a deterministic unit test; unblocks Grok. |
| C-M9-07 duplicate native writers | Accepted, High | Active Codex native threads were advertised resumable. Active rows now fail closed; only idle/not-loaded rows may resume, while Core's binding uniqueness and concurrent settlement remain authoritative. A Real Codex reproduction also showed that redundantly resuming a thread prepared by the same live app-server fails with `no rollout found`; the adapter now records process-local prepared threads and reuses them without a second resume RPC, clearing that set on process loss. (`7cc955a`, `02af515`, `1d888b1`) | `codex-discovery`: active native Session is not offered; concurrent Core import test; `codex-adapter`: a fake provider rejects redundant resume and the prepared thread still executes exactly once | A provider that misreports active state can still reject a new-process resume, which settles without replay; unblocks Grok. |
| C-M9-08 durable retention | Deferred, Medium | Confirmed no general retention for commands/events/artifacts/approval audits. No deletion was added because the product has not accepted retention duration, export, replay-floor, legal-hold, or audit-preservation semantics. | Existing attachment expiry and Host log/backup retention remain tested; this report records the explicit gap | Long-lived databases can grow. Define policy plus backup/export/replay invariants in the next operational milestone. Does not block Grok. |
| Network-policy mismatch | Accepted, security | Migration now defaults/upgrades network to `denied`; Codex reports `network_policies` unsupported and always sends network disabled. Restricted selection fails without verified evidence. (`7cc955a`, `02af515`) | schema-12 migration/default tests; adapter capability and settings validation tests | No Codex restricted-network control is advertised; unblocks Grok. |
| Approval cwd validation | Partly rejected, hardening accepted | The claimed raw-cwd gap was not reproduced: existing canonicalization already checked requested cwd against the canonical project root. Codex nevertheless stores the effective canonical project for the active Turn and reuses it at approval translation, removing duplicate interpretation. (`7cc955a`, `02af515`) | `codex-adapter`: noncanonical trailing-separator project yields the exact canonical approval cwd; junction escape policy test remains green | Windows filesystem changes after canonicalization remain subject to existing per-action checks; unblocks Grok. |
| Documentation/status inconsistencies | Accepted | Specifications now describe schema 12, strict creation, capability snapshots, cursor scope, failed-probe behavior, and measured account parsing without assigning unmeasured meaning to `requiresOpenaiAuth`. | `pnpm check`, Markdown diff review, this register | None known; unblocks Grok. |
| Violation-budget reset | Accepted, Medium | Three invalid messages separated across one-second rate windows previously avoided closure. Protocol violations now use a separate connection-lifetime budget. (`02af515`) | `security-boundaries`: spaced violations close with policy code 1008 | Reconnection starts a new authenticated connection budget by design; unblocks Grok. |
| C-M9-11 capability snapshot | Accepted, frontend blocker | The Web contract named an envelope absent from protocol. `session.capabilities.snapshot` now exposes fresh provider/account/model support, binding/control authority, execution modes, text/image input, approval policies, lease support, reasons, and freshness, and republishes on authority changes. (`02af515`) | protocol provider-capability test; `session-lifecycle`; logout/fresh-probe relay test | Older frozen Web ignores the additive envelope by design; unblocks Grok integration. |
| F-01 optional account | Accepted | Installed generated behavior permits object, null, or omission. Parsing is nullish; only a valid present account authenticates, malformed input rejects, and `requiresOpenaiAuth: true` does not negate a present account. (`7cc955a`) | `codex-discovery`: nullish/malformed matrix and present-account case | Future schema drift remains covered by the installed-schema compatibility gate; unblocks Grok. |
| F-02 stale optimistic auth | Accepted, High | A failed probe preserved old controllable inventory. Failure now downgrades provider/account/capabilities/models; Core rejects create, resume, and Turn until a fresh authoritative snapshot restores authority. (`7cc955a`, `02af515`) | `codex-discovery`: live-probe failure; `provider-inventory-relay`: logout, stale authority, create/resume/Turn rejection, fresh recovery; Connector-loss stale tests | An already accepted Turn settles under immutable settings; it is never resubmitted. Unblocks Grok. |
| F-03 negative coverage | Accepted | Added omitted/null/malformed account, unknown Session, provider/account/model, inventory-only, stale/logout, active-native, catalog-event, invalid outbound, poison-ingest, null-project, and spaced-violation cases. (`7cc955a`, `02af515`) | Named suites above | None known; unblocks Grok. |
| F-04 measurement claims | Accepted | Documentation now states only observed installed-schema shapes and AICL's parser decision. It does not claim undocumented semantics for the mode flag. | Capability-model and final-gate text review | Provider documentation may later clarify the flag; current authority remains based on validated account presence and a successful live probe. Unblocks Grok. |

## Preserved invariants

- Core and Connector remain separate processes and exchange normalized strict
  envelopes only.
- There is no PTY, unrestricted shell, raw project-file, credential, or raw
  provider-event route.
- One executing Turn per Session/Runtime, generation fencing, approval CAS,
  scoped expiring leases, managed attachment containment, and
  `outcome_unknown`/no-replay behavior remain intact.
- Non-Codex providers and unverified Codex profiles remain inventory-only.
- The frozen Web visual files, Grok worktree, and preserved stash were not
  modified.

## Final validation

The final local gate passed frozen installation, two no-op migrations, build,
strict typecheck/lint, 184 automated tests, compiled production lifecycle,
backup/restore/restart/corruption, clean-directory install, private-Serve smoke,
and `git diff --check`. Core is schema 12 and Connector is schema 3.

The unchanged Real Codex test passed with a 68.413-second test body (Vitest
69.29 seconds; command wall 73.8 seconds). It covered explicit authoritative
Session creation, first delta/final, active-Turn rejection, interrupt, provider
death to `outcome_unknown`, lost-Runtime rejection, fresh capability evidence
after restart, generation-incremented new-process resume, no prompt replay, no
raw provider-event leakage, and deterministic teardown.

The post-commit remote SHA, frozen-file comparison, clean-state checks, and
exact Grok rebase boundary are reported to the operator after the completion
commit is pushed.
