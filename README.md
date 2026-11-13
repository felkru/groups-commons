# Groups Commons (prototype)

A shared place for the materials AI safety university groups keep re-making: slides, flyers, message templates,
tabling kits, suppliers. Built as a prototype to test the technically risky parts of the idea.

The live instance is internal for now; ask the maintainers for the link.

## What is in here
- `server/`: Express API. `index.js` (routes), `store.js` (storage: local files, or Firestore + Cloud Storage), `store-pg.js`
  (storage: PostgreSQL + Cloud Storage), `files.js` (file bytes: a folder or a bucket), `rank.js` (hot / best / top),
  `ingest.js` (validation), `ai.js` (Vertex AI: embeddings for search, Gemini for logo suggestions), `preview.js` (thumbnails).
- `server/accounts.js`: accounts (user name + password, signed session tokens). Hosted group websites (`/s/<name>`), the
  leaderboard, page previews for PDFs and Office files (LibreOffice) and AI logo marks live in `index.js`, `preview.js` and `ai.js`.
- `public/`: the website, plain ES modules, no build step. `template.js` is the in-browser template editor; `more.js` has the
  account, moderation and leaderboard pages.
- Getting it into people's assistants: `public/agent.js` is the "Set up my AI" questionnaire (button in the header) and the
  Contribute page. Its result is one command for a setup script that `server/setup.js` writes per request from
  `server/setup.sh.tmpl` (macOS, Linux, WSL) and `server/setup.ps1.tmpl` (Windows): `/setup.sh?agent=claude-code&install=1&cli=1&skill=1`.
  The values a script address may carry are checked in `public/setup-fields.js`, shared by both sides. `/llms.txt` describes
  the site to assistants that can open web pages.
- `cli/commons.mjs`: one-file CLI (`commons search | get | add | convert | ...`). `skill/SKILL.md`: Claude Code skill that uses it.
- `skill/TEMPLATE.md`: the template contract, what makes an HTML file a re-brandable template (served at `/cli/TEMPLATE.md`,
  printed by `commons contract`). `docs/SEED_FORMAT.md`: the material folder format.
- `server/convert-pdf.js`: PDF -> template converter (poppler, no AI). The server does not run it: it is served as a
  download at `/cli/convert-pdf.mjs` and runs on the organizer's computer, see "Printables become templates" below.
