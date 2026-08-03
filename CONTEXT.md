# AICL Domain Context

## Ubiquitous language

- **Provider descriptor** — one terminal-registry entry. It is inventory, not proof that AICL can control the provider.
- **Provider account** — a redacted, stable account/profile identity advertised by the Connector. It never contains credentials or a local profile path.
- **Capability** — a bounded fact with provenance and freshness. `unknown` is different from `unsupported`.
- **Provider fleet snapshot** — the latest Connector observation. It is replaceable operational state, not Session history.
- **AICL Session** — Core-owned durable workspace/conversation identity.
- **Provider-native Session** — a provider thread discovered by a verified adapter. Discovery does not import or merge it.
- **Session binding** — the explicit link between one AICL Session and one provider-native Session.
- **Session settings** — revision-fenced execution configuration owned by Core.
- **Effective Turn settings** — immutable settings copied onto a Turn when Core accepts it.
- **Execution mode** — `ask`, `plan`, or `auto`; it controls orchestration, not authority.
- **Approval policy** — Core-owned side-effect policy: `review`, `balanced`, `workspace_auto`, or `full_auto_lease`.
- **Full Auto lease** — short-lived, scoped authority. It is not a permanent preference.
- **Managed attachment** — Core-owned uploaded bytes referenced by opaque ID; never a browser-supplied filesystem path.
- **Terminal activity** — bounded normalized command/tool evidence, never unrestricted PTY access.

## Current decisions

- Codex is the only provider with remote control in M9. Other registry entries remain truthful inventory-only records.
- Provider inventory and native-session discovery are operational snapshots; AICL Session state remains durable in Core SQLite.
- The browser protocol grows through new envelopes instead of changing the frozen M8 Web shapes.
- Account, model, reasoning, sandbox, and input controls appear only when the active adapter supplies evidence.
- Unread state is device-relative and must not become a single global Session counter.
- Remote identity, Cloudflare, Google Login/OAuth, and the deferred M8.5 gate are outside M9.
