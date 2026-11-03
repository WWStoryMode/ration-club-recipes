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

> **Status: Phase 4a.** Backend API (`server/`) for **one always-on server**, with abuse protection: input
> cleaning, rate limits, Cloudflare Turnstile, a honeypot and an audit log. Not built yet: approval queue and chat
> summaries (4b), front end, deploy config, `/health`.

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
| `GET /api/recipes/:id` | One recipe: `fields` (head chef, support, date) and `sections` (the recipe, then its subsections). Each section has a `rev` and `parts`: text parts are editable, media parts (`{type:"media", kind:"image"}`) are fixed. |
| `PUT /api/sections/:id` | Body `{ baseRev, texts }`. Send one string per text part, in order, plus the `rev` you loaded. Returns the updated section with its new `rev`. |
| `POST /api/recipes` | Body `{ title, markdown? }`. Appends `### **Title**` + body at the end of the booklet. An empty body gets the Head Chef / Support / Ingredients / Method template. Returns 201. |

**How saving works:** the server takes a per-document lock, then re-reads the section. If its rev isn't
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

## Protection

Every write (`PUT /api/sections/:id`, `POST /api/recipes`) passes these checks, in order:

1. **Rate limits:** per visitor IP, then for the whole app. Over the limit → `429` with `Retry-After`. These requests aren't audited, so a flood can't fill the disk.
2. **Honeypot:** a hidden form field (`website`, from `GET /api/config`). People never fill it; bots that fill every field do. → `422`.
3. **Cloudflare Turnstile:** the page sends `turnstileToken`, and the server checks it with Cloudflare. → `422` if it's missing, failed or expired. If Cloudflare can't be reached → `503`.
4. **Input cleaning** (`server/src/validate.ts`):
   - Text is normalised to Unicode NFC, and invisible control, zero-width and **text-direction** characters are removed, so they can't hide content or slip past the rules.
   - Refused: headings, images, `[image]`-style placeholders, a link alone on a line, code blocks, HTML, links that aren't `https://`/`mailto:` (`javascript:`, `data:`, relative…), more than 5 links, and more than 20,000 characters.
5. The write itself (lock, `baseRev` check, …), then **one audit line**.

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
  - action and outcome (`saved`, `unchanged`, `added`, `conflict`, `refused`, `blocked`, `failed`) with the reason
  - recipe and section, base and new rev
  - the text **before and after**; for refused attempts, what was attempted, truncated to 2,000 characters
- **No IP addresses**, only `ipHash`: an HMAC of the IP with a secret salt (`AUDIT_SALT`, or generated once into
  `DATA_DIR/audit-salt`). The same visitor gets the same hash, so floods can be spotted, but the IP can't be read back.
- `DATA_DIR` must be on the persistent disk in production (e.g. `/data/audit`). The log holds visitor text, so treat
  it as private. A failed audit write is logged as an error and doesn't block the visitor's save.

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
  behind rate limits, a honeypot, Turnstile and input cleaning. See [Protection](#protection).
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

Railway, Fly or Render all work. The requirements:

- **Exactly one instance.** Turn off autoscaling and replicas. Separate machines can't see each other's lock.
- **A persistent disk** mounted at `SECRETS_DIR` (e.g. `SECRETS_DIR=/data/secrets`). Without it, every
  redeploy loses the rotated token and you'd have to sign in again.
- `HOST=0.0.0.0`, and `PORT` as the platform requires. `DOC_SLUG` = the booklet to edit.
- `NODE_ENV=production`, `DATA_DIR` on the same disk (e.g. `/data/audit`), `CLIENT_IP_HEADER`, and the Turnstile keys.
  See [Protection](#protection).

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
server/src/docsPlus.ts  typed wrapper (getOutline, readSection, editBlocks, replaceText, appendRecipe) + parsers
server/src/scripts/     login, check, token-info
web/               Vite + React (placeholder)
```

## License

MIT. See [LICENSE](LICENSE).
