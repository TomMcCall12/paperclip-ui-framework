# Lines V1: data and API contract

This document is the contract for the Line server and UI work. The foundation migration adds an empty `lines` table and nullable `issues.line_id`. It does not group historical tasks or call a model. The server implementation is in the repository but requires a separate governed release; see [the rollout and historical adoption procedure](./LINES-ROLLOUT.md).

## Identity and membership

A Line is one company-scoped assembly-line root issue and all its visible descendants. `lines.id` is a UUID. `(company_id, root_issue_id)` is unique, so concurrent creation or a repeated POST for the same root returns the same Line. Duplicate names are permitted; display the root identifier beside each name. `issues.line_id` is nullable. Null means ungrouped, including every pre-migration issue.

The server owns membership. On creation, it sets the root and existing descendants in one transaction. Later child creation inherits the nearest ancestor Line. A move or reparent operation must recalculate affected descendants transactionally, reject cross-company or cyclic parentage, and preserve existing issue permissions, assignment, checkout, blockers, approval gates, pause/budget checks, and activity logging. Normal issue create/update payloads cannot set `lineId`. Issue read responses may omit `lineId` during mixed-version deployment; new readers treat omission as null. List filtering uses `lineId=<UUID>` or `lineId=ungrouped`; these are mutually exclusive values of one parameter. An invalid UUID yields 400. A Line in another company yields 404 without disclosing it.

Database constraints enforce the company match for root, naming issue, creator and naming runs, and every member's `line_id`. A foreign key cannot prove that every member descends from the root; the server validates ancestry in the same transaction. A root cannot be deleted while its Line exists. V1 has no Line hard delete or manual name edit.

## Reads and lifecycle

`GET /api/companies/:companyId/lines?status=active|completed|archived|all&q=&limit=25&cursor=` returns `{ "items": Line[], "nextCursor": string|null }`. `limit` is 1–100; default 25. Default status is `active`. `q` is trimmed, at most 200 characters, and case-insensitive across name, root title, and root identifier. Apply company scope and search before pagination. Sort by `updatedAt DESC, id DESC`; the opaque cursor contains both keys and the normalized filters, and a cursor/filter mismatch yields 400. Use keyset pagination with a limit-plus-one query. Status filters are disjoint: `archived` means `archivedAt != null`; `active` means not archived and not completed; `completed` means not archived and completion status `completed`; `all` includes every Line. A cancelled root remains in `active` until archived, with `completionStatus: "cancelled"`, so cancellation never appears as successful completion.

`GET /api/lines/:lineId` returns the same Line view, with current derived progress. `404` covers unknown and inaccessible Lines. `Line` includes `id`, `companyId`, `rootIssueId`, `rootIdentifier`, `rootTitle`, nullable `name`, `displayName`, naming state/provenance, server-derived `createdByType`, `createdByAgentId`, `createdByUserId`, and `createdByRunId`, `completionStatus`, `visibleIssueCount`, `terminalIssueCount`, nullable `archivedAt`, and timestamps. A null `name` renders as `Line <root identifier>`; this is explicitly a temporary label. The display label is derived and is never stored as a generated name.

Completion is derived at read time: the root is `done` and every visible member is terminal (`done` or `cancelled`). A cancelled root has `completionStatus: "cancelled"` even if every descendant is terminal. Otherwise it is `active`. Hidden naming tasks (`namingIssueId` and other issues with hidden state) are excluded from counts and completion. `visibleIssueCount` includes the root. The archive state is separate from completion.

`PATCH /api/lines/:lineId` accepts exactly `{ "archived": true|false }`, returns the updated Line, and records actor/run attribution in activity. Archive and unarchive are idempotent. Archiving does not alter issues, cancel runs, or pause naming. Other fields, including `name`, return 400; hard delete is unavailable. An inaccessible Line returns 404.

## Creation and naming

`POST /api/companies/:companyId/lines` accepts `{ "rootIssueId": "<UUID>" }` and returns a Line with `201` for a new row or `200` for an existing root. A root from another company or invisible to the caller returns 404. An ineligible root (hidden, a descendant already belonging to a different Line, or an ancestor of another Line) returns 409. Transactionally select/lock the root, verify the full subtree and current actor permissions, insert with conflict on `(company_id, root_issue_id)`, and set membership. Store creator type, agent/user, and run from authenticated server context; do not accept them from the request. Initial state is `pending`, version 0, attempts 0, null name/provenance. Queue naming only after commit and only when budget/pause/approval policy permits.

