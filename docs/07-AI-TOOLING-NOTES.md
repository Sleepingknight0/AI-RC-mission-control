# AI Tooling Notes

Checked on 2026-08-01. Provider CLIs change rapidly; inspect installed help and generated schemas before relying on these notes.

## Shared repository instructions

- Codex supports repository-level `AGENTS.md` instructions.
- Grok Build also reads the `AGENTS.md` instruction-file family.
- Claude Code reads `CLAUDE.md`; the recommended compatibility pattern is a `CLAUDE.md` that imports `@AGENTS.md`.

This kit follows that pattern so architecture rules are not copied into three conflicting files.

## Codex

Interactive:

```powershell
codex
```

Non-interactive implementation:

```powershell
Get-Content .\prompts\codex\00-MASTER-NEXT-MILESTONE.md -Raw |
  codex exec --sandbox workspace-write -
```

`codex exec` is read-only by default. The provided script explicitly uses `workspace-write`, not unrestricted access.

Official references:

- https://learn.chatgpt.com/docs/codex/cli
- https://learn.chatgpt.com/docs/non-interactive-mode
- https://developers.openai.com/cookbook/articles/codex_exec_plans

## Grok Build

Interactive is preferred for frontend changes because it keeps permission decisions visible:

```powershell
grok
```

Headless mode is available for controlled tasks:

```powershell
grok -p "Review the frontend" --output-format streaming-json
```

The provided Grok script defaults to interactive mode and copies the task directive to the clipboard.

Official references:

- https://docs.x.ai/build/overview
- https://docs.x.ai/build/features/project-rules
- https://docs.x.ai/build/cli/headless-scripting

## Claude Code

Claude review is run in plan/read-only mode:

```powershell
Get-Content .\prompts\claude\01-ARCHITECTURE-CORRECTNESS-REVIEW.md -Raw |
  claude -p --permission-mode plan --tools "Read,Glob,Grep" `
    --disallowedTools "Edit" "Write" "NotebookEdit" "Bash" "mcp__*" `
    "Perform the read-only review described in the piped Markdown."
```

The script saves the final report under `reviews/claude/`.

Official references:

- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/permission-modes

## Version policy

- Record `codex --version`, `grok version`, and `claude --version` in each major review or measurement.
- Do not automatically update a provider CLI during an active milestone.
- Regenerate Codex schema after a deliberate version update.
- A changed schema fingerprint requires compatibility tests before the Connector starts normal work.
