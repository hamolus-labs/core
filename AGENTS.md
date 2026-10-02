# `@hamolus/core` — the API Worker

Hono app on Cloudflare Workers. Owns D1 (via drizzle), the API, auth, scope
resolution, media/files, and the boot-time application of code-defined collections and
panels. A generated project owns only a thin seam file that hands this package to
Wrangler.

## Ships raw TypeScript

`package.json#types` and `#main` point at `./src/index.ts`, and `files` ships `src/`.
That is deliberate: a project can wrap the Worker in its own entry — add middleware,
mount extra routes, install an error handler — without forking the package or adding
a build step. Wrangler/esbuild compile the `.ts` entry directly.

Consequence: **a syntax error in `src/` breaks every generated project at once**, and
the header block in every file here is read by consumers. There is no `dist` to hide a
mistake behind.

## Commands

```bash
pnpm -F @hamolus/core typecheck
pnpm -F @hamolus/core dev              # wrangler dev, http://localhost:8787
pnpm -F @hamolus/core deploy
pnpm -F @hamolus/core db:generate      # drizzle-kit generate
pnpm -F @hamolus/core db:studio
pnpm -F @hamolus/core db:setup         # apply scripts/bootstrap.sql to the local D1
```

`build` is `wrangler deploy --dry-run` — it is a compile check, not a bundle.

## Layout

| Path | Holds |
| ---- | ----- |
| `src/index.ts` | the app: middleware chain, `applyScope`, re-exports for a host's entry |
| `src/routes/` | one file per HTTP surface: `auth`, `meta`, `collections`+`dynamic`, `media`, `files`, `panels`, `lands`, `config`, `plugins`, `seed` |
| `src/db/` | drizzle client, schema, DDL map, value coercion, query builders, per-land pooling |
| `src/meta/` | the metadata tables: settings, lands/colonies, groups, panels, stats, seed |
| `src/auth/` | password hashing, sessions/JWT, privileges, super-admin bootstrap |
| `src/media/`, `src/files/` | R2-backed media, file storage, signed panel assets |
| `src/config.ts` | build-time project config (`core.config.ts`), applied before the first request |
| `src/version.ts` | `CORE_VERSION`, reported on `/` and `/api/health`. Exported from the `@hamolus/core/version` subpath — **never** re-exported from `src/index.ts`, because workerd rejects any named export of a Worker entry that is not a handler |
| `src/definitions.ts` | code-defined collections and panels, applied on boot per scope |
| `wrangler.jsonc` | bindings and `CORE_MODE`; copied from `templates/cores/*` when a project is generated |

## Modes and scope

`CORE_MODE` is one of `independent`, `centralized`, `proxy`, `bridge` (see
`CORE_MODES` in `@hamolus/types`). `independent` is a single scope with the
land/colony layer off, and it is the only mode that sets `PUBLIC_GETS=true` — every
site and app example silently breaks on a core created in another mode.

`applyScope` resolves `x-land` / `x-colony` into a scope **before** anything else
runs, then bootstraps that scope's privileges and its code-defined collections and
panels in the same pass. An unknown land/colony mints nothing.

## Invariants

- **Collections are created at runtime.** A collection is a `_meta_collections` row plus
  a D1 table; `PUT` only ever *adds* columns. Dropping, renaming or retyping a field is
  a manual D1 migration. Say so wherever a reader would expect `PUT` to do it.
- **Media and panel assets are signed, not public.** Panel asset URLs are short-lived
  (`getPanelAssetUrl` in `@hamolus/panel` exists because of that). A public
  `/media/...` URL needs no token; a private file does not come back from
  `GET /api/{collection}/{id}`.
- **A request carrying an unknown `x-land`/`x-colony` must not mint privileges.**
  Gate: `check:scope-colony-resolution`.
- **A failed definition write leaves the previous definitions standing** rather than
  half-applied. Gate: `check:code-definitions`.
- The core **does not aggregate**. It returns `meta.total`, `meta.totalPages` and
  `lastUpdate`; business aggregation belongs in the caller.

## Gates

Offline, always runnable:

```bash
pnpm check:code-definitions
pnpm check:localization
```

Need a core running on `127.0.0.1:8787` (`pnpm -F @hamolus/core dev`):

```bash
pnpm check:panel-acl
pnpm check:mcp-instance-acl
pnpm check:scope-colony-resolution
pnpm check:config-scope-acl
pnpm check:config-migration
pnpm check:localization-api
```

`check:panel-acl` is the one that says "a locked input is the correct behaviour" — a
panel view's `fields.write` is enforced over HTTP, not in the UI.

`check:mcp-instance-acl` exists because an MCP instance is the one resource whose
*credential* is also its *identity*: a worker authenticates with its instance id
before it knows its own scope, and the console issues per-user tokens that are
redeemed for a narrower session. Three things there are easy to break without noticing,
and the gate pins all of:

- **The machine routes are mounted before the JWT middleware** (`index.ts:84`, against
  the operator mount at `index.ts:621`). A worker holding an instance id cannot send
  `x-land`/`x-colony` — it does not know its scope yet, which is the thing it is asking
  for — so those two handlers resolve nothing from the request. Moving them below the
  middleware makes every deployment fail with a 400 on a `centralized` core.
- **A token belongs to one instance.** `verifyMcpToken` takes the header's instance id
  as a third argument and compares it to the row. Drop that check and a token issued
  for a narrow read-only instance is redeemable through some other instance's worker, so
  the permission intersection never happens and the read-only guarantee is gone. It
  looks redundant because almost every caller passes a matching pair.
- **The status code is part of the contract**: `401` the credential is not accepted,
  `403` the credential is fine but the instance is switched off, `400` the request is
  malformed. The *message* must never separate "unknown id" from "revoked token" or ids
  become enumerable; only the status may.
- **Only a worker may write `reported_version` / `last_seen_at`.** They are what the
  console shows as "deployed, running vX", so an operator-writable version would let the
  console certify a release that is not deployed. Neither key is in
  `mcpInstanceCreateSchema`/`Update` (strict, so a body naming one is a 400), and
  `touchMcpInstanceHeartbeat` is the single writer — called *after* the credential is
  accepted, or a probe of a guessed id marks a live deployment as alive. It does not
  touch `updated_at`: a heartbeat every minute would make an untouched instance look
  edited.

`check:config-scope-acl` exists because a `_configs` row is keyed by
`(land, colony, key)`: the `?land=` / `?colony=` query on `/_config` is a *request*, and
the bug it invites is reading it as a grant. It also pins that reach follows the
privilege's **scope** and never its name — the default colony role is called `admin`, so
`role === 'admin'` would hand every colony administrator the whole platform.

`check:config-migration` boots a real core on a scratch D1 holding a pre-`scope`
`_configs` table — one key under two scopes, which is what `(scope, key)` used to allow
and `(land, colony, key)` does not. It is the only check of the rebuild's data handling,
and it fails loudly if the copy is not collision-tolerant.

## Conventions

- Copyright/author/SPDX header at the top of every file, verbatim (`pnpm check:copyright`).
- `scripts/*.sql` uses `--` comments; the notice follows that shape.
- New endpoint ⇒ new file in `src/routes/` with a doc comment saying what it refuses,
  not just what it returns.
