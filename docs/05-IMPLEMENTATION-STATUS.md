# Implementation Status

Codex must execute the first incomplete milestone unless the operator explicitly selects another prompt.

## Milestones

- [x] M0.1 Toolchain checked on target Windows
- [x] M0.2 Codex empirical spike completed at least three times
- [x] M0.3 Measurements and compatibility notes recorded
- [x] M1.1 pnpm strict-TypeScript monorepo scaffolded
- [x] M1.2 Core and Connector run as separate processes
- [x] M1.3 Mock normalized WebSocket flow demonstrated
- [x] M2.1 Installed Codex schema compatibility gate implemented
- [x] M2.2 Real browser-to-Codex first-token path demonstrated
- [x] M2.3 interrupt, active-Turn rejection, and provider-loss semantics tested
- [x] M3.1 Core SQLite WAL and Connector journal implemented
- [x] M3.2 command idempotency and event replay implemented
- [x] M3.3 browser refresh during active Turn tested
- [x] M4.1 command output and file-change normalization implemented
- [x] M4.2 approval compare-and-set implemented and race-tested
- [x] M4.3 artifact-backed large diff flow implemented
- [x] M5.1 Codex mission-control frontend implemented
- [x] M5.2 Codex responsive, accessibility, and UX pass completed
- [x] M6.1 Codex correctness/recovery self-audit completed
- [x] M6.2 Codex security/boundary self-audit completed
- [x] M7.1 Codex resolved accepted self-audit findings with regression tests
- [x] M7.2 clean-checkout prototype demo and final gate completed

## M8 — Daily-Use Operationalization

- [x] M8.1 same-origin production Web host implemented and smoke-tested
- [x] M8.2 bounded runtime browser authentication implemented
- [x] M8.3 typed persistent LocalAppData configuration implemented
- [x] M8.4 compiled production lifecycle and Windows startup task implemented
- [x] M8.6 backup, restore, migration, and clean-install gate completed

## Deferred operational work

- M8.5 private Tailscale Serve second-device acceptance — **deferred by the
  operator on 2026-08-03; not completed**
- Planned remote-access redesign — Google identity plus Cloudflare; the choice
  between Cloudflare Access with Google as IdP and application-owned Google
  OAuth behind Cloudflare Tunnel remains unresolved and unimplemented

## Optional post-Prototype phases

- P1 Grok visual hierarchy and UX refinement
- P2 Claude independent correctness/security audit
- P3 Codex triage of reproducible external feedback

## M9 — Remote AI Workspace (non-visual backend)

- [x] M9.0 architecture, integration contracts, and exact-head baseline
- [x] M9.1 provider capability Domain/protocol model
- [x] M9.2 provider inventory relay and authoritative Core snapshot
- [x] M9.3 Session Catalog V2 backend and migration
- [x] M9.4 Codex native discovery, create, resume, and capabilities
- [x] M9.5 revision-fenced Session settings and effective Turn snapshots
- [x] M9.6 normalized execution-mode semantics
- [x] M9.7 approval policies and scoped Full Auto leases
- [ ] M9.8 managed attachment lifecycle and security
- [ ] M9.9 normalized terminal/activity metadata
- [ ] M9.10 security, recovery, fault, and performance gate
- [ ] M9.11 non-visual final gate and Grok integration handoff

## Current milestone

**M9.8 managed attachment lifecycle and security.** M9.7 adds Core schema 9,
server-side review/balanced/workspace-auto classification, exact bounded Full
Auto leases, device/settings/Runtime fences, durable policy audit, automatic
expiry/revocation, and emergency interrupt. Codex always remains request-capable
and receives a canonical read-only or workspace sandbox with network disabled.
The Grok visual checkpoint remains isolated and frozen. M8.5 and
Google/Cloudflare identity remain deferred outside M9.

## Last verified demo

