# M9 Remote AI Workspace Specification

## Goal

M9 turns the local Codex operations console into a normalized workspace backend. Core remains authoritative for Sessions, settings, policy, uploads, commands, and replay. Connector remains authoritative for provider processes, registry observations, native-session discovery, and provider translation.

The visual Web layer is frozen at Grok commit `c2f1d481`; M9 exposes backward-compatible contracts for later integration.

## System boundaries

```text
Browser -> Core -> Connector -> provider adapter -> provider
             |          |
        Core SQLite  Connector journal/temp inputs
```

- Browser input is untrusted and schema-bounded.
- Core never reads arbitrary project files or provider credentials.
- Connector never opens Core SQLite.
- Provider-specific identifiers stop at Core projections; raw events never reach Web.
- One executing Turn per Session and per attached Runtime remains enforced.
- Lost or ambiguous work becomes `outcome_unknown`; no prompt is replayed automatically.

## Delivery slices

1. M9.0 records contracts and an exact-head baseline.
2. M9.1–M9.2 add truthful provider capabilities and inventory relay.
3. M9.3–M9.4 add Catalog V2 and verified Codex native-session control.
4. M9.5–M9.7 add settings CAS, execution modes, policy, and leases.
5. M9.8–M9.9 add managed inputs and richer terminal evidence.
6. M9.10–M9.11 prove fault, security, recovery, and performance behavior.

## Explicit non-goals

- Remote control for providers without a verified adapter
- Generic PTY, raw shell, or arbitrary filesystem endpoints
- Multi-user authorization
- Fake quota, model, account, Session, or capability data
- Google identity, Cloudflare, public ingress, or Tailscale redesign
- Visual edits under `apps/web/src`, `apps/web/index.html`, fonts, or assets

## Completion truth

Each phase is complete only when its protocol/domain contract, implementation, migration where needed, and targeted tests exist. A skipped real-provider test is reported as skipped or externally blocked, never passed.
