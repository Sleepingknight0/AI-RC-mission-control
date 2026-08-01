# Codex App-Server Spike Results

Do not fill this file from documentation or memory. Copy values from real runs on the target Windows host.

## Environment

| Field | Value |
|---|---|
| Date/time | |
| Windows version | |
| CPU/RAM | |
| Node version | |
| Codex version | |
| Auth/profile mode | |
| Model | |
| Test project | |
| Generated schema SHA-256 | |

## Runs

| Metric | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|
| request to first delta (ms) | | | |
| average deltas/sec | | | |
| rolling peak 1 sec | | | |
| rolling peak 100 ms | | | |
| payload p50 bytes | | | |
| payload p95 bytes | | | |
| max payload bytes | | | |
| inter-arrival p50 ms | | | |
| inter-arrival p95 ms | | | |

## Event/method inventory

Record observed generated-schema names and counts. Do not normalize them in this file.

| Provider method/event | Count | Notes |
|---|---:|---|
| | | |

## Kill-during-turn observations

### Run 1

- kill point:
- process-tree behavior:
- history/read result after restart:
- resume result:
- terminal outcome provable: yes/no
- safe product interpretation:

### Run 2

- kill point:
- process-tree behavior:
- history/read result after restart:
- resume result:
- terminal outcome provable: yes/no
- safe product interpretation:

### Run 3

- kill point:
- process-tree behavior:
- history/read result after restart:
- resume result:
- terminal outcome provable: yes/no
- safe product interpretation:

## Derived implementation defaults

| Setting | Selected value | Evidence |
|---|---:|---|
| browser delta batch window | | |
| stream checkpoint interval | | |
| stream checkpoint byte threshold | | |
| Connector event queue size | | |
| Core WebSocket queue size | | |
| max inline provider payload | | |

## Compatibility decision

- Supported Codex version/fingerprint:
- Unsupported behavior:
- Adapter changes required:
- Tests required before implementation continues:

## Trace hygiene

- [ ] Prompt and project secrets reviewed
- [ ] Raw paths reviewed
- [ ] Trace not committed
- [ ] Only scrubbed metrics shared outside the machine
