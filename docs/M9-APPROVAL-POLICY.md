# M9 Approval Policy

## Separation of concerns

Execution mode describes how an agent proceeds. Approval policy grants or withholds side-effect authority. `auto` never implies automatic approval.

## Policies

- `review`: no Core auto-resolution. Every provider request reaches the operator.
- `balanced`: Core may approve a verified non-process read operation. The current
  Codex normalized approval API exposes command launches rather than such an
  operation, so its verified auto-allow set is empty; all current requests stay
  pending.
- `workspace_auto`: Core may approve a non-delete file-change request only when
  its already-normalized file list is present and every canonical path remains
  inside the project. Missing file evidence, escape, links/junctions, delete,
  commands, network, credential, and system operations remain pending.
- `full_auto_lease`: automatic resolution is available only while a matching live lease exists. It adds bounded file deletes and an exact project-command allowlist (`pnpm build/check/lint/test/typecheck`) but still rejects shell metacharacters and cannot exceed project/sandbox/network/provider capability boundaries.

Unknown classification never auto-approves.

## Full Auto lease

A lease is a Core row containing opaque ID, Session, project, provider, account, device, Runtime ID/generation, issue/expiry/revocation times, state, and revision. Creation requires explicit command and duration of 15, 30, or 60 minutes. A lease is usable only when every scope value and expected revision matches and the current time is before expiry.

Lease IDs are not bearer authority by themselves. The Turn must carry the same
client-instance `deviceId` that created the lease; legacy Turns without a device
ID fail closed. This is an audit/concurrency scope, not cryptographic device
identity—remote identity remains outside M9. Runtime loss/generation change,
any Session-settings change, emergency stop, Core restart, or expiry revokes
authority. Creation, use, expiry, and revocation append audit rows. Replay and
scope mismatch fail closed.

## Emergency stop

`approval.emergency_stop` revokes all active leases for the Session and
interrupts the active Turn through the existing fenced path. It never replays
work. Any authenticated operator connection may invoke it; it is deliberately
not restricted to the lease-owning client instance.

## Provider mapping

Core decides whether a normalized request is authorized. Connector translates
only Core's explicit one-shot decision and always starts Codex with
`approvalPolicy: on-request`; it never maps a browser boolean or a lease to
provider `never`. `read_only` maps to Codex `readOnly`; `workspace_write` maps
to a single canonical writable root. Network remains disabled because the
installed adapter has not verified restricted-network translation.
