# AutoSignUp — load-test user seeder for atlasagents-app (plan)

*Revised 2026-10-07 (v2). **Built** — README.md is now the source of truth for behaviour and deploy. v2 replaced one-shot seeding with an email pool + scheduled jobs (random signup times, verify %, daily cap), runs on the prod server next to the app, and matches the app's signup rows including the pending VerificationToken. The screens/build-order below describe v1 and are kept for history.*

## What it is

A **standalone** app with its own UI that creates 800–900 pre-verified users
from a list of email addresses. It exports their credentials, logs them in to
stress-test atlasagents-app, and deletes them all afterwards.

**Kept separate from `[APP]`:**
- Its own git repo (`git init` in `AutoSignUp/`) and its own `package.json`.
  It never imports from `atlasagents-app/`, and nothing is committed there.
- Its only connection to `[APP]` is the target's `DATABASE_URL` and base URL,
  entered in the UI.
- It runs on port **3003** (`[APP]` uses 3000, `[WEB2]` 3002) and can run
  next to a local `[APP]` dev server.

## Why it writes to the DB directly instead of calling `/api/register`

The public signup route (`src/app/api/register/route.ts`) is the wrong tool
for 900 accounts:
- it is rate-limited to **5 signups per IP per hour**
- it requires a Turnstile token
- it sends a verification email per account, which would be 900 real emails

So the seeder inserts rows the way `scripts/make-admin.ts` does: a `User`
with a `bcryptjs` cost-10 hash and `emailVerified = now()`, plus the
`Team` + `Membership` rows that `getOrCreatePersonalTeam` would create. That
needs no change to `[APP]`, and it fires no PostHog or ad conversions.

**Schema drift guard:** before each run, the app reads `information_schema`
for `User`, `Team` and `Membership` and refuses to run if a column it writes
is missing or if a new NOT NULL column has appeared.

## Target: production (decided 2026-10-03)

The target is the production `[APP]`. These guardrails are therefore
**required, not optional**:

- **Seeded users can't deploy.** Every insert sets `freeAgentLimit = 0`
  (the per-user override in `User`, `src/lib/free-tier.ts`). Without it, each
  seeded account could start up to 3 real VMs.
- **Seeded users are identifiable.** Emails use a fixed pattern on a domain
  you control (for example `loadtest+0001@atlasagents.dev`), and `name` is
  `loadtest-<batchId>-0001`. Admin views and metrics can then be filtered, and
  no real inbox gets password-reset or notification mail.
- **Cleanup is built and tested before the first full run.** It deletes
  exactly the ids recorded locally, never by pattern.
- **DB access goes over an SSH tunnel.** Prod Postgres listens on
  `127.0.0.1` (see `scripts/bootstrap-pg.sh`), so the UI connects through
  `ssh -L 5433:127.0.0.1:5432 <prod-host>`. The DB port is not opened publicly.
- **Confirmation required.** A non-localhost target requires typing the
  hostname. Runs are capped at 1000 rows.
- **Ramp up.** Run 10 users first, then 100, then 900, and check the admin
  dashboard and error logs between steps.

### Decided 2026-10-07

- The tool **seeds** users; it does not sign up through the form and does not
  log in. The login rate limit (`src/auth.ts:115-116`) and login Turnstile are
  therefore irrelevant, and no `LOADTEST_TOKEN` bypass is added to `[APP]`.
- Emails are the operator's own **supplied list** (real test addresses), not
  generated `loadtest+NNNN` ones. No mail is sent to them: direct inserts fire
  no verification, notification, PostHog or ad events.
- Only the production `[APP]` is a valid target; the tool refuses anything else.

## Screens (simple tasks)

1. **Target.** Enter `DATABASE_URL` (through the SSH tunnel) + base URL, press *Test connection*,
   and the schema check runs.
2. **Emails.** Paste a list, upload .xlsx/.csv, or *Generate N* (for example
   `loadtest+0001@yourdomain.test`). Duplicates and invalid addresses are
   removed. Extra columns such as Name and Location pass through to the export.
3. **Enroll.** The dry run shows new / already-exists, and existing users are
   never touched. Then insert in batches of 100 inside a transaction, with a
   progress bar. Each run has a `batchId`, and every created id is recorded in
   local SQLite.
4. **Export.** Download .xlsx/.csv with Email, Password, Name, Location,
   Batch, Created at, and Login URL. Passwords are 14 random characters
   (`crypto.randomInt`, no look-alike characters).
5. **Cleanup.** *Delete batch* removes exactly the recorded user ids. `Team`
   rows go with them via `ON DELETE CASCADE`; check `Membership` and other
   child tables in the same pass. A confirmation shows the row count first.

## Stack

Next.js 16 + Tailwind, `pg`, `bcryptjs`, `exceljs`, `zod`, `@paralleldrive/cuid2`.
As built: run history is one JSON file per batch under `data/batches/`
(not SQLite), and the UI uses plain Tailwind components (not shadcn).

## Build order

| # | Step |
|---|------|
| 1 | Scaffold repo, Target screen, connection + schema check |
| 2 | Emails screen (paste / upload / generate) |
| 3 | Enroll + local batch records |
| 4 | Export |
| 5 | Cleanup (built before anything runs at full scale) |
| 6 | Prod run: supplied list, small batch first, checking admin and logs |
