# Ration Club Recipes

A small web app that lets anyone update the recipes in the docs.plus booklet
["Ration Club: A Community Recipe Booklet"](https://docs.plus/tt9qajlqe47) **without logging in**.

```
Visitor (no login) → web/ (Vite + React) → server/ (Node, Hono) → docs.plus MCP server → the document
                                            signed in once as the doc owner
```

docs.plus MCP only lets a signed-in person edit documents they **own**. So the backend holds one OAuth
login for the owner and acts as them. The browser never talks to docs.plus: MCP requests carrying a
browser `Origin` header are refused with 403.

> **Status: Phase 6 (all planned phases built).** A mobile-first web page (`web/`) where visitors browse recipes and edit them through a
> simple form, served by the backend (`server/`) on **one always-on server**, with abuse protection: input
> cleaning, rate limits, Cloudflare Turnstile, a honeypot, an audit log, an optional approval queue,
> optional chat summaries, optional photos by link, a Dockerfile and health checks. Not built yet: alerts (use an uptime
> monitor on `/health/docs`).

## Setup

Needs Node ≥ 20 (`.nvmrc` pins 24) and pnpm via corepack.

```sh
nvm use               # or nvm install
corepack enable       # provides pnpm 11 (pinned in package.json)
pnpm install
cp .env.example .env  # optional: the defaults point at the fictional test doc
brew install gitleaks # required by the pre-commit hook
pnpm test
```

> Use `pnpm run login`, **not** `pnpm login`. `pnpm login` is pnpm's own npm-registry login and
> takes precedence over the package script.

| Command | What it does |
|---|---|
| `pnpm dev:server` | API on http://localhost:3000, reloads on change. Uses `DOC_SLUG`, which defaults to the test doc. |
| `pnpm dev:web` | The web page on http://localhost:5173, reloads on change. Sends `/api` to `dev:server`, so run both. |
| `pnpm build` then `pnpm start` | Production-style: builds `web/dist` (and compiles the server to `server/dist`), and the server serves the page and the API together on http://localhost:3000. |
| `pnpm queue` | Approval queue: list, show, approve, reject. See [Approval queue](#approval-queue-optional). |
| `pnpm run login` | One-time OAuth sign-in to docs.plus. Opens your browser. Safe to rerun. `-- --force` signs in again from scratch. |
| `pnpm check` | Read-only: lists the MCP tools and your documents, prints `OWNER: yes/no` for `DOC_SLUG`, and prints its outline. |
| `pnpm token-info` | Shows token facts (has refresh token, expiry). Never prints tokens. `-- --refresh` tests a refresh and whether it rotates. `-- --expire-now` (testing) marks the access token expired, so a running server refreshes on its next call. |
| `pnpm audit-log` | Recent write attempts from the audit log: time, outcome, recipe, IP hash, reason. `-- --tail 50`, `-- --day 2026-11-03`, `-- --full` (whole entries, with before/after text). |
| `pnpm export-login` | Prints the login in `SECRETS_DIR` as one secret bundle for the host's `DOCSPLUS_LOGIN_BUNDLE`. See [Hosting](#hosting-one-server). |
| `pnpm create-test-doc` | Creates the fictional TEST doc from `server/src/seed/testRecipes.ts`, owned by the signed-in account, and sets `DOC_SLUG` in `.env`. Reuses an existing test doc. `-- --new` forces another. |
| `pnpm capture-fixtures` | Read-only. Regenerates `server/test/fixtures.ts` from `DOC_SLUG`, and refuses unless that doc is yours. |
| `pnpm write-test` | Runs every write path against the **test doc only** and prints docs.plus's real replies. It refuses any other doc. Edits "Mystery Stew" and restores it. Appends "Write Test Recipe" once, since headings can't be removed. |
| `pnpm format-test` | Test doc only. On a throwaway "Format Test Recipe": converts bold Ingredients/Method into `####` subsections, adds an image and a YouTube link, and checks how media behaves. Resumable: steps already done are skipped. |
| `pnpm test` | Parser unit tests (vitest). Checks captured docs.plus responses from the test doc against the recipe definitions. |

### Test document

Development uses **our own fictional test doc**
([ration-club-recipes-test-doc-fictional-data](https://docs.plus/ration-club-recipes-test-doc-fictional-data)),
not the real booklet. It copies the booklet's structure (bold `###` recipe headings, Head Chef / Support
lines, bold Ingredients / Method paragraphs, a date) with made-up names, so no real person's data ends up in
this repo. Like every docs.plus document it is public, so anyone can find and edit it.

To change the test data, edit `testRecipes.ts`, run `pnpm create-test-doc -- --new`, then `pnpm capture-fixtures`.

## API

All JSON. Errors are `{ "error": { "code", "message", … } }`, and `message` is plain language that is safe to show visitors.

| Route | What it does |
|---|---|
| `GET /api/recipes` | Recipes (the direct children of the booklet's `#` heading), with their subsections. |
| `GET /api/recipes/:id` | One recipe: `form` (its values as form fields, its `rev`, and `editable`), `fields` (head chef, support, date) and `sections` (the recipe, then its subsections). Each section has a `rev` and `parts`: text parts are editable, media parts (`{type:"media", kind:"image"}`) are fixed. |
| `PUT /api/recipes/:id` | **What the web page uses.** Body `{ baseRev, form }`: plain-text form values. The server formats them in the booklet's layout (see [Recipe form](#recipe-form)). Returns the updated section. |
| `PUT /api/sections/:id` | Body `{ baseRev, texts }`. Send one string per text part, in order, plus the `rev` you loaded. Returns the updated section with its new `rev`. |
| `POST /api/recipes` | Body `{ title, form }` (the web page) or `{ title, markdown? }`. Appends `### **Title**` + body at the end of the booklet. An empty body gets the Head Chef / Support / Ingredients / Method template. Returns 201. |
| `GET /api/config` | What the page needs: Turnstile site key, honeypot field name, `requiresApproval`, limits. |

With the [approval queue](#approval-queue-optional) on, both writes are checked the same way but answer **202**
`{ pending: { id }, message }` instead of writing, and the message tells the visitor their change is waiting.

### Recipe form

Visitors never see Markdown. They fill in plain fields, and the server (`server/src/recipeForm.ts`) converts both ways:

| Field | In the booklet |
|---|---|
| Head chef, Helpers | `**Head Chef: …**`, `**Support: …**` (`???` when empty, as in the booklet) |
| Serves, Approximate cost (optional) | `**Serves: …**`, `**Cost: …**`, left out when empty |
| Ingredients (one per line) | `**Ingredients**` and a bullet list |
| Method (one step per line) | `**Method**` and a numbered list |
| Tips & substitutions (optional) | `**Tips & substitutions**` and a bullet list |
| Story behind the dish (optional) | `**Story**` and paragraphs |
| Date cooked (date picker) | `30 September 2026` on the last line |

- **Everything visitors type is literal.** Markdown characters are escaped, so nobody can add headings, bold, links,
  HTML or lists through a field. They still pass the input checks below as well.
- **Nothing in the document is lost.** Text that fits no field is shown read-only ("Other notes") and written back
  unchanged. It is always taken from the document, **never from the browser**, so it can't be used to slip in Markdown.
- Reading is forgiving: labels count with or without bold, the booklet's "Ingridients" typo is understood, one
  ingredient per paragraph works, and docs.plus's read-back quirks (measured live: `&amp;`/`&lt;` entities, web
  addresses turned into links, an unescaped leading `#`) are undone. Saving a form unchanged rewrites nothing, and
  the first save of an old recipe tidies its labels into the layout above.
- Recipes with sub-headings don't fit the form: the page shows them read-only and says only organisers can edit them.

### Photos (links only)

Visitors can add up to 3 photos per save (6 per recipe), each with an optional caption, by pasting a **link to the
picture**. We never upload or store images. In the booklet, each photo goes at the end of the recipe as a picture
block followed by its caption line, and captions stay editable through the form afterwards.

- **docs.plus doesn't copy pictures** (checked 2026-11-03): every reader's browser loads the picture from the link.
  So the photo is only as good as the link. If the site behind it deletes or changes the picture, the booklet changes too.
- **The app can never remove a picture** (docs.plus refuses). Removing one means deleting it by hand in docs.plus.
  Photos follow `REQUIRE_APPROVAL` like text. `pnpm queue show` lists each photo link so you can open it before approving.
- **Each link is checked once on the server**, and again on approval:
  - `https` only;
  - no private, loopback or link-local addresses. This is checked on the address the hostname actually resolves to,
    and after every redirect (at most 3), so a link can't be used to probe our own network;
  - the file must start like a JPEG, PNG, GIF or WebP, and be at most 5 MB if its size is given.
- docs.plus reads pictures back only as `[image]`, so the server keeps its own record of which links it added to which
  recipe (`DATA_DIR/photo-links.json`) to show them on the page. A picture added by hand in docs.plus shows as
  "a picture is here".
- **Privacy:** a photo link works like any picture on the web. The site that hosts it sees the IP address of each
  person who views it, on our page and in docs.plus. Our page sends no referrer with it.
- Text under a picture that isn't a single caption line (for example, paragraphs an organiser typed) makes the recipe
  organiser-only, so the form never mixes it up.

### How saving works

The server takes a per-document lock, then re-reads the section. If its rev isn't
`baseRev`, someone else changed it, so it answers **409** with the latest version and writes nothing. Otherwise it
writes only the text parts that changed, last part first so block numbers stay valid, and re-reads after each
edit, since `edit_blocks` returns no rev. A stale rev from docs.plus gets one retry, which repeats the `baseRev`
check. Media blocks are never in an edited range.

**What visitors can't submit:** headings (they'd create permanent sections), images, `[image]`-style
placeholders, a link alone on a line (it becomes an embed), code blocks/diagrams, HTML, and text over 20,000
characters per section. Titles are 1–100 characters without markdown symbols, and must be unique
(case-insensitive). Adding a recipe is refused if anything other than the booklet is the last top-level section,
or the recipe would land under the wrong heading.

**Error codes:**

| Code | HTTP | Meaning |
|---|---|---|
| `invalid` | 422 | Bad input, or docs.plus refused it |
| `not_found` | 404 | No such recipe or section |
| `conflict` | 409 | Changed by someone else (`latest` included), or a duplicate title |
| `rate_limited` | 429 | Too many requests |
| `unconfirmed` | 503 | "Could not confirm the write". Not retried, to avoid saving twice |
| `unavailable` | 503 | Login missing or expired, not the owner, or unexpected doc structure |
| `internal` | 500 | Something else went wrong |

The real cause is logged on the server only.

Reads are cached for 10 seconds, and every write clears the cache. docs.plus allows 60 tool calls a minute for the
whole app, because every visitor acts as the one owner account.

## The web page

Mobile-first React (`web/`), plain CSS with a dark mode, no router or UI libraries. Pages: all recipes (with search
once there are more than 6), one recipe, edit, and add.

- **Two people editing at once:** the save answers 409, the page loads the other person's version into the form,
  and keeps the visitor's own text below it to copy from.
- **Unsaved changes** are kept in this browser (`localStorage`, if available) and offered back next time, as long as
  the recipe hasn't changed since.
- With the approval queue on, the button reads "Send for checking", and the page says the change is waiting for an organiser.
- **Turnstile** loads only when the server sends a site key. The token is used once and renewed after every attempt.
- The **honeypot** field sits off-screen, hidden from screen readers and skipped by Tab.
- Errors are the server's plain-language messages. "Offline" has its own message.

In production the server serves `web/dist` for every non-`/api` path, with hashed assets cached for a year and a
strict **Content Security Policy**: scripts only from this site and `challenges.cloudflare.com` (Turnstile), images
from this site or any `https` address (recipe photos are links), no framing by other sites (`frame-ancestors 'none'`),
and requests only to this site. Set `WEB_DIST` to serve a
build from elsewhere. Without a build, the server serves the API only.

## Protection

Every write (`PUT /api/sections/:id`, `POST /api/recipes`) passes these checks, in order:

1. **Rate limits:** per visitor IP, then for the whole app. Over the limit → `429` with `Retry-After`. These requests aren't audited, so a flood can't fill the disk.
2. **Honeypot:** a hidden form field (`website`, from `GET /api/config`). People never fill it; bots that fill every field do. → `422`.
3. **Cloudflare Turnstile:** the page sends `turnstileToken`, and the server checks it with Cloudflare. → `422` if it's missing, failed or expired. If Cloudflare can't be reached → `503`.
4. **Input cleaning** (`server/src/validate.ts`):
   - Text is normalised to Unicode NFC, and invisible control, zero-width and **text-direction** characters are removed, so they can't hide content or slip past the rules.
   - Refused: headings, images, `[image]`-style placeholders, a link alone on a line, code blocks, HTML, links that aren't `https://`/`mailto:` (`javascript:`, `data:`, relative…), more than 5 links, and more than 20,000 characters.
5. The write itself (lock, `baseRev` check, …), or with the approval queue on, the same checks and a queued item. Then **one audit line**.

| Limit | Default | Setting |
|---|---|---|
| Saves per visitor | 10 per 10 min | `RATE_WRITES_PER_IP=10/600` |
| Reads per visitor | 120 per min | `RATE_READS_PER_IP=120/60` |
| All saves together | 30 per min | `RATE_WRITES_GLOBAL=30/60`. This protects docs.plus's 60 calls/min for the whole app. |

Limits are counted in memory, which is right for one server. They reset when it restarts.

**Visitor IP.** Set `CLIENT_IP_HEADER` to the header **your host** sets: `fly-client-ip` on Fly, or
`x-forwarded-for` on Railway/Render (the right-most entry is used, because the host appends it). Never name a header
your host doesn't overwrite, or visitors could fake their IP and dodge the limits. Locally, leave it empty.

**Turnstile.** Create a widget at Cloudflare (dashboard → Turnstile) for your site's hostname, then set:
- `TURNSTILE_SITE_KEY`, which is public and goes to the page;
- `TURNSTILE_SECRET`, which is secret and stays on the host;
- optionally `TURNSTILE_HOSTNAMES=recipes.example.org`.

With `NODE_ENV=production`, the server **refuses to start** without `TURNSTILE_SECRET`, unless you set
`TURNSTILE_DISABLED=1` on purpose. Cloudflare's test keys (`1x00000000000000000000AA` /
`1x0000000000000000000000000000000AA`) always pass and are fine for local development.

**Audit log.**
- Format: one JSON line per write attempt, in `DATA_DIR/audit-YYYY-MM-DD.jsonl`. It's append-only, the folder is mode 0700 and the files 0600.
- Each line holds:
  - time and request id (also sent as `X-Request-Id`)
  - action (`save_section`, `add_recipe`, and the organiser's `approve`/`reject`) and outcome (`saved`, `unchanged`, `added`, `queued`, `rejected`, `conflict`, `refused`, `blocked`, `failed`) with the reason, and the queue item id
  - recipe and section, base and new rev
  - the text **before and after**; for refused attempts, what was attempted, truncated to 2,000 characters
- **No IP addresses**, only `ipHash`: an HMAC of the IP with a secret salt (`AUDIT_SALT`, or generated once into
  `DATA_DIR/audit-salt`). The same visitor gets the same hash, so floods can be spotted, but the IP can't be read back.
- `DATA_DIR` must be on the persistent disk in production (e.g. `/data/audit`). The log holds visitor text, so treat
  it as private. A failed audit write is logged as an error and doesn't block the visitor's save.

### Approval queue (optional)

Set `REQUIRE_APPROVAL=1` and nothing a visitor sends reaches the document until an organiser approves it.

- Visitors' changes pass every check above (including a `baseRev` check and a duplicate-name check), then wait as
  one file each in `DATA_DIR/pending/` (mode 0600, with an IP hash, never an IP). A change that edits nothing isn't queued.
- At most `QUEUE_PER_IP=10` waiting changes per visitor and `QUEUE_MAX=200` in total, so a flood can't fill the disk. Beyond that → `429`.
- Organisers use the admin API with `ADMIN_TOKEN` (at least 32 characters: `openssl rand -hex 32`). The server
  refuses to start with `REQUIRE_APPROVAL=1` and no token. 10 missing or wrong tokens lock that IP out of the admin
  routes for 10 minutes. Without the queue, the admin routes don't exist.
- **Approving** writes the change exactly as a direct save would. If the section changed after the visitor loaded
  it (say, another approved change), approving answers `409` and the item stays queued: reject it, or approve with
  `overwrite`, which replaces the newer text. **Rejecting** deletes the item and writes nothing.
- Every decision is audited (`approve`/`reject`, with the item id and any note), so the log shows who proposed what and what happened to it.

From your computer, with the same `ADMIN_TOKEN` (and `API_URL=https://your-host` for a hosted server):

```bash
pnpm queue                          # list waiting changes
pnpm queue show 1a2b3c4d            # the text now vs. the proposed text
pnpm queue approve 1a2b3c4d         # add --overwrite if the section changed since
pnpm queue reject 1a2b3c4d --note "spam"
```

| Route (all need `Authorization: Bearer <ADMIN_TOKEN>`) | What it does |
|---|---|
| `GET /api/admin/pending` | Waiting changes, oldest first. |
| `GET /api/admin/pending/:id` | One change; for an edit, also the section's text now and `changedSince`. |
| `POST /api/admin/pending/:id/approve` | Body `{ overwrite?: boolean }`. Writes it, then removes it from the queue. |
| `POST /api/admin/pending/:id/reject` | Body `{ note?: string }`. Removes it without writing. |

`ADMIN_TOKEN` is a password for changing your document: keep it only in the host's settings and your own `.env`.

### Chat summaries (optional)

Set `CHAT_SUMMARIES=1` and after each change reaches the document, the server posts one line in the docs.plus chat,
for example `Recipe updated through Ration Club Recipes: "Mystery Stew" › Method.` (plus "Approved by an organiser."
when it came through the queue).

- It goes in the recipe's chat room if it has one, otherwise the booklet heading's room. docs.plus only allows
  posting in a room that already exists, and rooms start the first time someone opens chat on a heading, so
  **open the chat on the booklet heading once** in docs.plus. With no room, notes are skipped (logged once).
- Notes name the recipe and section only. They never quote what visitors wrote, so the chat can't be used to spread spam.
- Best effort: notes are posted in the background, one at a time, never retried (a retry could post twice). A
  failed note is logged and never fails the save. Each note costs one docs.plus call (plus a room-list call every 5 minutes).

## The login flow

1. `pnpm run login` starts a one-shot callback server on `127.0.0.1:8787`.
2. The MCP SDK finds docs.plus's authorization server. The 401 carries `WWW-Authenticate` with `resource_metadata`, which leads to Supabase Auth.
3. It registers this app as an OAuth client (dynamic client registration, public client, no secret) and starts an authorization-code flow with **PKCE S256** and a random `state`.
4. Your browser opens the docs.plus consent page. Sign in with a magic link if asked, **check that the page names `http://localhost:8787/callback`**, then click **Allow**.
5. The callback server checks `state`, then `transport.finishAuth(code)` exchanges the code for tokens.
6. Everything is stored in `.secrets/`: client registration, tokens, discovery metadata, and the in-flight PKCE verifier/state. The directory is mode 0700 and the files 0600. The app never sees your email or password.

If the flow is interrupted (tab closed, Ctrl-C, timeout), just run it again. A new verifier and state
replace the old ones. If the stored client registration is rejected, the SDK clears it and registers again.

Sign in as the account that **owns** the document. `pnpm check` must say `OWNER: yes` before any edits can work.

## Security model

**The stored refresh token can act as you on docs.plus.** Whoever holds `.secrets/tokens.json` (or,
later, the Redis keys) can read and edit every docs.plus document you own, and post in their chats,
until the token is revoked.

- **Revoke it:** docs.plus → **Settings › Connected apps** → *Ration Club Recipes* → **Disconnect**.
  Then delete `.secrets/`. Do this if a token may have leaked, or when retiring the app.
- Secrets never go into git. `.secrets*/` (including `.secrets-server/`) and `.env*` are gitignored, and only `.env.example`, with placeholders, is committed.
- The `pnpm export-login` bundle is as secret as the tokens. It belongs only in the host's env, and only until the first start.
- A **gitleaks** pre-commit hook (`.husky/pre-commit`, rules in `.gitleaks.toml`) blocks commits containing tokens. It refuses to commit if gitleaks is not installed.
- `.github/CODEOWNERS` marks the hook, package and secret-scanning files as needing the owner's review. Review any change to `.husky/` or `prepare` scripts carefully: they run on your machine.
- **Enable GitHub secret scanning push protection** on the repo: Settings › Code security › Secret Protection › Push protection.
- All MCP calls are server-side. Visitors never get a token and can only reach the narrow API the backend exposes,
  behind rate limits, a honeypot, Turnstile and input cleaning, and optionally an approval queue. See [Protection](#protection).
- `ADMIN_TOKEN` (approval queue) can approve any queued change into your document. Keep it out of git, like the tokens, and change it if it may have leaked.
- The audit log (`DATA_DIR`) holds what visitors wrote, but no IP addresses, only salted hashes. Treat the folder as private.
- docs.plus treats document text as data. The app parses it and never acts on it as instructions.
- Scripts print token *facts* (expiry, a short SHA-256 prefix), never token values.

## Deployment implications

Measured on 2026-11-02 with `pnpm token-info -- --refresh`:

| Question | Answer |
|---|---|
| Refresh token issued? | **Yes** |
| Access token lifetime | **3600 s (1 hour)**, a JWT |
| Refresh rotates the refresh token? | **Yes.** Each refresh returns a new one. |

Each refresh **uses up** the stored refresh token. If two refreshes use the same token, the second reuses a
spent token, and docs.plus (Supabase) may revoke the whole login. Then someone has to sign in again.

**Chosen hosting: one always-on server** (decided 2026-11-03), so no Redis. How the server stays safe:

- **Refresh before expiry, once.** `TokenRefresher` (`server/src/auth/refresh.ts`) refreshes when under
  5 minutes are left. Concurrent requests share that one refresh. The SDK on its own only refreshes after
  docs.plus rejects a call, and concurrent rejections would each refresh with the same token.
- **Identical refresh requests are merged.** All refresh requests go through `dedupeRefreshFetch`. Simultaneous ones
  become one network call, and for 60 s a caller still holding the old token gets the same new tokens instead
  of spending it again.
- **A rejected call is retried once.** docs.plus didn't run it, so this is safe even for writes. Two rejections in a row
  mean the login is gone (`503`).
- **One server per login.** `server.lock` in `SECRETS_DIR` has a 30 s heartbeat. A second server refuses to start.
  A lock from a crashed server is taken over after 90 s. Scripts (`check`, `write-test`, …) warn if a server is running on the same login.
- Measured live: 10 simultaneous requests with an expiring token, then 10 with a rejected token → all 200,
  **one** refresh each time.

Serverless would need the tokens and the lock in shared storage such as Redis. `TokenStore` and `Lock` are interfaces,
so that can be added later without rewriting the app.

## Hosting (one server)

Any host that can run one Docker container with a persistent volume works (Railway, Fly, Render, a VPS…). The requirements:

- **Exactly one instance.** Turn off autoscaling and replicas. Separate machines can't see each other's lock.
- **A persistent volume at `/data`.** The login (`/data/secrets`), audit log, approval queue and photo-link record
  (`/data/app`) live there. Without it, every redeploy loses the rotated token and you'd have to sign in again.
- `DOC_SLUG` = the booklet to edit, plus `CLIENT_IP_HEADER` and the Turnstile keys (or `TURNSTILE_DISABLED=1`).
  See [Protection](#protection). The image already sets `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`,
  `SECRETS_DIR=/data/secrets` and `DATA_DIR=/data/app`.

### Docker

The `Dockerfile` builds the page, compiles the server to plain JavaScript, and runs it as the unprivileged `node` user
with production dependencies only. `.dockerignore` keeps `.secrets*`, `.data` and `.env*` out of the build.

```sh
docker build -t ration-club-recipes .
docker run -d --name recipes -p 3000:3000 -v recipes-data:/data \
  -e DOC_SLUG=ration-club-recipes-test-doc-fictional-data \
  -e TURNSTILE_DISABLED=1 \
  -e DOCSPLUS_LOGIN_BUNDLE='…'  `# first start only, see below` \
  ration-club-recipes
```

- `docker stop` sends SIGTERM to the server itself (not via pnpm), so it releases its one-instance lock.
- Locally, `pnpm build && node server/dist/index.js` runs the same compiled server without Docker.

### Health checks

| Endpoint | Answers | Use it for |
|---|---|---|
| `GET /health` | Always `200 {"status":"ok"}` while the process runs. Never calls docs.plus. | The host's health check (the image's `HEALTHCHECK` uses it). A dead login must not make the host restart the server in a loop. |
| `GET /health/docs` | `200 {"status":"ok","docsPlus":"ok"}` when the server can use docs.plus as you, otherwise **`503`** with `docsPlus`: `login_needed` (sign in again), `not_owner` (`DOC_SLUG` isn't yours) or `unavailable` (docs.plus unreachable). | An uptime monitor that emails you on failure (e.g. a free one polling every 5 minutes). There are no built-in alerts yet. |

`/health/docs` calls docs.plus **at most once a minute** however often it's polled. A successful visitor request in
the last 5 minutes counts, so a busy site needs no extra calls. The reason it reports is operational
(no names, tokens or document text). The details are logged on the server.

**Getting the login onto the server.** Use a **separate** docs.plus session for the server, so your laptop and
the server never share a rotating token:

```sh
SECRETS_DIR=.secrets-server pnpm run login       # sign in as the doc owner, click Allow
SECRETS_DIR=.secrets-server pnpm export-login | pbcopy
```

1. Paste it into the host's environment as `DOCSPLUS_LOGIN_BUNDLE` and deploy. The log says
   "Imported the docs.plus login".
2. **Delete `DOCSPLUS_LOGIN_BUNDLE`** from the host, and run `rm -rf .secrets-server`. The bundle is only imported into
   an empty `SECRETS_DIR`, and goes stale after the first refresh.

**If the login dies** (`503`s, "login needed" in the log): delete the tokens on the disk
(`$SECRETS_DIR/tokens.json`), then repeat the steps above. To cut the server off completely, use docs.plus
**Settings › Connected apps › Disconnect**.

## docs.plus write behaviour (measured)

Measured with `pnpm write-test` on the test doc, 2026-11-02:

- **`replace_text`** returns the new rev, in `structuredContent.rev` and in the text ("The section's rev is now …").
  Bold survives edits *inside* a bold run (`Charlie` → `Delta`) and full rewrites of the run. **Text appended
  only at the end of a bold run comes out unbolded** (`**Chef Delta** Tested`). Use `edit_blocks` with full
  markdown for formatted text, and `replace_text` only for plain wording fixes.
- **`edit_blocks`** returns `rev: null` (and sometimes `version: null`). Always re-read. Replacing a whole body
  (`after_block 0`, remove all) works and leaves the heading alone.
- **Revs are content hashes.** Restoring a section's exact content gives back its old rev, so a rev
  proves *what the content is*, not that nobody wrote in between.
- **Refusal texts** start with the argument name (`old_text: …`, `markdown: …`) and are mapped to `invalid_input`:
  - old_text missing: "it is not in this section as one stretch of text…"
  - old_text ambiguous: "it appears 2 times in this section…"
  - heading too shallow: "a new heading must be at level 4 or deeper" (inside a `###` recipe)
  - `#` heading: "a level-1 heading (#) is the document title"
- **Stale rev** (both tools): "The section changed since you read it. Call read_document or get_outline again,
  then retry with the new rev." This maps to `stale_rev`.
- **`append_to_document`** adds the recipe as a `###` under the doc's `#` heading, as long as no other `#` section comes after it.
- **Layout changes** (`pnpm format-test`, on "Format Test Recipe", 2026-11-03):
  - Bold "Ingredients"/"Method" paragraphs can be turned into real `#### Ingredients` / `#### Method`
    subsections in one `edit_blocks` call. Replace the blocks from "Ingredients" onward, and put anything that
    should stay in the recipe's own section (like the date) *before* the new headings, since headings must come last.
    After that, each subsection has its own `section_id` and rev.
  - Subsections, like all headings, can't be renamed or removed later except by hand in docs.plus.
- **Media:**
  - `edit_blocks` turns `![alt](https://…)` into a picture, and a line holding only a YouTube URL into a player.
    This works in a recipe section and in a `####` subsection. There is no upload: the media must already be online.
  - It reads back escaped, as `\[image\]` / `\[youtube\]`, not `[image]`. **Text a person typed as "[image]" reads back
    exactly the same**, so a read alone can't tell them apart. The app treats both as media and never edits them.
    It should also refuse submitted text containing such placeholders.
  - Removing media is refused: "remove_blocks: block(s) 4 hold a picture, video or file, and docs.plus never deletes
    media for an AI app…" (`invalid_input`). Editing the text blocks around media works, and the media stays.
- Not tested yet: "could not confirm the write", and the not-owner and rate-limit texts.

## Layout

```
server/src/auth/   TokenStore interface, FileTokenStore (.secrets/), DocsPlusOAuthProvider, callback server
server/src/mcp.ts  MCP Client + StreamableHTTPClientTransport (@modelcontextprotocol/sdk 1.32.1, pinned)
server/src/docsPlus.ts  typed wrapper (outline, sections, edits, append, chat) + parsers
server/src/recipes.ts   RecipesService: list/read/save/add, with check-only variants for the approval queue
server/src/app.ts       Hono routes: public API, protection pipeline, admin (approval) routes
server/src/protect/     client IP, rate limits, Turnstile, audit log
server/src/queue.ts     approval queue (DATA_DIR/pending)
server/src/photos.ts    photo links: safe link check, our record of links per recipe
server/src/chat.ts      optional chat summaries
server/src/scripts/     login, check, token-info, export-login, audit-log, queue, test-doc tools
server/src/recipeForm.ts  form fields ↔ booklet Markdown
web/src/main.tsx   pages: list, recipe, edit/add form
web/src/api.ts     typed client for /api (the browser never talks to docs.plus)
web/src/turnstile.tsx  Cloudflare Turnstile widget
```

## License

MIT. See [LICENSE](LICENSE).
