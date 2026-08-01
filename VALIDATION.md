# Starter Package Validation

Validated on 2026-08-01 in the artifact build environment.

## Passed

- All JSON workspace/configuration files parse successfully.
- All local Markdown links resolve.
- All required prompt, script, specification, and IDE files are present.
- All JavaScript/MJS files pass `node --check`.
- The bundled mock app-server spike completes:
  - schema generation
  - initialization
  - normalized streaming measurement
  - process kill during a Turn
  - process restart
  - `thread/read`
  - `thread/resume`
  - conservative unresolved-state interpretation

## Deliberately not claimed

- PowerShell scripts were not executed in this Linux build environment because Windows PowerShell is not installed here.
- The real installed Codex app-server was not run here.
- Real Windows process-tree behavior, provider delta rate, payload distribution, approval behavior, and resume semantics must be measured on the target Windows host using `scripts/Run-CodexSpike.ps1`.
- Grok Build and Claude Code were not invoked during package construction.

The mock spike validates the harness only. Its timing numbers are not product sizing evidence.
