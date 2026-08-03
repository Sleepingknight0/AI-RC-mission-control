# M9 Approval Policy

## Separation of concerns

Execution mode describes how an agent proceeds. Approval policy grants or withholds side-effect authority. `auto` never implies automatic approval.

## Policies

- `review`: no Core auto-resolution. Every provider request reaches the operator.
- `balanced`: Core may approve only a verified low-risk read-only request inside the project; write, delete, process launch, package install, network, credential, and system operations remain pending.
- `workspace_auto`: Core may approve bounded writes within the canonical project root. Escape, links/junctions, bulk destructive actions, credential access, system changes, arbitrary process execution, and out-of-policy network remain pending or denied.
- `full_auto_lease`: automatic resolution is available only while a matching live lease exists; it still cannot exceed project/sandbox/network/provider capability boundaries.

Unknown classification never auto-approves.

## Full Auto lease

A lease is a Core row containing opaque ID, Session, project, provider, account, device, Runtime ID/generation, issue/expiry/revocation times, state, and revision. Creation requires explicit command and duration of 15, 30, or 60 minutes. A lease is usable only when every scope value and expected revision matches and the current time is before expiry.

Lease IDs are not bearer authority by themselves. Core checks the authenticated browser connection's device ID. Runtime loss/generation change, Session policy change, emergency stop, Core restart policy, or expiry revokes authority. Creation, use, expiry, and revocation append audit events. Replay and scope mismatch fail closed.

## Emergency stop

`approval.emergency_stop` revokes all active leases for the Session/device as requested, invalidates automatic approval, and interrupts the active Turn through the existing fenced path. It never replays work.

## Provider mapping

Core decides whether a normalized request is authorized. Connector translates only the resulting explicit decision. Provider `approvalPolicy: never` may be used only for a Turn whose valid Full Auto lease and bounded sandbox/network scope were checked at dispatch; otherwise Codex stays request-capable.
