# Generated Codex Protocol Source

The JSON schemas in `schema/` were generated from installed `codex-cli 0.146.0`:

```powershell
codex app-server generate-json-schema --out .\apps\connector\src\codex\generated\schema
pnpm --filter @aicl/connector codex:compatibility
```

Do not import these provider-specific schemas from Core or Web. Update
`compatibility.ts` only after the new binary and schema pass adapter tests and a
real vertical-slice run. The accepted recursive-canonical SHA-256 is
`b767c1161c2c56341f3d0e313b4f93810b4b53bdaabeff95c06e1242cfc4df03`.