- Toolchain: `.\scripts\Check-Toolchain.ps1` — required tools OK (Git 2.54.0, Node v24.16.0, Codex 0.146.0).
- Mock spike harness: `pnpm run spike:mock` — pass after Windows spawn quoting fix.
- Real spikes: `.\scripts\Run-CodexSpike.ps1 -Runs 3` — batch `spikes/codex-app-server/artifacts/real-20260801-091022/` (3/3 exit 0).
- Measurements: `docs/measurements/CODEX-SPIKE-RESULTS.md`.
- Compatibility gate: installed Codex 0.146.0 accepted with canonical schema SHA-256 `b767c1161c2c56341f3d0e313b4f93810b4b53bdaabeff95c06e1242cfc4df03`; 275 generated schema files are adapter-internal.
- Database schema: Core schema version 8 and Connector schema version 3; every migration ledger row has a SHA-256 checksum and `pnpm migrate` is idempotent. Core retains durable display order, transition guards, terminal work reconciliation, separate Session/catalog/settings revisions, fenced provider-Session bindings, and immutable effective Turn settings; Connector retains strict FIFO journal sequence.
- Repository checks: `pnpm check` — strict typecheck, 66 tests, ESLint, Windows process-tree test, and Web production build passed; the opt-in real test remained skipped.
- Real Codex E2E: opt-in test passed in 66.70 s, covering first delta/final, `TURN_ALREADY_ACTIVE`, interrupt, provider kill → `outcome_unknown`, lost-Runtime rejection, new-process resume, no command replay, and deterministic provider teardown.
- Recovery tests: durable command race/deduplication, replay sequence, runtime-generation fencing, Connector restart, Core restart, and commit-before-broadcast failure all passed.
- M4 race/fault tests: exactly one of two tabs wins approval CAS; duplicate command IDs replay; expiry/provider loss/runtime restart reject stale decisions; interrupt, UTF-8 batching, inline/large diff thresholds, artifact integrity/auth/range/traversal all pass.
- Mobile approval demo: Playwright at 390×844 used real Codex command approvals. Approve-once created only `output/playwright/provider-approval-proof.txt`; decline produced activity state `declined` and did not create its target file.
- M5.1 browser demo: real Session catalog, selectable desktop/mobile sessions, normalized timeline, activity and diff review, recovery truth, keyboard submission, local draft recovery, and approval actions all rendered from protocol state. Mock desktop/mobile and real Codex approve/decline paths completed with zero console warnings or errors.
- M5.2 UX gate: Playwright verified 375/768/1024/1440 layouts with zero page overflow or sub-44px enabled controls, keyboard skip/focus order, mobile drawer Escape/focus restoration, WCAG-AA token contrast, reduced motion, and 200% text. A real Codex approval remained operable at 200% text; decline created no target file. Timeline construction/windowing tests cover 100,000 items.
- M6.1 audit: `reviews/codex/M6.1-CORRECTNESS-RECOVERY-AUDIT.md` records 12 evidence-backed findings (6 High, 5 Medium, 1 Low), three read-only fault probes, verified controls, and one falsified race hypothesis. No remediation was mixed into the review milestone.
- M6.2 audit: `reviews/codex/M6.2-SECURITY-BOUNDARY-AUDIT.md` preserves 6 Standards and 6 Spec findings (8 distinct remediation themes). In-memory probes reproduced hostile-Origin browser control, Connector impersonation with prompt interception, artifact allocation gaps, missing rate throttling, and raw secret leakage. No remediation was mixed into the review milestone.
- M7.1 remediation: `reviews/codex/M7.1-REMEDIATION-REGISTER.md` maps all 17 accepted security/recovery themes to implemented controls and regression evidence. Per-launch WebSocket capabilities, canonical project roots, payload/allocation/rate limits, redaction, FIFO receipts, startup ownership expiry, passive approval expiry, durable command outcomes, timeline sequencing, and SQLite transition guards are verified.
- M7.2 final gate: `reviews/codex/M7.2-FINAL-GATE.md` records the canonical-path clean checkout, frozen install, compatibility/migration/full-check gates, opt-in real-provider lifecycle, and Playwright browser acceptance. Codex 0.146 terminal items are reconciled when a dedicated completion notification is absent; plain add/delete file bodies are normalized into reviewable unified diffs.
- M8.1 same-origin host: Core serves the Vite production build, hashed assets, and HTML-navigation SPA fallback while reserving `/health`, `/ws`, `/connector`, and `/artifacts/*`. Web derives `ws:`/`wss:` from `window.location` unless development explicitly sets `VITE_CORE_WS_URL`. Targeted production-host/security tests, a real built-dist process smoke, and `pnpm check` passed with 70 automated tests; the opt-in real-provider test remained skipped.
- M8.2 runtime browser auth: `POST /runtime-config` issues a 30-second, exact-Origin, one-time WebSocket ticket from a bounded in-memory registry that stores only ticket digests. Production Core disables the legacy browser token; Connector authentication remains separate. Expiry, replay, hostile-Origin, request-body, capacity, and Core-restart tests pass. Playwright loaded and reloaded the same-origin production build with two fresh bootstrap requests, an online UI, zero console errors/warnings, and no localStorage secret. `pnpm check` passed 77 automated tests; the opt-in real-provider test remained skipped.
- M8.3 persistent config: Core and Connector share strict schema version 1 under `%LOCALAPPDATA%\AICL Mission Control\config.json`, created atomically without credentials or capabilities. It supplies loopback Core/Connector settings, exact browser origins, provider profile/CODEX_HOME, canonical project allowlist/default project, and separate data/log/backup paths; validated environment overrides remain in memory and the active same-origin URL is derived after them. Junction escape, invalid/unknown/versioned input, port/database separation, repeated/concurrent startup, bracketed IPv6 loopback, and configured child-environment tests pass. A two-process mock smoke proved concurrent config creation, Core/Connector connection, same-origin Web/runtime bootstrap, two SQLite files, non-persistence of overrides/capabilities, and cleanup. `pnpm check` passed 92 automated tests; the opt-in real-provider test remained skipped.
- M8.4 production lifecycle: `pnpm build` creates self-contained Core, Connector, Host, and Doctor JavaScript bundles plus the Web build without runtime TypeScript or source maps. A Host supervisor starts Core before Connector, keeps the Connector capability out of state/logs, provides bounded redacted JSON logs, and shuts down Connector/provider then Core through IPC with verified process-tree fallback. Root start/stop/status/doctor commands and an interactive-user limited-privilege Scheduled Task are present; backup/restore commands deliberately fail closed until M8.6. An isolated Windows production smoke passed start, both health gates, same-origin HTML, status, clean stop, PID cleanup, and state cleanup. `pnpm check` passed 96 automated tests plus the compiled lifecycle smoke; the opt-in real-provider test remained skipped.
- M8.5 deployment readiness (deferred, not completed): `pnpm remote:configure` derives an online device's exact HTTPS ts.net Origin, verifies a private `tailscale serve --bg --yes http://127.0.0.1:<core-port>` mapping, and persists the Origin only while AICL is stopped; no Funnel path exists. Doctor and `pnpm remote:status` distinguish app, Connector, Tailscale, Serve, Origin, Codex, and database state. Doctor also discovers the standard Windows Program Files install when the CLI is absent from PATH. A real collision exposed that production could briefly borrow health from an existing dev service; the Host now rejects occupied Core/Connector ports before spawning children. After confirming no active Turn, seven stale AICL dev launcher roots and their descendants were stopped. Compiled production then remained ready with stable supervisor/Core/Connector PIDs through 3/15/30-second checkpoints. Certificate issuance recovered: `/health` succeeds through the ts.net HTTPS endpoint, and a Playwright preflight on the host loaded production HTML, obtained a runtime ticket, opened authenticated WSS, reported Core/Connector ready, emitted no console warnings/errors, and stored no localStorage secret. `pnpm check` passed 102 automated tests plus compiled lifecycle and fake-CLI Serve smokes. No real second-device evidence was captured before the operator deferred this gate.
- M8.6 maintenance/final gate: Node's SQLite backup API creates coherent Core/Connector snapshots without copying live WAL files. Each managed set includes a strict manifest, config snapshot, SHA-256/size, schema and SQLite source metadata, full integrity/foreign-key/domain checks, bounded retention, and an explicit at-rest policy. Restore requires stopped services, verifies before staging, atomically switches databases, and preserves replaced files for recovery; config is intentionally not auto-restored. Production startup migrates before children, existing upgrades create a verified pre-migration backup, and migration checksums reject drift. `pnpm check` passed 107 automated tests plus lifecycle, online backup/restore/restart/corruption, clean-directory compiled install, and fake-CLI Serve gates. The real LocalAppData databases upgraded from Core 4 / Connector 2 to 5 / 3 after pre-backup, a repeated migration made no change, a manual backup verified, and compiled Codex production returned ready. Evidence: `reviews/codex/M8-FINAL-GATE.md`.
- M9.2 provider inventory: the Connector reads the bounded terminal registry,
  probes installation/authentication without reading credential content,
  sanitizes untrusted labels, and publishes operational snapshots outside the
  durable Session journal. Core validates current Connector/boot/Runtime
  ownership, rejects non-monotonic same-boot revisions, bootstraps browsers,
  and marks retained inventory stale on loss. Connector/Core targeted tests and
  the full `pnpm check` gate passed; the ordinary full suite skipped the opt-in
  real-provider test, which had already passed on the M9.0 exact-head baseline.
