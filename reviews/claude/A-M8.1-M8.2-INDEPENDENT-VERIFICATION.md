# Phase A — Independent Verification of M8.1 and M8.2

Reviewer: Claude Code (implementation-authorized run)
Date: 2026-08-03
Baseline commit: `20f1555297944548268693d34cd43ef6a3c10db7` — *feat: add M8 same-origin host and browser ticket auth*
Working tree at start: **dirty** — uncommitted M8.3 integration work was already present (see §4).

## 1. Verdict

**M8.1 and M8.2 are substantially confirmed**, with one confirmed defect (A-01, Medium) fixed in this run
and two informational observations. No evidence was found that would justify rewriting either milestone.

| Area | Result |
|---|---|
| A1 same-origin production host | Confirmed, 1 defect (A-01) |
| A2 runtime browser tickets | Confirmed, no defects |

## 2. Evidence executed

```text
pnpm check                       -> exit 0; 84 passed, 1 skipped (baseline, before my changes)
pnpm check                       -> exit 0; 91 passed, 1 skipped (after M8.3 completion + A-01 fix)
pnpm --filter @aicl/core exec vitest run test/production-host.test.ts   -> 2 passed
pnpm --filter @aicl/core exec vitest run test/runtime-auth.test.ts      -> 5 passed (4 pre-existing + 1 added)
pnpm --filter @aicl/web  exec vitest run test/runtime.test.ts           -> 4 passed
node -e "require('node:sqlite')" -> unflagged OK on v24.16.0
```

Not executed in this run, and therefore **not claimed**:

- Playwright desktop/mobile browser acceptance.
- Real Codex end-to-end (`AICL_REAL_CODEX=1`); it remained skipped in every gate above.
- Reverse-proxy HTTPS/WSS behaviour (requires the M8.5 Tailscale Serve deployment).
- Second-device / tailnet validation.

## 3. Findings

### A-01 — Medium — IPv6 loopback origin is emitted unbracketed, stranding same-origin production on `::1`

- **File/symbol:** `apps/core/src/server.ts` — post-`listen` origin registration and the
  `browserUrl` / `connectorUrl` fields of `CoreServerHandle`.
- **Violated invariant:** AD-016 — the production Web app, `/ws`, and `/artifacts` must be reachable behind
  one Core origin. `packages/config` accepts `::1` as a valid `core.host`, so this configuration is reachable.
- **Reproduction:** start Core with `host: "::1"`, then read `core.browserUrl`.
- **Evidence (before fix):**
  ```text
  AssertionError: expected 'http://::1:49990' to match /^http:\/\/\[::1\]:\d+$/
  ```
  A browser on IPv6 loopback sends `Origin: http://[::1]:<port>`. The unbracketed authority
  `http://::1:<port>` never string-matches that Origin, so `/runtime-config` would answer
  `403 ORIGIN_NOT_ALLOWED` and the `/ws` upgrade would answer `403`. `ws://::1:<port>/ws` is also not a
  parseable WebSocket URL, so the returned handle is unusable by test harnesses and tooling.
- **Remediation applied:** bracket IPv6 literals via a single shared helper
  (`urlHost` / `httpOrigin` / `webSocketOrigin` in `@aicl/config`), used by both Core and Connector. This
  also removed a duplicated local `webSocketOrigin` in `apps/connector/src/main.ts`.
- **Regression test:** `apps/core/test/runtime-auth.test.ts` —
  *"accepts its own bracketed origin when bound to IPv6 loopback"*. Verified red before the fix and green
  after.

### A-02 — Informational — `.map` is a served content type while source maps are disabled

`apps/core/src/static-host.ts` maps `.map` to `application/json`. `apps/web/vite.config.ts` sets
`build.sourcemap: false`, so no map is emitted and nothing is exposed today. The mapping only becomes a
leak if source maps are ever re-enabled. No change made; recorded so the M8.4 production build gate keeps
`sourcemap: false` deliberately rather than by accident.

### A-03 — Informational — double `stat` on every static file serve

