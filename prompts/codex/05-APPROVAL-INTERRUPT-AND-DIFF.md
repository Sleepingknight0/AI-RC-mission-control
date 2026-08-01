# Codex Task — Command Output, Approval Safety, Interrupt, and Diff Review

Complete milestones **M4.1–M4.3** after durable reconnect works.

## Goal

Expose normalized tool/command activity and file changes, allow safe remote approval or decline, and handle large diffs without violating WebSocket limits.

## Required provider mapping

Using only methods/types verified by the installed Codex schema, normalize:

- command/tool started
- bounded output deltas
- command/tool completed
- file change or diff metadata
- approval requested
- approval resolved/expired/invalidated
- interrupt result

Keep raw provider request IDs internal except for an opaque normalized correlation field required by Connector.

## Approval correctness

Approval resolution must use compare-and-set on the approval resource and validate:

- state is still pending
- expected approval revision matches
- runtime ID and generation match
- Turn identity/state match
- provider request identity matches Connector state
- approval is not expired

Do not use Session revision as an approval precondition. High-rate deltas must never make an approval stale.

Invalidate unresolved approvals when the owning runtime is lost. A delayed or duplicated browser response must not reach a newer runtime generation.

## Payload and artifact policy

- Keep WebSocket messages within the repository limit.
- Keep inline diffs below the configured inline threshold.
- Store larger diffs as authenticated local artifacts with content hash, byte length, media type, and bounded/range-capable retrieval.
- Do not expose arbitrary local filesystem paths through artifact URLs.

## UI integration surface

Expose normalized data sufficient for:

- a sticky approval dock
- a command-output panel
- unified or side-by-side diff view
- clear pending, expired, declined, approved, lost-runtime, and unknown-outcome states

Do not redesign the entire UI in this task. Provide typed fixtures for the later Grok frontend pass.

## Tests

Add race and failure tests for:

- two tabs approving simultaneously
- approval after expiry
- approval after runtime generation changes
- duplicate approval command ID
- provider death with approval pending
- output coalescing and maximum envelope size
- inline/large-diff threshold
- artifact hash and unauthorized/path-traversal access
- interrupt during command execution

Update documentation with an exact mobile/browser approval demo path.
