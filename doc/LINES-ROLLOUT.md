# Lines server rollout and historical adoption

This code groups only roots that a caller explicitly ensures. It does not group old work during migration and does not start a Line from a title, root creation, or blueprint save. Deployment, production migration, Summarizer setup, and the first real GPT naming proof are separate governed steps.

## Jarvis: activate the assembly-line instructions after release

Update the installed `assembly-line` skill only after the Line API is live. In Discovery, immediately after choosing the existing top-level goal issue and before creating a blueprint child, call `POST /api/companies/{companyId}/lines` with `{ "rootIssueId": "<top-level issue UUID>" }`. A 201 means the Line was created; a 200 means an earlier Discovery attempt already created it. Keep the returned Line ID in the top-level issue context. If the call fails because naming setup is missing, verify the Line through `GET /api/lines/{lineId}` and continue task work with `displayName`. Retrying the ensure call must not create a second Line.

Use the same ensure call on the fast path before creating its one implementation child. Every subsequent planning, revision, recovery, and delegated task should use normal parentage; the issue service assigns `lineId`. Do not send `lineId` in issue mutation payloads. Do not create a nested Line inside a grouped root. Keep normal approval, budget, pause, checkout, and dependency procedures.

The built-in Summarizer must be company-configured and runnable with Codex/OpenAI. A hidden naming task uses `codex_local`, `gpt-5.4-mini`, and low effort. A missing Summarizer or provider authorization leaves a temporary `Line <root identifier>` label and an actionable `lastNamingErrorCode`; it does not stop grouping. Before approving initial deployment, run one real GPT naming task in the governed preview or release check and confirm `namingStatus=ready`, `namingModel=gpt-5.4-mini`, and its run provenance. Provider stubs in unit tests do not satisfy this gate.

## Historical adoption: dry run, approval, apply

1. Write a JSON array of explicit root issue UUIDs. Do not derive it from titles, dates, or a search query. Keep the list company-specific.
2. On a candidate database, run `node cli/node_modules/tsx/dist/cli.mjs scripts/lines-adopt.ts --company <company UUID> --roots-file <roots.json> --output <manifest.json>`. This is a read-only dry run. Review every `memberIssueIds` list and conflict in the manifest. Remove ambiguous or conflicting roots, then repeat the dry run.
3. Jarvis obtains a `request_board_approval` record for the exact manifest with `payload.kind = "lines_adoption"` and `payload.manifestSha256 = "<SHA-256 of the exact manifest file>"`. Record the approved row's UUID after a board user decides it. A caller-supplied approval string without that decided row is rejected. This engineer step does not authorize running the apply command on production.
4. Once approved in a separate task, run `node cli/node_modules/tsx/dist/cli.mjs scripts/lines-adopt.ts --apply --company <company UUID> --manifest <approved manifest.json> --approved-sha256 <approved digest> --approval-reference <approved approval UUID> --output <checkpoint.json>`. Each root is a transaction; the checkpoint is written after each batch of ten roots and at the end. The transaction rejects a child added after the manifest check, even if it appears before apply obtains the lock. Repeating the command returns `already_grouped` for completed roots.
5. Reconcile the checkpoint against `GET /api/lines/{lineId}` and `GET /api/companies/{companyId}/issues?lineId={lineId}`. Confirm the visible member count and that hidden naming tasks do not affect progress. Review failed names through `lastNamingErrorCode` and the retry endpoint.

## Rollback and reconciliation

Revert only application code through the governed deployment process; leave the additive Line table and nullable issue column in place. The old application ignores them. Do not run a migration that drops Line data. To correct a partial adoption, re-run the approved manifest after resolving reported conflicts; already-grouped roots are idempotent. If a wrong root was approved, stop further adoption and ask Jarvis for a reviewed corrective migration. There is no Line hard delete or automatic membership erasure.
