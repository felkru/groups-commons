# Groups Commons (prototype)

A shared place for the materials AI safety university groups keep re-making: slides, flyers, message templates,
tabling kits, suppliers. Built as a prototype to test the technically risky parts of the idea.

The live instance is internal for now; ask the maintainers for the link.

## What is in here
- `server/`: Express API. `index.js` (routes), `store.js` (local files or Firestore + Cloud Storage), `rank.js` (hot / best / top),
  `ingest.js` (validation), `ai.js` (Vertex AI: embeddings for search, Gemini for printable -> template), `preview.js` (thumbnails).
- `server/accounts.js`: accounts (user name + password, signed session tokens). Hosted group websites (`/s/<name>`), the
  leaderboard, page previews for PDFs and Office files (LibreOffice) and AI logo marks live in `index.js`, `preview.js` and `ai.js`.
- `public/`: the website, plain ES modules, no build step. `template.js` is the in-browser template editor; `more.js` has the
  account, moderation and leaderboard pages.
- Getting it into people's assistants: `public/agent.js` is the "Set up my AI" questionnaire (button in the header) and the
  Contribute page. Its result is one command for a setup script that `server/setup.js` writes per request from
  `server/setup.sh.tmpl` (macOS, Linux, WSL) and `server/setup.ps1.tmpl` (Windows): `/setup.sh?agent=claude-code&install=1&cli=1&skill=1`.
  The values a script address may carry are checked in `public/setup-fields.js`, shared by both sides. `/llms.txt` describes
  the site to assistants that can open web pages.
- `cli/commons.mjs`: one-file CLI (`commons search | get | add | ...`). `skill/SKILL.md`: Claude Code skill that uses it.
- `docs/TEMPLATE_CONTRACT.md`: what makes an HTML file a re-brandable template. `docs/SEED_FORMAT.md`: the material folder format.
- `seed/`: the materials themselves. They are not part of this repository (they include a group's internal originals);
  the format is described in `docs/SEED_FORMAT.md`.
- `server/ops.js`, `server/log.js`: health check, start and shutdown, response headers, structured logs.
- `test/`: automated tests (`npm test`), run on every push by `.github/workflows/test.yml`.
- `infra/commons.tf`: the OpenTofu definition of the deployment (a copy; the applied file lives with the other infrastructure).
- `SECURITY.md`: how uploads are kept harmless, what moderators can do, how to report a problem.

## Run locally
```
npm install
STORE=local PORT=8787 ADMIN_TOKEN=dev node server/index.js          # add VERTEX=1 for semantic search and conversion (uses gcloud ADC)
COMMONS_URL=http://localhost:8787 COMMONS_TOKEN=dev node cli/commons.mjs add seed/*/ --stats seed/_stats.json
npm test                                                            # local store in a temporary folder, no cloud access
python3 tools/test-setup-sh.py http://localhost:8787               # runs /setup.sh in a sandbox with stub claude, codex and npm
```
`/setup.ps1` has a test for Cloud Build (PowerShell 7 on Linux, stub programs): `tools/test-setup-ps1.cloudbuild.yaml`.

Two things are not in this repository: the materials (`seed/`, a group's own originals and photos; `docs/SEED_FORMAT.md`
describes the folder format) and the intro video (`public/assets/intro.mp4`, which shows them; `tools/intro-video/README.md`
says how it is made). A copy without them starts empty and shows the intro without the video. `.gcloudignore` keeps the
video in the build upload.

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
| `STORE` | `gcp` (Firestore + Cloud Storage) or `local` (files under `DATA_DIR`, default `./data`). |
| `FIRESTORE_DB`, `BUCKET` | Database name and bucket for `STORE=gcp`. |
| `ADMIN_TOKEN` | The moderator token. Whoever holds it is a moderator. Secret `commons-admin-token`. |
| `SESSION_SECRET` | Signs sign-in sessions, preview links of hosted sites and file keys. Secret `commons-session-secret`. Without it the key is derived from `ADMIN_TOKEN` (and a warning is logged). |
| `VERTEX` | `1` switches on semantic search, the printable converter and logo suggestions. |
| `PUBLIC_URL` | The site's address, if it should not be taken from the request. |
| `LOG_FORMAT` | `json` or `text`. Default: `json` on Cloud Run, `text` elsewhere. |

### Deploy
1. `npm test`
2. `gcloud builds submit --project cs-project-tvcmny79 --region us-central1 --tag us-central1-docker.pkg.dev/cs-project-tvcmny79/apps/commons-web:$(git rev-parse --short HEAD) .`
3. Set the tag in `images.auto.tfvars`, then `tofu plan -out=tfplan` and `tofu apply tfplan` in the tofu directory.

A new revision takes traffic only after `GET /api/health` answered 200 on it, that is, after it reached Firestore and
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

### Restore data
- **Database (Firestore, point-in-time recovery, 7 days).** Read a document as it was:
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
- A material needs both: its document (collection `items`) and its files. Votes are in `votes`, accounts in
  `accounts`, hosted sites in `sites`.

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