- `seed/`: the materials themselves. They are not part of this repository (they include a group's internal originals);
  the format is described in `docs/SEED_FORMAT.md`.
- `server/ops.js`, `server/log.js`: health check, start and shutdown, response headers, structured logs.
- `test/`: automated tests (`npm test`), run on every push by `.github/workflows/test.yml`.
- `infra/commons.tf`: the OpenTofu definition of the deployment (a copy; the applied file lives with the other infrastructure).
- `SECURITY.md`: how uploads are kept harmless, what moderators can do, how to report a problem.

## Run locally
```
npm install
STORE=local PORT=8787 ADMIN_TOKEN=dev node server/index.js          # add VERTEX=1 for semantic search and logo suggestions (uses gcloud ADC)
COMMONS_URL=http://localhost:8787 COMMONS_TOKEN=dev node cli/commons.mjs add seed/*/ --stats seed/_stats.json
npm test                                                            # local store in a temporary folder, no cloud access
npm run test:pg                                                     # the same tests on the PostgreSQL store (PGlite, nothing to install)
python3 tools/test-setup-sh.py http://localhost:8787               # runs /setup.sh in a sandbox with stub claude, codex and npm
```
`/setup.ps1` has a test for Cloud Build (PowerShell 7 on Linux, stub programs): `tools/test-setup-ps1.cloudbuild.yaml`.

Two things are not in this repository: the materials (`seed/`, a group's own originals and photos; `docs/SEED_FORMAT.md`
describes the folder format) and the intro video (`public/assets/intro.mp4`, which shows them; `tools/intro-video/README.md`
says how it is made). A copy without them starts empty and shows the intro without the video. `.gcloudignore` keeps the
video in the build upload.

## Printables become templates (on the organizer's computer)
The site does not convert files. Turning a finished flyer or poster into a re-brandable template is done by the
organizer's own assistant, locally:
- **PDF:** `commons convert flyer.pdf --out my-flyer` downloads `server/convert-pdf.js` from the site
  (`/cli/convert-pdf.mjs`) into `~/.cache/commons/` (`COMMONS_CACHE` changes the folder; the copy is checked against
  the site once a day by ETag, `--refresh` fetches it again) and runs it there. It needs poppler on the
  PATH (`brew install poppler`, `sudo apt install poppler-utils`, `winget install oschwartz10612.Poppler`); `sharp` is
  optional. It writes `template.html` and an `item.json` skeleton. The assistant then marks the group's logo and name
  (`skill/SKILL.md` says how, `--logos` makes a first guess) and shares the folder with `commons add my-flyer`.
- **Picture, or no PDF:** `commons convert poster.png` converts nothing and prints how to rebuild the design by hand
  from the template contract (`commons contract`).
- **No terminal** (Claude app with the MCP connector): the assistant writes the HTML from `/cli/TEMPLATE.md` and
  shares it with the `share_material` tool.

`tools/convert-test.mjs` checks the converter against real PDFs (needs poppler, ffmpeg and Chrome).

## Deploy (Google Cloud, prod project, managed with OpenTofu)
Infrastructure is defined in `infra/commons.tf`: Cloud Run service `commons-web`, Firestore database
`commons`, bucket `cs-project-tvcmny79-commons`, secret `commons-admin-token` (the moderator token).
```
gcloud builds submit --project cs-project-tvcmny79 --region us-central1 --tag us-central1-docker.pkg.dev/cs-project-tvcmny79/apps/commons-web:$(git rev-parse --short HEAD) .
# set the tag in images.auto.tfvars, then in the tofu directory: tofu plan -out=tfplan, tofu apply tfplan
```
All materials are added through the CLI: `commons login --url <site> --token <moderator token>`, then `commons add <folder>`.

## Running it
Everything below is for the prod project `cs-project-tvcmny79`, region `us-central1`. Infrastructure changes go through
OpenTofu (`tofu plan -out=tfplan`, read the summary, `tofu apply tfplan`); secret values are set with `gcloud`.

### Settings
| Variable | Meaning |
| --- | --- |
| `STORE` | `pg` (PostgreSQL + Cloud Storage), `gcp` (Firestore + Cloud Storage) or `local` (files under `DATA_DIR`, default `./data`). |
| `BUCKET` | The bucket for file bytes (`STORE=pg` and `STORE=gcp`). With `STORE=pg` and no bucket, files go to `DATA_DIR/files`. |
| `FIRESTORE_DB` | Database name for `STORE=gcp` (and for the migration tool). Default `commons`. |
| `CLOUDSQL_INSTANCE`, `CLOUDSQL_IP_TYPE` | `STORE=pg` through the Cloud SQL connector: `project:region:instance`, and which address to use: `PRIVATE` (default), `PUBLIC` or `PSC`. |
| `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Database user, password (a secret) and database name. |
| `PGHOST`, `PGPORT`, `PGSSLMODE` | `STORE=pg` without the connector: an address, a name or a socket folder (`/cloudsql/project:region:instance`). `PGSSLMODE=require` encrypts without checking the certificate (the mode for a bare private address); `verify-ca` / `verify-full` check it against `PGSSLROOTCERT`. |
| `DATABASE_URL` | `STORE=pg` with everything in one address (`postgres://user:password@host:5432/database`). Wins over the two rows above. |
| `PG_POOL_MAX`, `PG_SCHEMA` | Optional. Connections per instance (default 5) and a schema to keep the tables in (default `public`). |
| `ADMIN_TOKEN` | The moderator token. Whoever holds it is a moderator. Secret `commons-admin-token`. |
| `SESSION_SECRET` | Signs sign-in sessions, preview links of hosted sites and file keys. Secret `commons-session-secret`. Without it the key is derived from `ADMIN_TOKEN` (and a warning is logged). |
| `VERTEX` | `1` switches on semantic search and logo suggestions. |
| `PUBLIC_URL` | The site's address, if it should not be taken from the request. |
| `LOG_FORMAT` | `json` or `text`. Default: `json` on Cloud Run, `text` elsewhere. |

### Deploy
1. `npm test`
2. `gcloud builds submit --project cs-project-tvcmny79 --region us-central1 --tag us-central1-docker.pkg.dev/cs-project-tvcmny79/apps/commons-web:$(git rev-parse --short HEAD) .`
3. Set the tag in `images.auto.tfvars`, then `tofu plan -out=tfplan` and `tofu apply tfplan` in the tofu directory.

A new revision takes traffic only after `GET /api/health` answered 200 on it, that is, after it reached the database and
the bucket. If it never does, the previous revision keeps serving and the apply fails. To go back, set the previous
tag in `images.auto.tfvars` and apply. On shutdown (SIGTERM) an instance stops accepting connections, finishes the
requests it has and exits.

### Rotate the moderator token and the session secret
Both are Secret Manager secrets, read as `latest` when an instance starts. Add a version, roll out a new revision,
then disable the old version.
```
openssl rand -base64 32 | tr -d '\n' | gcloud secrets versions add commons-admin-token --project cs-project-tvcmny79 --data-file=-
openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add commons-session-secret --project cs-project-tvcmny79 --data-file=-
# in the tofu directory: set commons_secrets_rotated = "<today>" (a .auto.tfvars file), tofu plan -out=tfplan, tofu apply tfplan
gcloud secrets versions list commons-admin-token --project cs-project-tvcmny79
gcloud secrets versions disable <old version number> --secret commons-admin-token --project cs-project-tvcmny79
```
- A new **moderator token** locks out everyone who has the old one: moderators paste the new one on the About page,
  and the CLI needs `commons login --token <new token>`. Moderator *accounts* are not affected.
- A new **session secret** signs everybody out once, and ends open preview links of hosted sites. Passwords stay valid.
  Rotate it when it may have leaked, or to end all sessions at once.
- To end the sessions of one person, change their role or delete the account on the moderation page; a person ends
  their own other sessions by changing their password.

### Storage: what lives where
| What | `STORE=pg` | `STORE=gcp` | `STORE=local` |
| --- | --- | --- | --- |
| Materials (the whole record: text, counts, embedding) | table `items` | collection `items` | `data/db.json` |
| Votes | table `votes` | collection `votes` | `data/db.json` |
| Accounts, hosted sites, other documents | table `docs` (`coll`, `id`) | collections `accounts`, `sites`, ... | `data/db.json` |
| Daily caps (logos, search embeddings) | table `quotas` | documents `meta/quota-<day>` | `data/db.json` |
| The list of stored files (owner, path, size, type, SHA-256, time) | table `files` | (none: the bucket is listed) | (none) |
| File bytes | bucket, `items/<owner>/<path>` | bucket, `items/<owner>/<path>` | `data/files/` |

With `STORE=pg`, PostgreSQL is the record of everything; the bucket holds bytes only (object storage costs about a
tenth of database disk per GB and streams large files). `files` has one row per object: `owner` is a material's slug,
or `_sites` / `_accounts` with the site or user name as the first folder of `path`. A file is written to the bucket
first and to `files` second, and deleted in the same order, so a row always has its bytes. The tables are created
when the server starts (`MIGRATIONS` in `server/store-pg.js`, version in table `schema_version`); nothing has to be
run by hand, also not for later schema changes. Search and ranking read all materials into memory (one query, again
every 20 seconds); the top of `store-pg.js` says where full-text and vector search would go.

The database connection needs Node 22 or newer when it goes through the Cloud SQL connector (the image has 22).
Each instance keeps at most `PG_POOL_MAX` (5) connections: instances x 5 must stay below the instance's connection
limit (about 25 on the smallest machine, with three instances: 15, plus the migration job or a console session).

Locally, without a server: `STORE=pg PG_TEST=pglite PGLITE_DIR=data/pglite PORT=8787 ADMIN_TOKEN=dev node server/index.js`
runs on PGlite (PostgreSQL compiled to WebAssembly, a devDependency), as the tests do.

### Move from Firestore to PostgreSQL
`tools/migrate-to-postgres.mjs` copies every Firestore collection into the tables above and fills `files` from a
listing of the bucket. File bytes are not copied or changed. It is part of the image and runs as a one-off Cloud Run
job with the service's image, service account, network and secrets (the database has a private address only):
```
node tools/migrate-to-postgres.mjs --dry-run     # reads Firestore and the bucket, prints counts, writes nothing; says whether Postgres answers
node tools/migrate-to-postgres.mjs               # copies (upserts), then prints the verification table
node tools/migrate-to-postgres.mjs --prune       # the same, and removes rows that are gone at the source since an earlier run
```
Environment: `FIRESTORE_DB`, `BUCKET`, `CLOUDSQL_INSTANCE` (+ `CLOUDSQL_IP_TYPE`), `PGUSER`, `PGPASSWORD`, `PGDATABASE`.
As a job, for example (the job is short-lived, so plain `gcloud`; network, subnet, service account and secret as for the service):
```
gcloud run jobs deploy commons-migrate --project cs-project-tvcmny79 --region us-central1 \
  --image us-central1-docker.pkg.dev/cs-project-tvcmny79/apps/commons-web:<tag> \
  --command node --args tools/migrate-to-postgres.mjs,--dry-run --max-retries 0 --task-timeout 30m \
  --service-account <the service's account> --network <network> --subnet <subnet> --vpc-egress private-ranges-only \
  --set-env-vars FIRESTORE_DB=commons,BUCKET=cs-project-tvcmny79-commons,CLOUDSQL_INSTANCE=<project:region:instance>,PGUSER=<user>,PGDATABASE=<database> \
  --set-secrets PGPASSWORD=<secret>:latest
gcloud run jobs execute commons-migrate --project cs-project-tvcmny79 --region us-central1 --wait                                          # the dry run
gcloud run jobs execute commons-migrate --project cs-project-tvcmny79 --region us-central1 --wait --args tools/migrate-to-postgres.mjs     # the real run
```
The job's account needs to read Firestore (`roles/datastore.viewer`), list the bucket (`roles/storage.objectViewer`)
and connect to the instance (`roles/cloudsql.client`). Everything it prints is plain lines in the job's log. The last
lines are the verification: per collection the number of records at the source and in Postgres, and how many are
missing, extra or different (every record is compared in full, materials field by field including the embedding).
The job succeeds (exit status 0) only when all of them are identical; `verify RESULT OK` is the line to look for.

- It can be repeated while the site still runs on Firestore: run it once to see it work, and once more (with
  `--prune`, since drafts are swept and materials deleted in between) right before the switch. What is written to
  Firestore after the last run is not in Postgres, so make the last run and the switch (`STORE=pg` and the settings
  above, a new revision) close together, at a quiet time.
- Once the site has written to Postgres, the tool refuses to run (it would put older data back); `--force` overrides.
- Votes whose material no longer exists are left out and listed (`skipped ...`). File lists of materials that do not
  match the bucket are listed as warnings; they exist today and are not changed.
- `--sha256` reads every file once to fill the checksum column. Without it the column is empty for files that were
  there before the move and filled for every file uploaded afterwards.
- To go back before anything was written to Postgres: set `STORE=gcp` again. Firestore is not changed by the tool.

### Restore data
- **Database with `STORE=pg` (Cloud SQL: daily backups, and point-in-time recovery when it is switched on for the instance).**
  The instance has no public address, so backups and exports are run by Cloud SQL itself, not with `pg_dump` from a laptop.
  - A backup now, for example before a risky change: `gcloud sql backups create --instance <instance> --project cs-project-tvcmny79`.
    List them with `gcloud sql backups list --instance <instance> --project cs-project-tvcmny79`.
  - Look at the data as it was at some minute, without touching the live instance: clone it,
    `gcloud sql instances clone <instance> <instance>-restore --point-in-time 2026-11-12T09:00:00Z --project cs-project-tvcmny79`,
    then copy back what is needed, or point the site at the clone (`CLOUDSQL_INSTANCE`) and delete the old instance later.
  - Put a whole backup back over the live instance (everything written since is lost):
    `gcloud sql backups restore <backup id> --restore-instance <instance> --project cs-project-tvcmny79`.
  - A portable copy (a plain SQL file in a bucket, readable by any PostgreSQL):
    `gcloud sql export sql <instance> gs://<a bucket>/commons-$(date +%F).sql.gz --database <database> --project cs-project-tvcmny79`,
    and back in with `gcloud sql import sql <instance> gs://<a bucket>/<file> --database <database>`. The instance's
    own service account needs write access to that bucket.
  - One material: its row in `items` (and `votes`, `files`) from the clone, and its files from the bucket's older versions (below).
- **Database with `STORE=gcp` (Firestore, point-in-time recovery, 7 days).** Read a document as it was:
  `gcloud firestore export gs://<a bucket>/<folder> --database=commons --snapshot-time=2026-11-12T09:00:00Z --project cs-project-tvcmny79`
  writes the whole database as of that minute; import it into a new database to look at it
  (`gcloud firestore databases create --database=commons-restore --location=us-central1`, then
  `gcloud firestore import gs://<a bucket>/<folder> --database=commons-restore`), and copy back what is needed. Or clone
  the database directly: `gcloud firestore databases clone --source-database=projects/cs-project-tvcmny79/databases/commons --snapshot-time=<time> --destination-database=commons-restore`.
  To switch the site to the restored copy, set `FIRESTORE_DB` in the tofu file and apply.
- **Files (bucket versioning, 30 days).** A replaced or deleted file stays as an older version for 30 days.
  `gcloud storage ls --all-versions gs://cs-project-tvcmny79-commons/items/<slug>/` lists versions (`#<generation>`),
  and `gcloud storage cp gs://cs-project-tvcmny79-commons/items/<slug>/<file>#<generation> gs://cs-project-tvcmny79-commons/items/<slug>/<file>`
  puts one back. Materials are under `items/<slug>/`, hosted sites under `items/_sites/<name>/`, saved brand kits
  under `items/_accounts/<user name>/`.
- A material needs both: its record (table or collection `items`) and its files. Votes are in `votes`; accounts and
  hosted sites in the collections `accounts` and `sites`, with `STORE=pg` in table `docs` (`coll = 'accounts'`, `'sites'`).

### Logs and alerts
- **Logs:** Cloud Console > Cloud Run > `commons-web` > Logs, or
  `gcloud run services logs read commons-web --project cs-project-tvcmny79 --region us-central1 --limit 100`.
  The server writes one JSON line per message with a `severity`; errors (`severity>=ERROR`) carry the stack and show
  up in Error Reporting. A visitor who gets "Something went wrong on the server." left such a line. Logs are kept for 30 days.
- **Health:** `GET /api/health` answers `{"ok":true,...}` with 200, or 503 when the database or the bucket do not answer.
- **Alerts:** Cloud Monitoring > Uptime checks > `commons-web /api/health` asks every five minutes from several
  regions. The alert policy "Groups Commons is down" opens an incident when two regions fail for five minutes, and
  notifies the channels in the tofu variable `commons_alert_channels` (empty by default: add an email channel under
  Monitoring > Alerting > Edit notification channels and put its name in the variable). Spend alerts are the budget
  alerts of the billing account.
- **Housekeeping the server does itself:** uploads that were started and never submitted are deleted after two days.

### Limits to know about
- Rate limits and the sign-in throttle are counted per server instance, in memory (up to three instances).
- Each instance keeps the list of materials in memory and re-reads it every 20 seconds, so a change made on one
  instance can take that long to show on another.
- The Firestore and Cloud Storage code paths are not covered by the automated tests (they run against the local
  store); try a deploy on a new revision before relying on it.
- The PostgreSQL store is covered: `npm run test:pg` runs every test against it, on PGlite (real PostgreSQL, but one
  connection inside the test process). What that cannot show is the `pg` driver against a server, several
  connections at once, and the Cloud SQL connection itself. `PG_TEST=server DATABASE_URL=postgres://... npm run test:pg:server`
  runs the same tests against any PostgreSQL server (each test file in a schema of its own, dropped afterwards).
- With `STORE=pg`, a write that fails because the database went away is not repeated (reads are, once): the visitor
  gets an error and tries again. An instance that starts while the database is down starts anyway, answers 503 on
  `/api/health` and recovers by itself.
