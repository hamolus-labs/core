# Architecture

How the packages fit together and how a request flows through the system. The
diagram below shows the main request path (site + console → core); the
[`_panels`](#panels-packagespanel--packagescli), `_plugins`, and MCP surfaces hang
off the same core API.

```
                 ┌──────────────────────────────────────────────┐
                 │               upstream: site/console          │
                 │   (Cloudflare Pages · Astro / SolidJS SPA)   │
                 └───────────────┬──────────────────────────────┘
                                 │ HTTPS  (Site passes Bearer token; console too)
                                 ▼
                 ┌──────────────────────────────────────────────┐
                 │            packages/core (Workers)           │
                 │  Hono app  → /api/*                          │
                 │   ├── JWT auth middleware (HS256)            │
                 │   ├── /api/_auth/token   (login key → JWT)   │
                 │   ├── /api/_meta/collections  (metadata CRUD)│
                 │   ├── /api/_meta/settings   (KV settings)    │
                 │   └── /api/{collection}       (dynamic CRUD) │
                 └───────┬───────────────┬──────────────────────┘
                         │ D1           │ KV
                         ▼              ▼
                    metadata tables   settings blob
                    + dynamic tables  ("settings:v1")
```

## The core (packages/core)

A single Cloudflare Worker using **Hono**, **Drizzle ORM (D1/SQLite)**, and
**Cloudflare KV**.

- `src/index.ts` — the Hono app. All `/api/*` routes require a JWT, except
  `GET /api/health` and `POST /api/_auth/token`. When the `PUBLIC_GETS=true` env var
  is set, **GET** endpoints become public (used to let the site build without a token).
- `src/meta/store.ts` — the *registry*. Collection definitions are stored in the
  `_meta_collections` D1 table and cached in the isolate. Any `PUT
  /api/_meta/collections/{name}`:
  1. validates the definition with the Zod schema from `packages/types`;
  2. runs `CREATE TABLE IF NOT EXISTS` for the physical table;
  3. migrates **new** fields onto existing tables with `ALTER TABLE … ADD COLUMN`
     (deduplicated against `PRAGMA table_info`);
  4. upserts the metadata row.
- `src/db/table.ts` — SQLite DDL helpers: `TEXT` columns for most types,
  `NUMERIC` for numbers, `INTEGER` for booleans; `id` columns store UUIDs.
- `src/db/queries.ts` — generic `list / get / create / update / delete` over any
  collection definition, with whitelisted identifiers (SQL-injection safe).
- `src/db/coerce.ts` — value coercion into/out of D1 (`boolean → 0/1`,
  `json → TEXT`, numbers, etc.).
- `src/meta/settings.ts` — KV-backed settings blob under the `settings:v1` key.
- `src/meta/groups.ts` — self-parenting navigation group registry
  (`_meta_groups` table, auto-bootstrapped like `_meta_collections`): `listGroups`,
  `putGroup` (parent-exists + cycle + snake_case validation), `deleteGroup`
  (referential guards). An arbitrarily deep `parent` chain arranges collections
  into a navigation tree; `packages/types` `buildGroupTree` resolves registered
  groups + collection definitions into a normalized tree (unknown
  `collection.group` values become implicit root groups).
- `src/routes/panels.ts` — Panel registry, manifest CRUD, runtime bootstrap, scoped
  dashboard/record APIs, and private asset upload/list/delete endpoints. Panel
  requests require a session and are further constrained by panel membership, role
  view access, field projection, and mandatory filters; global admins/super-admins
  bypass membership.
- `src/media/panel-assets.ts` — private Panel asset metadata store and HMAC-signed
  URL helpers. Panel assets use R2 keys under `panels/{land}/{panelId}/` and are
  served only through the signed `/panel-assets/{id}` route, never the public media
  or file-library routes.
- `src/routes/{auth,meta,dynamic}.ts` — route groups.

### Bootstrapping

On the isolate's first use, `ensureMetaTable` creates `_meta_collections` and
backfills any columns added in later versions (e.g. `group`); `ensureGroupsTable`
creates `_meta_groups`; `ensurePanelTable` creates `_meta_panels`; and the first
Panel asset request creates `_meta_panel_assets`. D1 tables are created lazily on
their first `PUT` definition. Nothing runs at deploy time.

**Never cache a `Promise` in module scope.** In a Worker, a promise created while
serving one request and awaited during another carries the first request's I/O
context into the second, which workerd rejects with `Cannot perform I/O on behalf
of a different request` (surfacing as HTTP 500 only under concurrency — sequential
requests always pass, so it is easy to miss). The same applies to caching a
*resolved value* that was produced under another request's context. Every
idempotent bootstrap therefore follows the same shape:

```ts
let ready = false // completion latch, not a promise
export async function ensureThingTable(db: Db): Promise<void> {
  if (ready) return
  const boot = db.run(sql`…`).run() // function-local: never escapes this call
  await boot
  ready = true // only on success, so a failure retries
}
```

Cached *registries* (the lands registry, the collection-name set, the panel
manifest map) hold plain resolved values instead, and are invalidated through the
existing invalidation helpers. Concurrent misses may each run the idempotent
bootstrap and overwrite the cache — that is intentional and safe.

## Multi-tenancy (lands / colonies)

A single core instance can serve one or more **lands** (scopes), each optionally
split into **colonies**. Tenant behavior is gated by `CORE_MODE`
(`independent` [default — single-tenant] | `centralized` [every per-land request
must carry a tenant] | `proxy` | `bridge`) and `DEFAULT_LAND`. `src/tenant.ts`
owns the machinery; `meta/lands.ts` and `meta/colonies.ts` are the registries.

- **URL grammar**: CORE `/api/{land}[/{colony}][/{group…}]/{collection}[/{id}…]`,
  PROXY `/api[/{group…}]/{collection}[/{id}…]`, BRIDGE via `upstreams:v1`. A
  pre-auth rewrite strips a registered land[/colony] prefix into `x-land`/
  `x-colony` headers (`x-scope-rewritten` loop guard), re-dispatching through the
  whole middleware chain.
- **Isolation**: `physicalTable(land, name)` — bare `{name}` for the default land,
  `{land}__{name}` otherwise — applies to collections, per-land records and
  `{land}__privileges`. Settings are KV-isolated under `settings:{land}:v1`
  (default keeps legacy `settings:v1`). `config` rows key on `(land, key)`.
- **Auth**: one global `_auth_users` table keyed by `(land, colony, id)` with a
  globally unique `username`; login resolves the scope from the username row and
  JWTs carry `land` + `colony` + `scope` claims. A header/claim mismatch is
  `403 SCOPE_MISMATCH`. Admin-key tokens carry no scope claim (scope-agnostic).
  Privileges bootstrap lazily per scope with stable UUIDs, so role ids match
  across scopes. Three privilege scopes: `universe` (superadmin), `land`
  (`land_admin`, owns one land and its colonies) and `colony` (everyone else).
- **Scopes**: global paths are `health`, `_auth/{token,login,setup,me,supers}`,
  `_meta/universe/{lands,colonies}`; everything else (settings/groups/collections/
  stats, users/config, media/document/attachment libraries, dynamic CRUD) is
  scoped.
- **Strict mode**: in `centralized`, a request with no `x-colony`/`x-land` header
  and no JWT scope claim hitting a per-scope path is rejected with
  `400 SCOPE_REQUIRED` (the global allowlist is prefix-matched, so
  `/api/_meta/universe/lands/{id}` stays global).
- **Isolation**: collections, the `privileges` bootstrap table and every record
  table live in a per-land table namespace (`{land}__{name}`), settings KV is
  keyed `settings:{land}:v1` (the default land keeps `settings:v1`), and the
  media / document / attachment libraries carry a `land` column. Auth users are
  global with a `land` column and a JWT `land` claim.
- **Deletion is a purge**: `meta/lands.ts::deleteLand` drops metadata first
  (collections *and* their physical tables, privileges, groups, config, users,
  panels, libraries) and R2/KV bytes last, then invalidates the caches. Because
  the land id is part of the physical table name, dropping the tables is what
  stops a re-created land from inheriting old state. See
  [docs/api.md](./api.md#lands--colonies-_metalands-_metacolonies).

## The console (packages/console)

A client-rendered **SolidJS** single-page app with **@tanstack/solid-query** for data
and **@stylexjs/stylex** for styling.

- Talks only to the core API, proxied in dev via Vite (`/api → http://localhost:8787`).
- The API base is **user-settable**: the login form and a navbar **API endpoint**
  switcher manage a saved endpoint list (`console-endpoints`,
  `console-active-endpoint`); absolute endpoints bypass the Vite proxy and go
  direct (CORS enabled on `/api/*`). JWTs are stored **per endpoint**
  (`console-token:{url}`) and attached as a `Bearer` header by `lib/api.ts`.
- UI preferences (theme, collapse state, visible columns, container mode) are kept in
  `localStorage` under `console-*` keys.

## Front-ends

Hamolus ships no fixed front-end: a project assembles its own UIs from the core
API, and every one of them is generated by the CLI.

- **Console** — a SolidJS + Vite single-page app (`packages/console`, added with
  `hamolus add console`) for browsing collections, records, media, panels, lands
  and settings. Deployed as a Worker with static assets
  (`not_found_handling: "single-page-application"`), so every unknown path falls
  through to `index.html` and the router resolves it client-side.
- **Panel** — a data-defined app surface rendered by a generated SolidJS app
  (`hamolus add panel`) using `@hamolus/panel`. The manifest decides which
  collections, operations and fields a user may touch; see [Panels](#panels).
- **MCP** — `@hamolus/mcp` exposes the same core API to AI agents as MCP tools
  (`hamolus add mcp`); see [MCP](#mcp-packagesmcp).

In development the console proxies `/api` to the core (Vite `server.proxy`), so
the browser talks to one origin and no CORS preflight is involved. A panel app
calls the core directly and therefore needs the core to allow its origin.

## Panels (`packages/panel` + `packages/cli`)

A Panel is a **data-defined** app surface: a `PanelDefinition` manifest stored per
land in `_meta_panels` describes views bound to collections (operations, field
ACLs, filters, sort, metrics), a menu, roles and members. Nothing about a Panel
is code in the core — the core only validates and enforces the manifest.

```
   ┌──────────────────────────────────────────────────────────┐
   │  generated app (packages/cli template)             │
   │   SolidJS + Vite  ·  vite build → static assets          │
   │   uses @hamolus/panel  (PanelClient, a fetch wrapper)       │
   └───────────────────────┬──────────────────────────────────┘
                           │ GET /api/_panels/{id}/bootstrap
                           │   → manifest RE-FILTERED to this user
                           ▼
   ┌──────────────────────────────────────────────────────────┐
   │ core: /api/_panels                                      │
   │  manifest routes  → panels.read / panels.write           │
   │  runtime routes   → any valid session; manifest ACL only │
   │  view records / relations / dashboard / assets           │
   └──────────────┬────────────────────────────┬──────────────┘
                  │ D1                         │ R2
                  ▼                            ▼
        _meta_panels                   panels/{land}/{panelId}/
        (+ _meta_panel_assets)          (private, signed URLs)
```

Two things make this different from the console:

- **The client never receives the real manifest.** `bootstrap` resolves the
  caller to a role *within that panel*, then returns the manifest with
  unauthorized views dropped, `menu` pruned, `fields` replaced by the effective
  read/write ACLs, and a single effective role. Enforcement is server-side; the
  browser can only ever see what it was granted. This is why the seeded
  `panel_user` role needs **no** global permissions.
- **Manifest routes and runtime routes use different auth.** Authoring a Panel
  needs the global `panels.read`/`panels.write`; *using* one needs only a
  session. So a least-privilege Panel user can be given a token and see exactly
  their own views.

Deleting a Panel cascades its private assets (metadata rows, then R2 keys), so
`DELETE /api/_panels/{id}` never orphans bytes or rows.

The CLI (`packages/cli`) copies `template/` into a new directory and
substitutes the app id/name. Because the template lives inside the repo, it is
typechecked as part of the workspace: `packages/cli/tsconfig.json` checks
`template/src` and `template/vite.config.ts` against the template's compiler
options **and** the real `@hamolus/panel` types, so client/template drift fails
`pnpm typecheck` instead of surfacing in generated apps. The template stays
outside `pnpm-workspace.yaml` on purpose — a generated app's `workspace:*`
dependency would only resolve inside this repo.

## data flow for a page load (site → core)

1. Astro requests `/posts`.
2. Frontmatter calls `getCollections()` and `getRecords('posts')`.
3. `lib/api` composes the URL from `CORE_API_URL`, attaches the token if present.
4. Core runs JWT middleware, parses the route, builds a whitelisted SQL query,
   runs it against D1, and returns `{ data, meta }`.
5. Astro renders the table (or a “no records” fallback) inside the `Base` layout,
   whose header/brand are driven by `GET /api/_meta/settings`.

## identifiers are SQL-injection-safe

Every table/column name from user input (collection names, field names, sort keys,
filter keys) passes through `isIdentifier` / `quoteIdentifier`:

- identifiers must match `^[a-z][a-z0-9_]*$` or the request is rejected;
- identifiers are quoted (`"name"`) when interpolated into SQL;
- values are passed as bound parameters (Drizzle `sql` values), never interpolated.