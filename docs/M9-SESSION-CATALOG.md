# M9 Session Catalog

## Two authorities

- **AICL Sessions** are durable Core records and may be controlled when bound to a compatible Runtime.
- **Provider-native Sessions** are read-only discovery records from a verified adapter until explicitly imported or resumed.

Never merge records because titles or paths match. A binding uses the stable provider ID, account ID, and provider-native Session ID.

## Catalog V2

An AICL entry includes human title, provider/account identity, optional provider Session ID, source (`aicl` or `imported`), redacted project label, canonical project path only for the authorized operator, optional branch, model/reasoning, execution/approval/sandbox/network settings, operational state, Runtime state, pending approvals, Turn count, last activity, control/resume flags, pin/archive flags, and Session/settings revisions.

A discovered entry includes provider/account/native IDs, title/preview, project metadata allowed by the registered roots, provider status, timestamps, pin/archive state observed from the provider, and `canImport`/`canResume`. Discovery never creates Core rows by itself.

## Commands

- `session.create` creates a Core Session using revision 0 settings, then optionally asks Connector to create a provider Session.
- `session.resume` binds an existing AICL Session or imports a selected discovered Session after validating provider/account/project capability.
- `session.rename`, `session.pin`, and `session.archive` use expected Session revision.
- `sessions.catalog.list` supports bounded cursor pagination, search, provider/account/state/project filters, archived selection, and deterministic `lastActivityAt DESC, sessionId ASC` ordering.

Web should request 100 rows for its first page; Core enforces an explicit page
size with a hard maximum of 250. Search is literal case-insensitive text over
normalized title, provider/account labels, project label, branch, and IDs.
Device-relative unread state uses a separate read cursor and is not stored as a
global Session property.

## Implemented M9.3 behavior

`sessions.catalog.list` carries a request ID, device ID, explicit page size,
opaque cursor, and strict filters. Core orders by `lastActivityAt DESC,
sessionId ASC`. A cursor embeds the current catalog revision and is rejected as
stale after any Session mutation rather than returning a page with omissions or
duplicates. The current response contains AICL/imported rows only; native rows
arrive from M9.4 discovery and remain separately identified.

`session.rename`, `session.pin`, and `session.archive` use Session metadata CAS.
They return `session.command.accepted` or a stable rejection; archive fails while
a Turn runs. `session.read.mark` advances a monotonic per-device cursor no
further than the durable event sequence. Metadata/read actions are idempotent
and append bounded audit rows. Existing M8 `sessions.snapshot` remains valid.

## Codex discovery

The installed schema's `thread/list` is the source. The adapter paginates with a hard page/record/time budget, strips the unstable rollout `path`, validates `cwd` against configured roots, and maps `name ?? preview` to a bounded title. `thread/read` is used only for an explicit resume/detail operation.

Discovery reads active and archived Codex rows with `useStateDbOnly=true`, a
500-record hard cap, and a 2.5-second adapter budget. Rows outside configured
project roots or with malformed metadata fail independently. Core retains only
the latest ephemeral snapshot per provider/account and marks it stale on
Connector loss; discovery does not create an AICL Session or durable history.
`sessions.native.refresh` is accepted only for an authenticated remotely
controllable account whose current capabilities support Session listing.
