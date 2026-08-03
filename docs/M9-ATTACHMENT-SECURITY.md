# M9 Attachment Security

## Managed lifecycle

```text
begin -> chunks -> complete/ready -> referenced by one accepted Turn -> expired/deleted
```

Core allocates an opaque attachment ID and records Session, owner device, name, declared media type/kind, total bytes, chunk size/count, expiry, and state. Browser chunks carry only opaque IDs and bounded base64 bytes. Completion assembles in index order, computes SHA-256, verifies length and media signature, then marks the attachment ready atomically.

## Limits

- 8 MiB per attachment
- 8 attachments per Turn
- 32 MiB active allocation per Session
- 128 KiB decoded chunk
- 24-hour unreferenced retention, with expired/incomplete cleanup

Duplicate identical chunks are idempotent; a changed duplicate is rejected. Missing, corrupt, expired, cross-Session, or cross-device chunks/references fail closed.

## Accepted content

- UTF-8 text: `text/plain` or `text/markdown`, up to 1 MiB, no NUL;
  translated into a bounded, explicitly delimited provider text input.
- Images: PNG, JPEG, GIF, or WebP only after magic-byte and MIME agreement; enabled only when the selected model advertises image input.
- PDF/document/archive remain unsupported in the Codex M9 adapter and fail with an actionable capability error.

Extensions are not evidence. Uploaded content is never executed.

## Core/Connector transfer

Core persists ready bytes in its managed SQLite store. At dispatch it sends a bounded, checksummed Connector materialization stream before the Turn command. Connector writes only to an application-owned temporary input root using exclusive files, rejects links/reparse escapes, verifies length/hash again, and supplies the resulting local image path or text content to the adapter. It deletes materialized inputs after terminal Turn settlement or bounded recovery cleanup.

No browser path, Core database path, Connector temp path, or provider credential path is emitted to Web or logs.

## Implemented protocol

- `attachment.upload.begin` is an idempotent command. Core allocates the opaque
  ID and returns `attachment.command.accepted`.
- `attachment.upload.chunk` is idempotent only when the repeated index contains
  byte-identical content; Core returns cumulative `attachment.upload.progress`.
- `attachment.upload.complete` verifies every index, total length, SHA-256,
  kind/MIME agreement, UTF-8 or image magic, then returns ready metadata.
- `attachments.list` is scoped by Session and stable device ID. `attachment.delete`
  cannot remove an attachment already referenced by an accepted Turn.
- `turn.submit.attachmentIds` is optional for M8 compatibility, unique and
  bounded to eight. Non-empty references require `deviceId`; acceptance changes
  every referenced row to `referenced` in the same transaction as the Turn.

Core schema 10 stores upload metadata, chunks, verified bytes, and immutable
Turn bindings. The Connector reassembles a second authenticated stream, verifies
the hash again, writes images with exclusive creation under a new private temp
root, and removes the Turn directory after provider settlement. Documents and
archives fail closed because the current Codex adapter does not support them.
