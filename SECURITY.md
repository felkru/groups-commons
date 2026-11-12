# Security

Groups Commons lets anyone upload files and text that other people then open. This page says how that is kept
harmless, who can do what, and how to report a problem.

## Reporting a problem
Please report it privately, not in a public issue: use "Report a vulnerability" under the Security tab of the
GitHub repository (private vulnerability reporting), or write to the operator named on the site's `/privacy` page.
Say what you did, what happened and what you expected. Please do not look at or change other people's data beyond
what is needed to show the problem, and give us a reasonable time to fix it before you publish.

## How uploads are sandboxed
Uploaded files and hosted pages are other people's content on the site's own address. Three layers keep them from
acting as the site:

1. **Review.** What visitors add (materials, forks, hosted websites) is `pending` until a moderator approves it.
   Until then a material and its files are visible to the uploader and to moderators only; a file needs either
   their request headers or a file key in its address that expires after six hours. When the owner changes a
   published material or a live website, it goes back to `pending`.
2. **Checks on upload** (`server/ingest.js`). Only listed file types are accepted (PDF, images, Office files, text
   formats, HTML, SVG, ZIP); paths cannot leave the material's folder; sizes are capped (25 MB a file, 60 MB a
   material). HTML and SVG are refused when they contain `<script>`, inline event handlers, `javascript:` addresses,
   `iframe`/`object`/`embed`/`form` or a self-redirect. This filter is a convenience, not the protection.
3. **Response headers** are the protection. Every uploaded HTML or SVG file is served with
   `Content-Security-Policy: sandbox; default-src 'none'; …`, so opening it directly runs no script and has no access
   to the site's storage. All files carry `X-Content-Type-Options: nosniff`, so a file is never treated as another
   type than its extension says. Hosted websites (`/s/<name>/`) are served with a `sandbox` policy without
   `allow-same-origin`: single-page sites made from the template run no scripts at all; built sites uploaded with
   the CLI may run their own scripts, but in an origin of their own, so they can read neither the site's storage
   (sessions, moderator token) nor call its API as the visitor. The site's own pages allow scripts from the site
   only (`script-src 'self'`), cannot be framed, and send HSTS and a `Permissions-Policy` that switches off camera,
   microphone, location and similar features (also for hosted pages).

In the editor a template is parsed in the browser, scrubbed (scripts, frames, handlers, foreign links) and shown in
a sandboxed frame without scripts.

The server turns PDFs and Office files into preview images with `pdftoppm` and LibreOffice, and resizes images with
libvips (sharp). These tools run inside the Cloud Run container, with time limits, on files that may be malicious.
A flaw in them could expose what the service account can reach: the commons database and bucket, and the two
secrets. Keep the base image and `sharp` current (`npm audit`, rebuild the image regularly).

## Accounts and sessions
- An account is a user name, a group and a password. Passwords are stored as salted scrypt hashes. There is no
  email address and so no password reset; a moderator can delete an account so that the name can be registered again.
- A session is a signed token (30 days) that the browser sends in a header. There are no session cookies, so
  requests forged from other sites carry no login. A token is checked against the account on every request: it stops
  working when the account is deleted or its password changes, and the role is always read from the account.
- Sign-in is limited to 30 attempts an hour per address and locked for 15 minutes after 5 wrong passwords for one
  user name. The lock is counted per server instance. Someone who keeps guessing can keep an account locked.
- Deleting an account (by its owner or a moderator) takes down its hosted websites, deletes its saved brand kit,
  withdraws its votes and deletes its materials that are not published. Published materials stay, without owner and
  user name, unless their deletion is asked for. Nothing remains tied to the name.
- Without an account, a random id in the browser stands in for the visitor (one vote per id), and an edit key kept
  in the browser allows changing one's own uploads. Whoever makes up many ids can cast many votes; the limit per
  address (300 votes an hour) is the only brake. Votes are a ranking aid, not a ballot.

## What moderators can do
A moderator is whoever holds the moderator token (`ADMIN_TOKEN`), or an account with the role `moderator`. Moderators can:
- see, approve, change, feature and delete any material, and approve or take down any hosted website;
- publish their own materials and websites without review, and set vote and use counts when publishing (used for
  the simulated seed statistics);
- list accounts (user name, group, role, date; never passwords), make accounts moderators or members, delete accounts;
- they are exempt from rate limits and from the daily limits of the AI features.

Moderators cannot read passwords or sign in as someone else. The moderator token cannot be taken back from one
person: rotating it (README, "Running it") locks out everyone who has it. Prefer moderator accounts, which can be
demoted one by one, and keep the token for the operator and the CLI.

## Secrets
`ADMIN_TOKEN` and `SESSION_SECRET` live in Secret Manager and reach the service as environment variables; they are
never logged. `SESSION_SECRET` signs sessions, preview links and file keys. Rotation is described in the README.

## Known limits
- Rate limits are per server instance and per address; they slow abuse down, they do not stop a determined sender.
- A preview link of a hosted website shows the unreviewed site to anyone who has the link, for two days.
- The upload filter for HTML works on text patterns and can be wrong in both directions; see layer 3 for what
  actually protects visitors. A downloaded template opened from disk is not protected by the site's headers.
