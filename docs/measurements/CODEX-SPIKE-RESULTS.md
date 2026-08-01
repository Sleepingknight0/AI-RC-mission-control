# Codex App-Server Spike Results

Do not fill this file from documentation or memory. Copy values from real runs on the target Windows host.

## Environment

| Field | Value |
|---|---|
| Date/time | 2026-08-01 02:10–02:12 UTC (local ~09:10–09:12) |
| Windows version | Microsoft Windows 11 Pro, NT 10.0.26200.0 (Build 26200) |
| CPU/RAM | 12th Gen Intel Core i5-12400F / 64 GB (65,292 MB) |
| Node version | v24.16.0 |
| Codex version | codex-cli 0.146.0 |
| Auth/profile mode | Logged-in local Codex CLI (default profile via PATH `codex`) |
| Model | `gpt-5.6-sol` (observed on thread/resume; CLI default, not overridden) |
| Test project | `spikes/fixture-project` |
| Generated schema SHA-256 | Run1 `sha256:04a3b338c482a830c5196ae2d5a7aa7425ebec517dcf88dda0020526c4356dfb`; Run2 `sha256:8fceff1925f9cafdc5bb5ae491c777423892e20e7280431213c7b4a1de3fe705`; Run3 `sha256:32c8b900d0f4f22b34a35d511855f416fc4f104cf36b5992727d2442a758aaf1` (each: 275 files, 2,860,544 bytes; fingerprint variance between identical runs noted below) |
| Batch artifact root | `spikes/codex-app-server/artifacts/real-20260801-091022/` |

## Runs

| Metric | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|
| request to first delta (ms) | 5446.16 | 4529.96 | 6307.70 |
| average deltas/sec | 53.25 | 55.63 | 56.00 |
| rolling peak 1 sec | 97 | 65 | 154 |
| rolling peak 100 ms | 87 | 16 | 90 |
| payload p50 bytes | 253 | 253 | 253 |
| payload p95 bytes | 263 | 263 | 263 |
| max payload bytes | 263 | 263 | 263 |
| inter-arrival p50 ms | 18.03 | 18.86 | 17.89 |
| inter-arrival p95 ms | 44.97 | 33.94 | 38.97 |
| agent-message deltas | 1619 | 1619 | 1619 |
| turn duration (ms) | 35875 | 33649 | 35191 |
| total RX bytes (turn) | 436105 | 435278 | 436105 |

Source reports:

- `spikes/codex-app-server/artifacts/real-20260801-091022/run-01/REPORT.md`
- `spikes/codex-app-server/artifacts/real-20260801-091022/run-02/REPORT.md`
- `spikes/codex-app-server/artifacts/real-20260801-091022/run-03/REPORT.md`

## Event/method inventory

Record observed generated-schema names and counts. Do not normalize them in this file.

Observed on completed benchmark turns (counts from `report.json` eventCounts; Run 2 omitted `thread/started` in the count map but still completed a turn):

| Provider method/event | Count (typical) | Notes |
|---|---:|---|
| `initialize` | 1 (request) | Required; present in schema scan |
| `thread/start` | 1 | Required; present in schema scan |
| `turn/start` | 1 | Required |
| `turn/started` | 1 | Notification |
| `turn/completed` | 1 | Required; terminal for benchmark turn |
| `item/started` | 3 | |
| `item/completed` | 3 | |
| `item/agentMessage/delta` | 1619 | Dominant stream; required method string found |
| `thread/tokenUsage/updated` | 1 | |
| `account/rateLimits/updated` | 1 | |
| `thread/status/changed` | 2 | |
| `mcpServer/startupStatus/updated` | 7 | Present even with text-only prompt |
| `thread/started` | 0–1 | Seen in runs 1 and 3 |
| `thread/read` | used in kill recovery | No error after restart |
| `thread/resume` | used in kill recovery | No error after restart; returns model metadata |

Schema scan: required method strings missing = **none** (all three runs).

## Kill-during-turn observations

### Run 1

