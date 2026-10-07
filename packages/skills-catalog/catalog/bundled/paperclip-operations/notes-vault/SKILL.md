---
name: notes-vault
description: Read and write the company's notes vault (for example the board's Obsidian vault) through the Paperclip API. Use it to record notes, decisions, journals or project updates in the vault, whatever model you run on.
key: paperclipai/bundled/paperclip-operations/notes-vault
recommendedForRoles:
  - ceo
  - manager
  - general
tags:
  - paperclip
  - vault
  - obsidian
  - notes
  - memory
---

# Notes vault

The board can share a notes vault, such as an Obsidian vault, with chosen agents. You reach it only through the Paperclip API, using your usual Paperclip credentials. The vault is not on your filesystem.

## Check your access first

```
GET /api/companies/{companyId}/notes-vault
```

- `enabled: false` means you have no vault access. Say so in your task and stop. Don't look for another way in.
- `access: "read"` means you can list and read files, but not write them.
- `access: "write"` means you can also create, append to and replace files.
- `aiFilePrefix` is the prefix your new files must start with (usually `(C) `).
- `changelogPath` is the changelog file. Paperclip writes it for you.

## Read

```
GET /api/companies/{companyId}/notes-vault/list?path=03 Projects
GET /api/companies/{companyId}/notes-vault/file?path=03 Projects/Plan.md
```

URL-encode the path. A read returns `content` and `sha256`. Keep the `sha256` if you might replace the file.

## Write

```
POST /api/companies/{companyId}/notes-vault/file
{ "path": "...", "mode": "create" | "append" | "replace", "content": "...", "baseSha256": "...", "summary": "..." }
```

- **create** makes a new file and fails if the file already exists. The file name must start with `aiFilePrefix`, for example `03 Projects/(C) Weekly review — 2026-10-04.md`.
- **append** adds to the end of an existing file. Use it for logs, journals and running notes.
- **replace** rewrites a whole file. It needs `baseSha256` from your latest read and fails with 409 if the file changed since. If that happens, read the file again, merge your change, and retry.
- `summary` is one line that goes into the vault changelog with your name, so make it say what changed. Don't write the changelog yourself.

## Sync with the board's devices

The vault may also have a cloud copy, for example the Google Drive folder the board opens in Obsidian. Paperclip keeps the two in step both ways: your writes reach the cloud copy within about a minute, and the board's edits reach the vault within 5 minutes.

```
GET  /api/companies/{companyId}/notes-vault/sync   # status: lastSuccessAt, lastOk, lastError, nextRunAt
POST /api/companies/{companyId}/notes-vault/sync   # writers: sync now, for example before reading a note the board just edited
```

- `enabled: false` means the vault has no cloud copy.
- A file named `name.sync-conflict1.md` means the board and an agent changed the same note at the same time. The other version is in the file without the suffix. Tell the board; don't merge or delete either one yourself.
- If `lastOk` is false, mention `lastError` in your task comment. Fixing the sync is the board's or an operator's job.

## Rules

1. **Read before you write.** Follow the vault's own conventions (folders, headings, links), which its root notes describe.
2. **Prefer append or a new file over replace.** Never remove useful content. When something is out of date, mark it as such instead of deleting it.
3. **Only write Markdown (`.md`).** Hidden folders (`.obsidian`, `.trash`) are off limits.
4. **Keep secrets out of the vault.** Never write tokens, keys or passwords into it.
5. **Name the vault files you changed** in your task comment.

## Errors

| Status | Meaning |
|---|---|
| 404 | No vault access, or the file doesn't exist. |
| 403 | You can read but not write, or the path is hidden or outside the vault. |
| 409 | `create` on an existing file, or a `replace` whose file changed since you read it. |
| 422 | Not a `.md` file, a missing prefix, a missing `baseSha256`, or a write to the changelog. |
| 503 | The vault is unavailable. Report it and try again later. |
