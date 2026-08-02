# Automation Scripts

| Script | Purpose |
|---|---|
| `Check-Toolchain.ps1` | Check required and optional CLI tools |
| `Run-CodexSpike.ps1` | Run the real app-server spike multiple times |
| `Invoke-Codex.ps1` | Send a Markdown task to `codex exec -` with workspace-write sandbox |
| `Invoke-GrokFrontend.ps1` | Optional post-prototype frontend/UX review |
| `Invoke-ClaudeReview.ps1` | Optional post-prototype read-only audit |
| `Show-NextStep.ps1` | Print the first incomplete milestone and suggested prompt |
| `Build-Production.ps1` | Build source-map-free Web/Core/Connector/Host bundles |
| `Start-Production.ps1` | Start the compiled Host supervisor in the background |
| `Stop-Production.ps1` | Request graceful shutdown, with verified bounded fallback |
| `Status-Production.ps1` | Report persisted production PID and health state |
| `Doctor-Aicl.ps1` | Check build, config, databases, Codex compatibility, and local health |
| `Configure-TailscaleServe.ps1` | Configure private HTTPS Serve and persist the exact ts.net Origin |
| `Status-TailscaleServe.ps1` | Distinguish app, Connector, Tailscale, Serve, and Origin state |
| `Test-TailscaleRemote.ps1` | Prove HTTPS/runtime-ticket/WSS access from a second tailnet device |
| `Install-AiclStartupTask.ps1` | Install interactive-user logon startup with restart policy |
| `Uninstall-AiclStartupTask.ps1` | Remove the AICL logon task |
| `Backup-Aicl.ps1` / `Restore-Aicl.ps1` | Fail closed until verified M8.6 operations exist |
| `Test-ProductionLifecycle.ps1` | Isolated compiled start/health/status/stop smoke |

All scripts resolve paths relative to the repository root. Run them from PowerShell on the target Windows host. `Invoke-Codex.ps1` defaults to the active M8 daily-use loop prompt; pass an older prompt explicitly only when reproducing historical work.

`Start-Dev.ps1` supplies explicit project and Core endpoint environment
overrides while Core and Connector load the shared versioned config under
LocalAppData. These development overrides are never persisted.

Root shortcuts are `pnpm build`, `pnpm start`, `pnpm stop`, `pnpm status`,
`pnpm doctor`, `pnpm startup:install`, and `pnpm startup:uninstall`. `pnpm next`
prints the next milestone. The startup task runs `Run-ProductionTask.ps1` in the
foreground under the interactive limited operator so Task Scheduler can observe
and restart a failed Host; normal terminal start remains backgrounded.

Private remote shortcuts are `pnpm remote:configure`, `pnpm remote:status`, and
`pnpm remote:test -- -Origin https://<device>.<tailnet>.ts.net`. Configuration
requires AICL to be stopped, derives the exact Origin from `tailscale status
--json`, runs only `tailscale serve --bg --yes http://127.0.0.1:<core-port>`,
and never invokes Funnel. The test command must run on a different tailnet
device; it refuses same-device evidence and never records the one-time ticket.
