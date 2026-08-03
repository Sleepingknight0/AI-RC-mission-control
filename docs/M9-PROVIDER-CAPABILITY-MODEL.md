# M9 Provider Capability Model

## Inventory is not control

The operator's terminal registry under `%USERPROFILE%\.ai-cli-launcher` determines which providers and account profiles exist. A registry entry proves only inventory. Remote control requires an AICL adapter that passes compatibility and contract tests.

## Normalized record

A provider snapshot carries:

- stable provider ID and sanitized display label;
- enabled and installed observations;
- authentication observation without reading credential contents;
- compatibility state and redacted reason;
- adapter support: `inventory_only` or `remote_control`;
- capability states with `supported`, `unsupported`, or `unknown` plus provenance;
- distinct redacted accounts;
- usage state without invented meters;
- freshness: `live`, `local`, `stale`, `offline`, or `unavailable`;
- observation timestamp and bounded notice.

Capabilities cover inventory, installation/authentication probes, usage, remote control, Session list/create/resume, model discovery/change, reasoning, execution modes, text/image input, approval policies, sandbox, and network policy.

## Evidence rules

- Registry declarations have `terminal_registry` provenance.
- Installed Codex schema/compatibility probes have `provider_probe` provenance.
- Static adapter limits have `adapter_manifest` provenance.
- Absence of evidence is `unknown`, not `false`.
- Usage without a collector is `unavailable`; an unsupported collector is `not_supported`; neither produces `0%`.
- No local path, executable override, credential filename, or raw exception crosses Connector/Core.

## Bounds and isolation

Snapshots are capped at 64 providers, 32 accounts per provider, 128 models, and 16 reasoning options per model. Labels reject C0/C1 controls and are truncated before validation. Duplicate IDs keep the first deterministic registry entry and mark the snapshot degraded. One malformed entry or timed-out probe cannot suppress healthy providers or delay Turn control.

## Codex M9 support

Codex 0.146.0 advertises verified `thread/list`, `thread/start`, `thread/resume`, `model/list`, `account/read`, model/reasoning overrides, and local image input. Only the configured and successfully probed Codex account earns remote-control capabilities. Other Codex profiles remain distinct inventory until activated by a verified Connector profile path.

The active Connector now performs bounded `account/read` and paginated
`model/list` probes over the same app-server process used for Turns. Against
the installed generated schema, `account` may be an object, `null`, or omitted:
only a validated present account is treated as authenticated. A present account
was also measured with `requiresOpenaiAuth: true`; AICL records the account
presence and does not claim an unmeasured interpretation for that separate
mode flag. Malformed account objects reject safely. Provider email, plan,
tokens, and credential paths are discarded. Model IDs, labels,
modalities, and reasoning options are accepted only after normalized schema
validation. A failed or timed-out probe downgrades that Codex provider/account
to unknown or inventory-only and blocks create, resume, settings changes, and
Turn dispatch until a fresh successful probe. It does not remove healthy
sibling registry providers.

`execution_modes` is explicit evidence. The Codex adapter supports normalized
ask/plan/auto orchestration even though installed `turn/start` has no
provider-native collaboration-mode request field. Inventory-only providers
report this capability unsupported and cannot expose the control.