- M9.3 Session Catalog V2: Core migration 006 adds separate catalog metadata,
  settings, read cursors, audit rows, and catalog revision triggers. Literal
  search, provider/account/state/project/pin/archive filters, deterministic
  100-default/250-hard-cap cursor pagination, stale-cursor rejection, metadata
  CAS/idempotency, active-Turn archive rejection, human first-prompt titles,
  and per-device unread counts are tested. The real configured database was
  backed up and upgraded Core 5→6; a repeat migration was a no-op. `pnpm check`
  passed 133 automated tests plus all compiled lifecycle/maintenance gates; the
  opt-in real-provider test remained skipped in this gate.
- M9.4 Codex Session discovery/control: verified `account/read`, `model/list`,
  bounded active/archived `thread/list`, `thread/start`, and `thread/resume`
  adapters publish only sanitized capability/native-Session data. Migration 007
  adds fenced provider bindings. Core validates live provider/account/model/
  reasoning evidence before a durable two-phase create or resume, rejects
  duplicate native bindings, and settles uncertain provider preparation to
  `outcome_unknown` without replay. Concurrent Connector shutdown is
  idempotent and ignores late Core messages. The full gate passed 143 automated
  tests plus compiled lifecycle/maintenance gates; the opt-in real-provider
  test remained skipped in this gate.
- M9.5 Session settings: migration 008 adds audited Session-settings CAS and
  immutable per-Turn settings JSON/revision. Stale tabs receive a stable
  conflict plus the authoritative snapshot; semantic changes are blocked while
  a Turn runs. Provider/account/project remain binding-owned and immutable.
  Core validates current provider/account/model/reasoning evidence, and Codex
  validates again before forwarding the model, effort, and canonical cwd.
  Legacy Turn submissions remain compatible while new submissions may fence
  the settings revision. `pnpm check` passed 150 automated tests plus compiled
  lifecycle/maintenance gates; one opt-in real-provider test remained skipped.
  Frozen Web source remains unchanged.
- M9.6 execution modes: provider capabilities now explicitly report
  `execution_modes`. Codex advertises support only after authenticated adapter
  probing. Ask is interactive, plan is plan-first, and auto permits multiple
  bounded steps inside the already accepted Turn. Adapter tests prove plan
  translation and that auto still raises the normalized approval request.
