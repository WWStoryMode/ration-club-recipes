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

> **Status: Phase 1.** Auth plumbing, `login` / `check` / `token-info` scripts, and the typed
> docs.plus wrapper with parser tests. No API routes or UI yet.

## Setup

Needs Node ≥ 20 (`.nvmrc` pins 24) and pnpm via corepack.

```sh
nvm use               # or nvm install
corepack enable       # provides pnpm 11 (pinned in package.json)
pnpm install
cp .env.example .env  # optional: the defaults point at the real doc
brew install gitleaks # required by the pre-commit hook
pnpm test
```

> Use `pnpm run login`, **not** `pnpm login`. `pnpm login` is pnpm's own npm-registry login and
> takes precedence over the package script.

| Command | What it does |
|---|---|
| `pnpm run login` | One-time OAuth sign-in to docs.plus. Opens your browser. Safe to rerun. `-- --force` signs in again from scratch. |
| `pnpm check` | Read-only: lists the MCP tools and your documents, prints `OWNER: yes/no` for `DOC_SLUG`, and prints its outline. |
| `pnpm token-info` | Shows token facts (has refresh token, expiry). Never prints tokens. `-- --refresh` tests a refresh and whether it rotates. |
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
- Secrets never go into git. `.secrets/` and `.env*` are gitignored, and only `.env.example`, with placeholders, is committed.
- A **gitleaks** pre-commit hook (`.husky/pre-commit`, rules in `.gitleaks.toml`) blocks commits containing tokens. It refuses to commit if gitleaks is not installed.
- `.github/CODEOWNERS` marks the hook, package and secret-scanning files as needing the owner's review. Review any change to `.husky/` or `prepare` scripts carefully: they run on your machine.
- **Enable GitHub secret scanning push protection** on the repo: Settings › Code security › Secret Protection › Push protection.
- All MCP calls are server-side. Visitors never get a token and can only reach the narrow API the backend exposes. Rate limiting, Turnstile, an audit log and input cleaning come in later phases.
- docs.plus treats document text as data. The app parses it and never acts on it as instructions.
- Scripts print token *facts* (expiry, a short SHA-256 prefix), never token values.

## Deployment implications

Measured on 2026-11-02 with `pnpm token-info -- --refresh`:

| Question | Answer |
|---|---|
| Refresh token issued? | **Yes** |
| Access token lifetime | **3600 s (1 hour)**, a JWT |
| Refresh rotates the refresh token? | **Yes.** Each refresh returns a new one. |

What this means:

- Each refresh **uses up** the stored refresh token. The new one must be saved before anything else
  happens. If two processes refresh with the same token at once, Supabase may treat it as reuse and revoke the
  whole session, and then someone has to run `pnpm run login` again.
- **Serverless (Vercel + Upstash):** tokens must live in Redis (`RedisTokenStore`, not a file). Take a
  Redis lock around refresh, re-read the tokens after getting the lock (another function may already have
  refreshed), and write the rotated token before releasing the lock.
- **One always-on server:** `FileTokenStore` on a persistent volume works, but refreshes still need an
  in-process mutex. Without a volume, a redeploy loses the rotated token. Redis is the safer choice either way.
- If the app is idle longer than the refresh token lives, a login is needed again. The `/health` check
  (later phase) should exercise the token regularly and alert when it fails.

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