- kill point: `agent_delta_threshold_5` (90 agent deltas observed before kill; `turn/completed` not seen)
- process-tree behavior: app-server process tree terminated mid-turn; client did not observe terminal event before kill
- history/read result after restart: turn status `interrupted`; no `thread/read` error
- resume result: thread status `idle`; turn remains `interrupted`; no `thread/resume` error; model reported `gpt-5.6-sol`
- terminal outcome provable: **yes** (`interrupted`)
- safe product interpretation: classify as terminal interrupted; **do not auto-resubmit** the original prompt; still treat any future case without reconstructed history as `outcome_unknown`

### Run 2

- kill point: `agent_delta_threshold_5` (23 agent deltas before kill; `turn/completed` not seen)
- process-tree behavior: same mid-turn kill
- history/read result after restart: turn status `interrupted`; no read error
- resume result: `interrupted` + idle thread; no resume error
- terminal outcome provable: **yes** (`interrupted`)
- safe product interpretation: same as Run 1

### Run 3

- kill point: `agent_delta_threshold_5` (22 agent deltas before kill; `turn/completed` not seen)
- process-tree behavior: same mid-turn kill
- history/read result after restart: turn status `interrupted`; no read error
- resume result: `interrupted` + idle thread; no resume error
- terminal outcome provable: **yes** (`interrupted`)
- safe product interpretation: same as Run 1

## Derived implementation defaults

| Setting | Selected value | Evidence |
|---|---:|---|
| browser delta batch window | 33 ms (~1 frame @ 30 Hz) or 16 ms @ 60 Hz | Steady ~18 ms inter-arrival p50; batching 1–2 arrivals without visible lag |
| stream checkpoint interval | 250–500 ms | Avg ~55 deltas/s; checkpoint coalescing, not per-delta durability |
| stream checkpoint byte threshold | 8–16 KiB | ~256 B × 32–64 deltas; keeps ephemeral buffer bounded |
| Connector event queue size | ≥ 512 events | Peak 154 deltas/s + control events; headroom for bursts |
| Core WebSocket queue size | ≥ 256 coalesced frames | Browser should receive batched frames, not raw 154/s |
| max inline provider payload | 4 KiB for ephemeral deltas; large content → artifacts | Observed max agent-delta payload 263 B; leave margin for other event types |

## Compatibility decision

- Supported Codex version/fingerprint: **codex-cli 0.146.0** on this host; schema generation succeeds (275 files). Prefer pinning adapter tests to installed binary schemas rather than a single fingerprint until fingerprint variance is explained (content/order may be non-deterministic across runs despite identical file count/size).
- Unsupported behavior: Do not assume process reattach after Connector death. After kill, history reconstructs `interrupted`, not `completed` and not live reattach.
- Adapter changes required:
  - Map provider `interrupted` / `cancelled` / `failed` / `completed` explicitly.
  - Never auto-resubmit after process loss.
  - Keep token/agent-message deltas ephemeral; durable path is turn/item boundaries and reconstructed history.
  - Windows spawn: paths under `Program Files` break if `shell: true` without quoting (harness fixed in `spikes/codex-app-server/spike.mjs`).
- Tests required before implementation continues:
  - Schema gate against installed `codex app-server generate-json-schema`
  - Mid-turn process death → `interrupted` or `outcome_unknown` without resubmit
  - First-token path measures request→first delta under load similar to 4.5–6.3 s cold start observed here

## Harness notes (this host)

1. Initial mock spike failed: `spawnSync(..., { shell: true })` on Windows does not quote args; `C:\Program Files\nodejs\node.exe` split at the space.
2. Fix applied in `spikes/codex-app-server/spike.mjs`: shell-safe quoting / shell:false for `.exe` paths.
3. Mock spike then passed; three real runs completed with exit 0.

## Trace hygiene

- [x] Prompt and project secrets reviewed (fixture text-only prompts; no user secrets in docs)
- [x] Raw paths reviewed (absolute Windows paths remain only in local artifacts)
- [x] Trace not committed (artifacts under `spikes/codex-app-server/artifacts/` are gitignored)
- [x] Only scrubbed metrics shared outside the machine (this file)
