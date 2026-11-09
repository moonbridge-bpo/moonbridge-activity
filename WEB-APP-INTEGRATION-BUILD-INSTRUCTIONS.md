# MoonBridge web app integration build instructions

## Task for the AI working on the web app

Implement the backend and web UI needed to connect the existing **MoonBridge Activity** Windows desktop app to MoonBridge's authenticated timecard system. The web repository is remote from this document. Inspect its current structure and repository instructions before editing; use the existing auth, site access, clock, break, migration, and UI patterns. Deliver working code, migrations, tests, and staging evidence, not just a design.

Work in a development branch or isolated checkout. Use a staging database for migrations and end-to-end testing. Do not modify or deploy the live production environment as part of this task.

## Existing desktop behavior

- The desktop app asks the worker for a MoonBridge **HTTPS origin**. Plain HTTP is accepted only for `localhost` or `127.0.0.1`.
- It generates a stable `deviceId` beginning with `PC-`. This ID identifies an installation; it is not proof of a worker's identity.
- It displays a six-digit pairing code. The worker approves that code in their authenticated MoonBridge web session while clocked in.
- After pairing, the desktop samples Windows keyboard/mouse idle time every 10 seconds. Its idle threshold is five minutes. It sends only `active`/`idle` intervals; it does not collect screenshots, typed text, or app content.
- It queues unsent intervals locally with stable UUID event IDs and retries batches of up to 100. A successful HTTP 200 means the **whole batch** was accepted.
- During a recorded break, sampling pauses. On a pairing/shift `401`, the desktop stops attribution and holds unsent intervals locally for review.
- “Change worker” stops local attribution immediately, holds unsent intervals for review, and retries revocation. The next worker must pair online.
- An installed app registers `moonbridge://open`. This deep link opens or focuses the app. It must carry no credentials or personal data.

## Required API contract

Use JSON request and response bodies. Every successful response must contain valid JSON, including signout. Errors should have an `error` string.

| Method and path | Request | Required response |
| --- | --- | --- |
| `POST /api/desktop/pair/start` | `{ "deviceId": "PC-..." }` | **201** `{ "code": "123456", "expiresInSeconds": 300 }` |
| `POST /api/desktop/pair/complete` | `{ "code": "123456", "deviceId": "PC-..." }` | **409** while pending; after approval, **200** `{ "token": "...", "pairingId": "<uuid>", "userId": "<uuid>", "shiftId": "<clock-record-uuid>", "workerName": "..." }` (`workerName` may be omitted) |
| `GET /api/desktop/context` | `Authorization: Bearer <desktop-token>` | **200** `{ "onBreak": false, "lastBreakEndAt": null }`; when present, `lastBreakEndAt` is a Unix **millisecond** timestamp |
| `POST /api/desktop/activity/batch` | Desktop bearer token and `{ "events": [{ "id": "<uuid>", "kind": "active", "startMs": 1700000000000, "endMs": 1700000010000 }] }` | **200** with JSON only after every event is accepted or confirmed as an identical prior retry |
| `POST /api/desktop/signout` | Desktop bearer token and `{}` | **200** with JSON after revocation; do not return 204 |

`kind` is exactly `active` or `idle`. `startMs` and `endMs` are Unix milliseconds. Return **401** from `/context` when the pairing is revoked or the shift is closed. A short-lived token policy requires a desktop refresh flow that does not currently exist; keep a revocable token valid for the active shift until that flow is added.

## Web approval endpoint and UI

Add `POST /api/desktop/pair/approve` for the authenticated web worker. It receives `{ "code": "123456" }`. Require the existing login/MFA session and verify the caller has an open clock record. Derive `userId`, `shiftId`, `siteId`, and `clientId` from server-side records. Verify the selected site matches the open record. Do not accept those identity or scope values from the desktop or approval request body.

Add a **Pair MoonBridge Activity** panel beside the existing worker clock controls. Include:

1. **Open desktop app**, linked to `moonbridge://open`.
2. Six-digit code entry and a confirmation showing the device being paired.
3. Clear pending, expired, already-used, wrong-site, no-open-shift, and connected states.
4. A way to view and revoke the active desktop pairing.

Use the existing frontend API client and site selection behavior. Browser code must never receive or display the desktop bearer token.

## Backend and persistence

Add versioned database migrations for pairing codes, pairings, intervals, and audit records. Link each pairing to the existing open `clock_records` row and retain the resolved site and client scope. Store hashes of pairing codes and opaque desktop tokens. Codes must expire after five minutes, be one-use, and have attempt limits. Rate-limit code issuance and guesses. Enforce one active pairing per device and, initially, one active device per shift. Revoke pairings on handoff and clock-out.

Desktop bearer tokens are separate from web login JWTs. Mount and validate the device routes without passing their tokens through middleware that expects a web JWT. Keep the web approval route behind normal web auth and site access checks. The device-token middleware must resolve the stored pairing, current shift, worker, site, and client on every request and fail closed when revoked or invalid.

For each activity batch, validate UUIDs, interval ordering, reasonable duration and clock skew, shift bounds, break overlap, device/pairing ownership, and duplicates. Make batch acceptance **transactional and idempotent**: an identical retry returns 200; a conflicting duplicate or invalid batch returns an error without partially acknowledging it. Record server receipt time and upload delay. Never log raw codes or tokens.

## Timecard report

Expose an authorized report endpoint, for example `GET /api/timecard/idle-report`, and a corresponding MoonBridge timecard view. Scope worker views to their own data and manager views to authorized site/client data. Aggregate `active`, `idle`, canonical break/lunch time, and **unverified gaps** per clock record. Show device, event time, receipt time, upload delay, pairing/revocation history, and rejection reasons for dispute review.

Keyboard/mouse activity is supporting evidence. Keep the existing paid-hours and payroll calculations authoritative. Do not count missing intervals as idle. Intervals held only on the desktop after a closed shift cannot appear in the server report automatically; mark the uncovered period unverified.

## Acceptance and handoff

Test on staging with the actual installed Windows app:

1. Clock in on MoonBridge, generate a desktop code, approve it in the web app, and confirm pairing.
2. Confirm real `active` and `idle` intervals reach PostgreSQL and appear in the report.
3. Start and end a break; confirm break time is shown from timecard records and activity is not counted through it.
4. Retry the same event batch; confirm one stored row per event ID and a 200 acknowledgement.
5. Clock out and verify the pairing is revoked and `/context` returns 401.
6. On a shared PC, change from worker C to worker A; confirm no interval is attributed to the wrong worker.
7. Disconnect and reconnect the network; show queued upload delay and unverified gaps accurately.
8. Cover unauthorized site, expired/reused code, token revocation, malformed interval, and batch rollback tests.

Provide the migration instructions, API examples, changed-file summary, test results, and a staging walkthrough. Identify any exact contract mismatch that would require a desktop change before claiming integration complete.
