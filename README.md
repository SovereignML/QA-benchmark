# AutoSignUp

QA tool that schedules **test signups straight into the production Atlas Agents
database** (`app.atlasagents.dev`). Each account is written exactly as the real
signup form leaves it, minus the email, PostHog and ad-conversion side effects,
and AutoSignUp keeps a full record of every user it creates.

Standalone: own repo, own `package.json`, never imports from `atlasagents-app`.
Runs on the prod server next to the app, bound to **127.0.0.1:3003**.

## How it works

1. **Email pool** — import any number of emails (Excel template, CSV or paste).
   Emails already registered on prod are marked and never used.
2. **Schedule** — "N users, starting at T, over H hours". Each user gets a random
   signup moment in the window. A chosen % verify their email a random
   2–240 min later (skewed short; max 23 h because the real token lives 24 h);
   the rest stay unverified, like people who never click the link.
3. **Daily cap** (default **300/day**, editable, counted in `AUTOSIGNUP_TZ`) —
   a schedule that would exceed it on any day is refused up front; if the cap is
   hit at run time anyway (e.g. lowered later), the signup moves to the same
   time next day.
4. **Scheduler** — runs inside the server, every 10 s, ≤ 20 events per tick.
   Pause / resume (overdue signups spread over the next hour) / cancel (unused
   emails go back to the pool).
5. **Records** — Excel/CSV of every user: email, password, name, stage, planned
   / signed-up / verified / deleted times, prod user + team ids, job.
6. **Delete from prod** — per schedule; deletes exactly the recorded ids.

## What each signup writes (matches `atlasagents-app`)

| Step | Rows | Source in atlasagents-app |
|---|---|---|
| Signup | `User` (name, email, bcrypt-10 hash, `emailVerified` NULL, all else default) | `src/app/api/auth/register/route.ts` |
| | `Team` "<name>'s Team" + `Membership` owner | `src/lib/team.ts` `getOrCreatePersonalTeam` |
| | `VerificationToken` `email-verify:<email>`, sha256 of 32 random bytes, +24 h | `src/lib/email-verification.ts` |
| Verify | `User.emailVerified` + `updatedAt` = now; token deleted | `src/app/api/auth/verify-email/route.ts` |

Timestamps use the same rules as the app: `createdAt` from Postgres' default,
JS-set columns as UTC (how Drizzle writes them).

**One deliberate difference:** `freeAgentLimit` defaults to **0** so a test account
can never start a billed VM. Set it blank in the form for the platform default.

## Deploy on the prod server (bare metal, next to atlasagents-app)

```bash
# 1. Code
sudo mkdir -p /opt/autosignup /var/lib/autosignup
sudo chown -R $USER /opt/autosignup /var/lib/autosignup && chmod 700 /var/lib/autosignup
git clone <this repo> /opt/autosignup          # or rsync the folder
cd /opt/autosignup && npm ci && npm run build

# 2. Least-privilege DB role (recommended)
sudo -u postgres psql -d sovereignml -v pw="'<strong password>'" -f deploy/create-role.sql

# 3. Env
cp .env.example .env && chmod 600 .env && nano .env   # DATABASE_URL, AUTOSIGNUP_TZ, AUTOSIGNUP_DATA_DIR

# 4. Run (pick one)
pm2 start deploy/pm2.config.cjs && pm2 save
#   or: sudo cp deploy/autosignup.service /etc/systemd/system/ && sudo systemctl enable --now autosignup
#       (create the `autosignup` user and chown /opt/autosignup + /var/lib/autosignup to it first)
```

Open it from your laptop:

```bash
ssh -N -L 3003:127.0.0.1:3003 <prod-host>      # then browse http://127.0.0.1:3003
```

It is never exposed publicly: it binds to 127.0.0.1 and refuses requests whose
Host isn't localhost, plus cross-origin POSTs.

**Run exactly one process** (pm2 fork mode, 1 instance). The scheduler and the
record files assume a single writer.

Upgrade: `git pull && npm ci && npm run build && pm2 restart autosignup`.
Schedules survive restarts; events that fell due while it was down run on the
next ticks (≤ 20 per 10 s), and a verification that missed the 24 h token
window is skipped, as it would be for a real user.

## Safety rails

| Rail | Where |
|---|---|
| DB host must be 127.0.0.1 / localhost; DB must carry the atlasagents-app tables | `src/lib/target.ts`, `src/lib/schema-check.ts` |
| Schema drift check (missing column / new NOT NULL column) before every write path | `src/lib/schema-check.ts`, `src/lib/db.ts` |
| Type `app.atlasagents.dev` to schedule and to delete | `src/lib/plan.ts`, `src/lib/cleanup.ts` |
| Daily cap at plan time and run time | `src/lib/plan.ts`, `src/lib/scheduler.ts` |
| Existing emails (case-insensitive) never touched | `src/lib/pool.ts`, `src/lib/executor.ts` |
| Delete by recorded id **and** email; refuses if the count changed since review | `src/lib/cleanup.ts` |
| Delete holds back users with agents, BYOS servers, subscriptions, wallet balance or other team members | `src/lib/cleanup.ts` |
| Restricted DB role can only touch User/Team/Membership/VerificationToken | `deploy/create-role.sql` |

## Records

`$AUTOSIGNUP_DATA_DIR` (default `./data`): `jobs/*.json`, `pool.json`,
`settings.json`, mode 600 in a 700 folder. The job files are **the** record of
every test user, including plain-text passwords, and delete depends on them.
Back the folder up; never commit or share it.

## Develop locally

```bash
npm install
ssh -N -L 5433:127.0.0.1:5432 <prod-host>   # or point at a local copy of the schema
echo 'DATABASE_URL=postgresql://…@127.0.0.1:5433/sovereignml' > .env
npm run dev                                   # http://127.0.0.1:3003
```

Set `AUTOSIGNUP_SCHEDULER=off` to run the UI without the scheduler.
