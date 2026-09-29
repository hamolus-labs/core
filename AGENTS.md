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
pnpm check:scope-colony-resolution
pnpm check:config-scope-acl
pnpm check:config-migration
pnpm check:localization-api
```

`check:panel-acl` is the one that says "a locked input is the correct behaviour" — a
panel view's `fields.write` is enforced over HTTP, not in the UI.

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
