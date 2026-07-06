# To test (QA)

Tasks the developer has implemented and moved here, awaiting end-to-end QA
verification. On pass the planner moves the task to `TOCODEREVIEW.md`; on reject
it goes back to `TODO.md` with findings attached.

Keep the original task ID. Format:

```markdown
- ☐ `10005` **Title** — original description.
  - **Done:** <one-line summary, with key file paths>.
```

## Phase 1 — Core app + CI

_(empty)_

## Phase 2 — Sync engine + CD

- ☐ `20002` Webhook ingestion endpoint: JSON-schema validation of inbound QBO payloads (Fastify schema), signature verification
  - **Done:** `POST /api/integrations/qbo/webhook` — public route (no session; the signature is the auth), strictly receive → verify → validate → record receipt, no `SyncLink`/`Transaction` writes (later tasks). **Signature verification** (`apps/api/src/qbo/webhook-signature.ts`, `verifyWebhookSignature`) — `timingSafeEqual` base64 HMAC-SHA256 of the raw body against `intuit-signature`, mirroring `qbo/oauth-state.ts`'s constant-time style. Verified over the **raw request bytes** via an encapsulated Fastify content-type parser registered only inside `apps/api/src/routes/qbo-webhook.ts` (Fastify scopes content-type parsers to the registering plugin instance, so the global `application/json` parser used by every other route — proven by a regression test hitting `POST /api/auth/login` — is untouched). New env `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN` → `config.qbo.webhookVerifierToken` (`apps/api/src/config.ts`, independently nullable from the OAuth trio), injectable via `BuildAppOptions.qboWebhookVerifierToken` / `qboPlugin` (`apps/api/src/plugins/qbo.ts`, `apps/api/src/app.ts`) so tests sign with a known token — no live Intuit needed. **Fails closed**: no token → `503 qbo_webhook_not_configured`. Bad/missing signature → `401 invalid_signature`. Malformed JSON → `400 invalid_json`; wrong shape (missing `eventNotifications`) → `400` via the Fastify `schema.body` (`apps/api/src/qbo/webhook-types.ts`, `webhookBodySchema` + `parseWebhookNotifications`). Unknown `realmId` (no matching `QboConnection`, via new `getConnectionByRealmId` in `apps/api/src/qbo/connection-service.ts`) → `200` acked + `app.log.warn`, no audit row (avoids Intuit retry storms on a stray realm). Known realm → one `sync_audit_logs` receipt row per notified entity (`direction:'inbound'`, `action:'qbo.webhook.received'`, `triggeringEvent: realmId:entityName:qboId:operation`) via the existing `writeAuditLog`. `docs/design-decisions.md` extended with a "QBO webhook ingestion" section; `.env.example` documents the new var (AWS SSM Parameter Store in deployed envs). **Verified:** `pnpm -r typecheck` clean, `pnpm -r test` 205 api (was 186) + 50 web green, `biome ci` clean (pre-existing unrelated `.claude/settings.local.json` baseline error untouched), `docker build` clean, web build still emits exactly the 3 prerendered pages. Live Intuit sandbox webhook delivery is user-gated (phase-end, needs a public URL + the real verifier token).
