# Codex Task — SQLite Durability, Idempotency, and Browser Reconnect

Complete milestones **M3.1–M3.3** after the real first-token path works.

## Goal

Make Session history, command acceptance, runtime/Turn state, and browser replay durable without turning token streaming into a transaction-per-delta workload.

## Required architecture

### Core database

Use an authoritative local SQLite database with WAL, foreign keys, busy timeout, migrations, and a single serialized writer path. Core owns this database exclusively.

### Connector journal

Use a separate SQLite journal owned exclusively by Connector. It stores outbound durable source events and acknowledgements required for replay to Core. It is not a second authoritative copy of Core projections.

### Event classes

- **Durable events:** state transitions, command acceptance, runtime changes, Turn boundaries, completed messages, terminal errors, approvals/results when later implemented.
- **Ephemeral frames:** assistant deltas and high-rate output deltas. Coalesce and broadcast them without one row per token. Persist an authoritative completed message and optional bounded checkpoints.

Durable events must commit before broadcast. Add a clear cross-reference in code/docs so this rule is not misapplied to each token.

## Data invariants

Implement and test at least:

- distinct Session, Runtime, Turn, Command, and Event tables/read models
- monotonically increasing durable `last_event_seq` per Session
- resource revisions independent from event sequence
- one executing Turn per Session through a database constraint
- no `queued` Turn state
- stable `commandId` uniqueness with same-ID/same-payload replay and same-ID/different-payload rejection
- connector-source event deduplication through a partial unique index that applies only when source identifiers are present
- runtime generation references where stale provider events could otherwise mutate a newer runtime

## Reconnect behavior

1. Browser tracks the last durable sequence it has applied.
2. On reconnect, Core returns snapshot/replay information and all missing durable events.
3. Ephemeral text may temporarily disappear after a disconnect, but authoritative completed messages must reconstruct correctly.
4. After replay catches up, switch to live delivery without gaps or duplicate projection effects.
5. Multiple tabs may subscribe, but duplicate commands must not redispatch.

## Recovery behavior

- Core restart: rebuild projections/session views from authoritative stored state as designed; do not invent provider outcomes.
- Connector restart: old runtime becomes lost; a new provider process uses a new runtime generation.
- Pending unresolved active work after Connector/provider loss becomes `outcome_unknown` unless terminal provider history proves otherwise.
- Never automatically replay a prompt with possible side effects.

## Tests

Include database contract tests, migration tests, duplicate command race tests, sequence/replay tests, browser-refresh integration tests, and a failure test at the commit/broadcast boundary.

Update the status and handoff documentation with the database version, migration commands, and exact recovery demo.