`serveWebRequest` calls `isFile()` and then `serveFile()` stats the same path again, a benign TOCTOU
window and one redundant syscall per request on a loopback-only single-operator host. Not worth changing
during M8.

## 4. Confirmed A1 behaviours

| Claim | Result | Evidence |
|---|---|---|
| Core serves the Vite production build | Confirmed | `production-host.test.ts` |
| Hashed assets cached immutably | Confirmed | `static-host.ts` — `/assets/` ⇒ `max-age=31536000, immutable` |
| `index.html` not cached unsafely | Confirmed | non-asset responses ⇒ `no-cache` |
| SPA fallback only on HTML navigation | Confirmed | fallback gated on `accept: text/html` |
| Protocol routes cannot be shadowed | Confirmed | `isReservedHttpPath` reserves `/health`, `/runtime-config`, `/ws`, `/connector`, `/artifacts` |
| Malformed/encoded/traversal paths fail safely | Confirmed | `safeRelativePath` rejects bad percent-encoding, NUL, `\`, and `..`; `resolveWithin` re-anchors under the dist root |
| Unsupported methods rejected | Confirmed | 405 with `allow: GET, HEAD` |
| Missing build directory fails safely | Confirmed | `isFile` swallows ENOENT/ENOTDIR ⇒ 404 |
| Production does not require Vite | Confirmed | Core streams from `apps/web/dist` |
| `ws:`/`wss:` derived from page origin | Confirmed | `apps/web/src/runtime.ts`, `runtime.test.ts` |
| `VITE_CORE_WS_URL` is dev-only override | Confirmed | override honoured only when non-empty |
| No production source maps | Confirmed | `vite.config.ts` `sourcemap: false` |

## 5. Confirmed A2 behaviours

| Claim | Result | Evidence |
|---|---|---|
| `/runtime-config` is POST-only | Confirmed | 405 `allow: POST, OPTIONS` |
| Exact Origin checked at issuance | Confirmed | `isAllowedOrigin` before issue; 403 `ORIGIN_NOT_ALLOWED` |
| Exact Origin checked at upgrade | Confirmed | `server.ts` upgrade handler 403s before ticket consumption |
| TTL enforced | Confirmed | `BrowserTicketRegistry.consume` drops `expiresAtMs <= now` |
| One-time use | Confirmed | `#records.delete(digest)` on success; `runtime-auth.test.ts` re-upgrade ⇒ 401 |
| Replay fails | Confirmed | same test |
| Hostile Origin cannot consume a valid ticket | Confirmed | `record.origin !== origin` ⇒ `continue`, ticket retained |
| Core restart invalidates tickets | Confirmed | registry is in-memory only |
| Storage bounded | Confirmed | `limit` (default 128) ⇒ 503 `TICKET_CAPACITY_REACHED` |
| Only digests retained | Confirmed | `ticketDigest` SHA-256; plaintext returned once, never stored |
| Ticket never in URL/storage/logs | Confirmed | `runtime.ts` POSTs and holds it in memory; passed as a `Sec-WebSocket-Protocol` capability |
| Request bodies rejected | Confirmed | `hasRequestBody` ⇒ 413 `PAYLOAD_NOT_ALLOWED` |
| Connector credential separate | Confirmed | `/connector` uses `connectorToken` only; tickets are never consulted |
| Legacy browser token disabled in production | Confirmed | `apps/core/src/main.ts` passes `legacyBrowserTokenEnabled: false` |

## 6. Note on working-tree provenance

This review started from a **dirty** working tree: uncommitted M8.3 integration work (`packages/config`
wired into Core/Connector startup, `CODEX_HOME` plumbing, and a process-level test) was already present and
is not mine. The uploaded task prompt asserted that "Core startup still reads its production settings
directly from environment variables"; that was **already false** in the working tree, though incomplete —
`core.allowedBrowserOrigins` and `connector.healthPort` were still read straight from `process.env`.

I completed that work rather than restarting it. Provenance is recorded here because the resulting commit
mixes another agent's uncommitted changes with mine.