Naming uses GPT/OpenAI only. The server creates a hidden naming issue in the same company and binds `namingIssueId`; it does not count toward progress. A claim changes `pending|failed` to `generating`, increments `namingVersion` and `namingAttempts`, and records any retry schedule. A successful result is plain text with 2–6 words, normalized to single spaces, at most 80 characters, and no markup. Invalid output fails the attempt with a safe error code; never persist raw model output or secrets. `namingModel`, `namingRunId`, and `namedAt` come only from the trusted runtime record. They are null until a successful naming result. Failed attempts set `lastNamingErrorCode`, `nextNamingAttemptAt` for bounded backoff, and `namingStatus: "failed"`; they retain a prior valid name if one exists.

`POST /api/lines/:lineId/naming/retry` accepts `{}`. It returns `202` with the Line; repeated requests while one generation is active coalesce onto that attempt. It does not accept a name, model, or run. Automatic and manual retries increment the version only on a successful claim, so stale results cannot overwrite a later attempt. Budget and pause policy continue to apply to the hidden task's dispatch.

`POST /api/lines/:lineId/naming/result` is run-bound. It accepts `{ "namingVersion": 1, "namingIssueId": "<UUID>", "runId": "<UUID>", "name": "Customer Intake Flow" }`. The server requires an authenticated run matching the body `runId`, the Line's company, current `namingIssueId`, and claimed `namingVersion`; it reads the model from that run's trusted provider metadata and requires OpenAI/GPT. A stale version, wrong run, or wrong naming issue returns 409 (or 404 across companies). Duplicate delivery of the identical accepted result returns 200 with the current Line. A conflicting replay returns 409. Invalid name returns 422. Successful transition to `ready` clears retry/error fields, writes activity, and returns 200 with the Line. This endpoint is inaccessible to ordinary board and agent keys without matching run authority.

## Error shape and examples

Use the existing API error envelope `{ "error": "message", "code": "machine_code" }` where supported. `400` covers malformed parameters and forbidden fields; `401` missing authentication; `403` actor lacks company or action permission; `404` unknown/inaccessible root or Line; `409` ancestry, existing membership, state, or stale naming conflicts; `422` invalid model result or policy precondition; `429` budget/rate stop; `500` unexpected failures. Preserve existing activity and audit conventions for all writes.

Example list item (abbreviated):

```json
{
  "id": "c8e96d44-a038-4b95-a766-29bdff49d5a8",
  "companyId": "c1c1abcf-66c0-4d4d-8d42-5681766850a2",
  "rootIssueId": "94a74808-3e7e-45c9-b219-a7191c4f4088",
  "rootIdentifier": "TOM-494",
  "rootTitle": "Add Lines",
  "name": null,
  "displayName": "Line TOM-494",
  "namingStatus": "pending",
  "namingVersion": 0,
  "namingIssueId": null,
  "namingAttempts": 0,
  "nextNamingAttemptAt": null,
  "lastNamingErrorCode": null,
  "namingModel": null,
  "namingRunId": null,
  "namedAt": null,
  "createdByType": "agent",
  "createdByAgentId": "7e04df61-5d1d-4239-8d61-5f34684e510a",
  "createdByUserId": null,
  "createdByRunId": "1d49b08f-c047-4ffd-bd9c-d199e638296d",
  "completionStatus": "active",
  "visibleIssueCount": 3,
  "terminalIssueCount": 1,
  "archivedAt": null,
  "createdAt": "2026-10-15T12:00:00.000Z",
  "updatedAt": "2026-10-15T12:00:00.000Z"
}
```

Repeated creation example: POST the same `rootIssueId` twice; the second response is `200` and has the first response's `id`. Concurrent inserts rely on the database uniqueness constraint, then re-read the winning row.

## Rollout and rollback

The migration creates only an empty table, nullable issue column, indexes, checks, and foreign keys. It has no backfill and performs no inference. Old application code may continue to run against the expanded schema and leaves Line data untouched. A later rollback of application code does not drop the table or column. Production migration and deployment require a separate governed step.
