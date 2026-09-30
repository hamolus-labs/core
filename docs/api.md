# Core API reference (`packages/core`)

Base URL: `http://localhost:8787/api` locally; your Worker URL in production.

All responses are JSON:

```jsonc
// success (single item / list)
{ "data": { ... } }            // ItemResponse
{ "data": [ ... ], "meta": { "page": 1, "pageSize": 20, "total": 3, "totalPages": 1 } }  // ListResponse

// error
{ "error": { "code": "NOT_FOUND", "message": "..." } }
```

## Authentication

Every `/api/*` request except `GET /api/health` and `POST /api/_auth/token` must
carry a JWT signed with HS256.

**Scope headers.** When the core runs multi-scope (`CORE_MODE=centralized`; see
`docs/architecture.md` → Multi-tenancy), per-scope endpoints require `x-colony`
(or, for land-admin tooling, `x-land`) to select the land/colony, otherwise they
return `400 SCOPE_REQUIRED`. Global endpoints (`/api/health`, `/api/_auth/*`,
`/api/_meta/universe/lands`, `/api/_meta/universe/colonies`) ignore them. In
standalone mode (`CORE_MODE=independent`, the default) the headers are optional and
default to `DEFAULT_LAND` / `root_cny`. The console sends `x-colony` automatically
when an endpoint has a colony set; the site forwards `CORE_LAND` / `CORE_COLONY`.

**Login** — exchange the admin key for a token:

```bash
curl -X POST http://localhost:8787/api/_auth/token \
  -H 'content-type: application/json' \
  -d '{"key":"dev-admin-key-change-me"}'
# → { "data": { "token": "<jwt>", "expiresAt": "…" } }
```

Use the token on subsequent calls:

```bash
curl http://localhost:8787/api/posts -H 'authorization: Bearer <jwt>'
```

> **Public GETs (optional):** set `PUBLIC_GETS=true` in the worker env to allow all
> `GET` endpoints without a token (handy for the site's SSG build and for simple
> read-only frontends). Keep it unset if the data should stay private.

### Auth endpoints

| Method | Path                   | Auth | Description |
| --- | --- | --- | --- |
| POST | `/_auth/token`           | public   | Exchange `ADMIN_KEY` for a legacy all-access token (`sub: 'admin'`, no permissions claim). |
| GET  | `/_auth/setup`           | public   | `{ setupRequired }` — whether the first admin still needs provisioning. |
| POST | `/_auth/setup`           | public   | Create the first admin (only valid while the users table is empty) → login response. |
| POST | `/_auth/login`           | public   | `{ username, password }` → login response (user + permissions). |
| GET  | `/_auth/me`              | any JWT  | Resolve the current session (works even under `PUBLIC_GETS`). Legacy `sub:'admin'` → synthetic admin. |
| POST | `/_auth/me/password`     | any JWT  | **Self-service password change.** Body `{ currentPassword, newPassword }`; verifies the current password, re-hashes and updates the caller's own row. No permission required (any role). Legacy admin-key sessions have no password → `400 ADMIN_KEY_SESSION`. |
| GET  | `/_auth/users`           | `users.read` | List managed users. |
| POST | `/_auth/users`           | `users.write` | Create a user. |
| PUT  | `/_auth/users/{id}`       | `users.write` | Update name / privilege / `isActive` / reset password (last active admin protected). |
| DELETE | `/_auth/users/{id}`     | `users.write` | Delete a user (last active admin protected). |

## Health

```bash
curl http://localhost:8787/api/health   # → { "ok": true, "service": "core" }
```

## Collection metadata (`/_meta/collections`)

A **collection definition** is the schema of one table:

```jsonc
{
  "name": "posts",           // = D1 table name, snack_case, ^[a-z][a-z0-9_]*$
  "label": "Posts",          // human label
  "description": "…",        // optional
  "group": "content_blog",   // optional; a registered group id (see /_meta/groups) — the console renders it as a nested nav tree
  "icon": "file",            // optional; SVG icon name for the console sidebar nav
  "timestamps": true,        // adds created_at/updated_at
  "softDelete": false,       // adds deleted_at; deletes are soft
  "primaryKey": "id",        // defaults to "id"
  "fields": [ /* FieldDefinition[] — see below */ ]
}
```

`icon` is one of the console's named collection icons (box, file, users, tag, mail,
folder, grid, list, code, database, star, calendar, zap, heart); unknown/empty names
render a folder glyph. Stored as metadata — no DDL/route change beyond the
`_meta_collections` `icon` column.

### FieldDefinition

```jsonc
{
  "name": "title",          // snack_case
  "label": "Title",         // optional; human label for forms/tables (falls back to title-cased name)
  "type": "string",         // id|string|slug|text|richtext|number|currency|custom_currency|boolean|date|datetime|enum|json|email|url|relation|media|document|attachment
  "required": true,         // optional
  "unique": true,           // optional → UNIQUE column
  "indexed": true,          // optional
  "default": null,          // optional
  "minLength": 1, "maxLength": 160,   // string/text
  "min": 0, "max": 100,               // number
  "enumValues": ["news", "dev"],      // enum only
  "relation": { "collection": "categories", "field": "id", "onDelete": "setNull" }, // relation only
  "hidden": false,            // excluded from API *output*
  "consoleView": "normal",    // optional: normal|side|header|footer — console form placement
  "group": "Publishing",      // optional: group into a collapsible form section
  "groupOpen": false,         // optional: group section starts collapsed (default true)
  "format": "lexical",        // optional, richtext only: lexical|markdown|mdx (default lexical)
  "control": "search"         // optional input widget: combobox|search|radio|toggle|checklist|multichecklist
}
```

Notes:

- `type: "media"` — references a R2 media asset. Stored as a self-contained JSON
  object `{ "id": …, "url": "…", "alt": null, "width": null, "height": null }`
  (the `url` is an absolute public URL that needs no auth to render). The console
  renders it as a thumbnail with a media-picker; the site renders it as an `<img>`.
- `type: "document"` / `type: "attachment"` — reference a file-library item.
  Stored as a self-contained JSON snapshot `FileRefValue`
  `{ "id": …, "url": "…", "name": "…" }` (the `url` is the absolute public R2 URL
  served from `/documents/<key>` or `/attachments/<key>`). The console renders
  them via a file picker (`FileFieldInput`); the two kinds differ only in which
  file library they read from (see "Files" below).
- `type: "richtext"` — content-rich field with a configurable sub-format. With the
  default `format: "lexical"` the value is Lexical editor state JSON and the site
  converts it to HTML, including embedded `media` images. With `format: "markdown"`
  or `"mdx"` the value is a **plain markdown string** (mdx is a markdown superset —
  JSX stays escaped as text when rendered); the console authoring UI becomes a
  Write/Preview markdown editor and the site renders it through the shared
  `markdownToHtml` renderer (escaped output, safe links only). Localized richtext
  works for both formats: reads without `?locale=` return the full `{en,id}` object,
  with `?locale=` the resolved string. `format` is only valid on richtext fields —
  the definition PUT rejects it elsewhere (400 INVALID_COLLECTION).
- `control` — the input widget the console renders for `enum`, `relation`, or
  `boolean` fields (the definition PUT rejects it on other types). Allowed per type:
  `enum` → `combobox|search|radio|checklist|multichecklist`; `boolean` →
  `toggle|radio`; `relation` `belongsTo`/`hasOne` → `combobox|search|radio|checklist`;
  `relation` `hasMany` → `search|multichecklist`. With `control` unset the defaults
  apply (enum/belongsTo → native `<select>`, boolean → checkbox, hasMany → tag
  chips). A `multichecklist` **enum** stores a JSON array (`z.array(z.enum(...))`)
  in the TEXT column and is parsed back on read, mirroring `relation` hasMany;
  a `multichecklist` `relation` stores an array of target PKs.
- `type: "currency"` — a monetary amount stored as a REAL column (direct number,
  not text). `currency` is the ISO 4217 code (`"IDR"`, `"USD"`, `"EUR"`; defaults
  to `IDR`) and must be three uppercase letters. The symbol and the conventional
  decimal count come from the code, the separators from the requested `?locale=`.
  Read responses always shape it as a `MoneyValue`
  `{ "base": 250000, "currency": "IDR", "display": "Rp 250.000" }` (`Rp 250,000` for
  `locale=en`) — `base` is the raw amount in `currency`, so a site can patch
  `display` with a live exchange rate without re-reading the record. Writes accept
  a number (normalized to the amount) or the object, so a read value round-trips.
- `type: "custom_currency"` — the same REAL column for a unit that has no ISO
  code: loyalty points, credits, billable hours, `Rp /bulan`. The field carries its
  own `customCurrency` block — `symbol`, `prefix`, `suffix`, `position`,
  `space`, `decimals`, `grouping`, `decimalSeparator`, `thousandSeparator` and a
  `negativePattern` with `{amount}` / `{symbol}` placeholders. Reads return
  `{ "base": 1500000, "symbol": "€", "display": "€1.500.000,00" }` with the
  `null` symbol when the field declares none. `customCurrency` is only valid on a
  `custom_currency` field, exactly as `format` is richtext-only.

Endpoints:

| Method | Endpoint                                   | Purpose                              |
| ------ | ------------------------------------------ | ------------------------------------ |
| GET    | `/_meta/collections`                       | List all definitions                 |
| GET    | `/_meta/collections/{name}`                | Get one definition                   |
| PUT    | `/_meta/collections/{name}`                | Create/update + auto-create table    |
| DELETE | `/_meta/collections/{name}`                | Drop the table and its metadata      |

`PUT` is idempotent and **migrates**: newly added fields are `ALTER TABLE … ADD
COLUMN`-ed onto the existing physical table (based on `PRAGMA table_info`). Deleting a
collection physically drops the table — be careful.

## Navigation groups (`/_meta/groups`)

A self-parenting registry that arranges collections into an arbitrarily deep
navigation tree (`Content → Blog / Docs / Showcase`). Auto-bootstrapped like
`_meta_collections`; every `collection.group` value that isn't a registered id
still renders as an implicit root group in the console (label = the raw value).

| Method | Endpoint            | Behavior                                                          |
| ------ | ------------------- | ----------------------------------------------------------------- |
| GET    | `/_meta/groups`     | List all groups in creation order (`collections.read`)            |
| PUT    | `/_meta/groups/{id}`| Create/update a group (`collections.write`)                       |
| DELETE | `/_meta/groups/{id}`| Delete a group (`collections.write`)                              |

`GroupDefinition` body (`groupDefinitionSchema`, `.strict()` — unknown keys → 400):

```jsonc
{
  "id": "content_blog",        // snake_case (^[a-z][a-z0-9_]*$)
  "label": "Blog",             // required, max 80
  "parent": "content",         // optional — another registered group id (nesting)
  "icon": "file"               // optional, max 40 — collection icon name
}
```

`PUT` errors: unknown `parent` → `400 GROUP_PARENT_NOT_FOUND`; a parent chain that
returns to the group itself → `400 GROUP_CYCLE`; invalid id/label/icon → `400
INVALID_GROUP`. `DELETE` refuses with `400 GROUP_IN_USE` while child groups or
collections still reference the group. `GET /_meta/collections` handles groups that
point at unregistered ids gracefully.

## Settings / configuration (`/_meta/settings`)

KV-backed, free-form JSON (see [the settings reference](../../core/docs/settings.md)):

| Method | Endpoint          | Behavior                                   |
| ------ | ----------------- | ------------------------------------------ |
| GET    | `/_meta/settings` | Return the full settings blob              |
| PUT    | `/_meta/settings` | Merge body over current settings, persist  |

```bash
curl -X PUT http://localhost:8787/api/_meta/settings \
  -H 'authorization: Bearer <jwt>' -H 'content-type: application/json' \
  -d '{"site":{"name":"Acme","navigation":[{"label":"Home","href":"/"}]}}'
```

`GET` is anonymous-readable while `PUBLIC_GETS=true`; `PUT` needs `settings.write`.

## Key/value configuration entries (`/_config`)

The **other** store — D1 rows, not KV. Same screen in the console, different semantics.
A row belongs to a **colony**; there is no `scope` column and no `?scope=` filter.

| Method | Endpoint             | Permission     | Behavior                                     |
| ------ | -------------------- | -------------- | -------------------------------------------- |
| GET    | `/_config`           | `config.read`  | List entries this session may see. `?land=` narrows to one land (all of its colonies), `?colony=` to one colony. Omit both for everything reachable. `ORDER BY colony, key` |
| GET    | `/_config/{key}`     | `config.read`  | One entry, or `404`                          |
| PUT    | `/_config/{key}`     | `config.write` | Upsert on `(land, colony, key)`; body `key` must match the path |
| DELETE | `/_config/{key}`     | `config.write` | `204`; `404` when the key is not in this colony |

```bash
curl -X PUT 'http://localhost:8787/api/_config/site.social?colony=kitchen_cny' \
  -H 'authorization: Bearer <jwt>' -H 'content-type: application/json' \
  -d '{"description":"Footer links","value":{"github":"…"}}'
```

```jsonc
// GET /api/_config?land=kitchen_lnd
{
  "data": [
    {
      "key": "site.social",
      "value": { "github": "https://github.com/hamolus-labs" },
      "land": "kitchen_lnd",
      "colony": "kitchen_cny",
      "description": "Footer links",
      "updatedAt": "2026-09-28T04:38:22.014Z"
    }
  ]
}
```

### Who may read and write what

The reach of a session comes from the **scope** of its privilege, not from the target it
asks for. A target is a request for something the session may already have; it is never a
grant.

| Session | `GET /_config` | Single-entry `GET`/`PUT`/`DELETE` |
| ------- | -------------- | ---------------------------------- |
| Platform admin (`universe` privilege, or a legacy `ADMIN_KEY` login) | every land | any colony; `?colony=` optional, defaults to the request scope |
| Land admin | its own land, all colonies | requires `?colony=`; without it `400 SCOPE_REQUIRED` naming the parameter |
| Colony admin | its own colony only | its own colony only |

Asking for something out of reach is refused, not silently narrowed: a land admin naming
another land gets `403`, and one naming a colony of another land gets `403` as well. An
unregistered colony id is `404`, so a typo cannot invent a row.

Rules the implementation actually enforces:

- `key` matches `^[a-z][a-z0-9._-]*$`, ≤ 100 chars (`configEntrySchema`). The column is
  `COLLATE NOCASE`, so keys compare case-insensitively even though the pattern forbids
  uppercase.
- `value` is stored as text and parsed back on read, so a string round-trips as a
  string (`"123"` stays `"123"`, it does not come back as the number `123`). A row
  written by a core before that was true is still read leniently: a column that is not
  valid JSON is returned as the raw string.
- The same key exists once per **colony**, so two colonies of one land hold two
  independent values. Naming a land on a `GET` means "all colonies of this land"; naming
  it alongside a `?colony=` is a claim about the same row and is `400 SCOPE_MISMATCH`
  when the registry says otherwise.
- The table is `_configs`, created on first use by `ensureConfigTable()`. A table from
  before this change carries a `scope` column and a `(scope, key)` primary key; it is
  rebuilt with `(land, colony, key)` on first use, keeping the rows it had. Classifying
  them by scope is not attempted — the old values had no colony to point at, so a fresh
  write is the only honest way to place a row.
- Nothing in the core *reads* these rows to render anything. They are a typed key/value
  store for your own app, agent or MCP server.
- Gate: `check:config-scope-acl`.

### Effective localization (`/_meta/localization`)

| Method | Endpoint              | Behavior                                        |
| ------ | --------------------- | ----------------------------------------------- |
| GET    | `/_meta/localization` | The project's effective locales, or `data: null` |

Resolves `core.config.ts` against the KV override (a valid KV `localization` wins) so
clients can render a language switcher without duplicating the list. Requires
`settings.read`; public under `PUBLIC_GETS=true`.

```jsonc
// GET /api/_meta/localization
{ "data": { "defaultLocale": "en", "multilingual": true,
            "locales": [{ "code": "en", "label": "English" }] } }
```

## Seed export/restore (`/_meta/seed`)

Full-state snapshots of a land: collection definitions, navigation groups, the KV
settings blob, every record (with `rowid` preserved) and — optionally — media rows
plus the raw R2 bytes. Both endpoints require the global `settings.write` permission.

| Method | Endpoint                            | Behavior |
| ------ | ----------------------------------- | -------- |
| GET    | `/_meta/seed/export`                | Return the snapshot JSON |
| POST   | `/_meta/seed/apply`                 | Restore a snapshot (wipes the target land unless `wipe=false`) |

`GET /_meta/seed/export` query params:

| Param   | Default | Notes |
| ------- | ------- | ----- |
| `scope` | `all`   | `all` or a single collection name (`scope=posts`) |
| `media` | `none`  | `none` (media rows only, no bytes) or `bytes` (also embed every R2 object as base64 under `mediaObjects`) |

Snapshot shape: `{ kind: 'Hamolus-seed', version: 1, exportedAt, origin, land,
scope, settings, groups: [{id,label,parent?,icon?}], collections: CollectionDefinition[],
records: { <collection>: [ { _rowid, ...columns } ] }, media: rows | null,
mediaObjects: { <r2key>: { b64, mime } } | null }`. The `privileges` collection is
never exported/restored (it auto-bootstraps per land).

`POST /_meta/seed/apply` accepts the raw snapshot JSON. `?wipe=true` (default) first
drops every collection, group, media row and R2 object of the target land, then
recreates in dependency order: groups parent-first → collections → settings
(`settings:{land}:v1`) → media rows + R2 objects → records (rowid preserved).
`?wipe=false` merges (upserts). Validation is atomic — the **entire** snapshot
(kind/version, group schema + parent/cycle checks, every collection definition) is
validated before any destructive step runs, so a broken snapshot can never wipe the
target. Requires `settings.write`; the `x-colony` / `x-land` headers target the
scope. The apply
summary: `{ sourceLand, sourceOrigin, collections, groups, settings, media,
mediaObjects, records }`.

```bash
curl 'http://localhost:8787/api/_meta/seed/export?scope=all&media=none' \
  -H 'authorization: Bearer <jwt>' -o Hamolus-seed.json
curl -X POST http://localhost:8787/api/_meta/seed/apply?wipe=true \
  -H 'authorization: Bearer <jwt>' -H 'content-type: application/json' \
  --data @Hamolus-seed.json
```

## Dynamic records (`/{collection}`)

The whole point: any registered collection gets CRUD for free.

### List (GET `/{collection}`)

Query params:

| Param      | Default | Notes                                          |
| ---------- | ------- | ---------------------------------------------- |
| `page`     | `1`     | 1-based                                        |
| `pageSize` | `20`    | 1–100                                          |
| `sortBy`   | —       | field name; default sort is `rowid DESC`       |
| `sortDir`  | `desc`  | `asc` / `desc`                                 |
| `filter`   | —       | URL-encoded JSON — see below                   |

Filters (`FilterMap`): `{ "<field>": { "op": "<op>", "value": … } }` for multiple
columns. Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `in`, `contains`.

```bash
curl 'http://localhost:8787/api/posts?filter=%7B%22published%22%3A%7B%22op%22%3A%22eq%22%2C%22value%22%3Atrue%7D%7D' \
  -H 'authorization: Bearer <jwt>'
# filter = { "published": { "op": "eq", "value": true } }
```

Response: `{ "data": [ … ], "meta": { "page", "pageSize", "total", "totalPages" } }`.

### Get (GET `/{collection}/{id}`)

`{ "data": { … } }`, or `404` when missing.

### Create (POST `/{collection}`)

```bash
curl -X POST http://localhost:8787/api/posts \
  -H 'authorization: Bearer <jwt>' -H 'content-type: application/json' \
  -d '{"title":"Hello","slug":"hello","published":true}'
```

- The primary key is generated (`crypto.randomUUID()` service-side) unless provided;
  `id`-type fields can't be set manually through the payload.
- Extra unknown fields are rejected (`strict` schema) — this is the SQL-injection
  guard on top of identifier whitelisting.
- `string/text/slug/enum/date/datetime/url/email/relation` validate per type
  (`slug` → `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, `datetime` → ISO-8601, `date` →
  `YYYY-MM-DD`, `email`/`url` checked, etc.).
- With `PUBLIC_GETS` only GET becomes public — writes always need a JWT.

### Update (PUT `/{collection}/{id}`)

Partial update — only provided fields change; `updated_at` is refreshed when
`timestamps` is enabled.

### Delete (DELETE `/{collection}/{id}`)

- Without `softDelete`: hard delete of the row.
- With `softDelete`: sets `deleted_at` (falls through to hard delete after a grace
  period in the default demo queries).

## Relations

Supported at the schema + storage level:

- declare `type: "relation"` with `relation.collection` (target table), `relation.field`
  (usually the target primary key), and an optional `onDelete` policy;
- the value stored is the target's field value (plain `TEXT`, e.g. a category UUID);
- the console renders relation fields as a **dropdown** populated from the target
  collection, and the table shows them as chips with the target record's label.

Not yet enforced server-side: there are no SQL `FOREIGN KEY` constraints, no
referential-integrity validation on write, and no join/populate on read. The
`onDelete` policy is metadata-only for now (the seed uses `setNull` to document intent).

## Media (`/_media` + `/media/`)

Image assets are stored in the **R2 `MEDIA` bucket**; a `_meta_media` D1 table
mirrors each object for searchable, paginated listing. The bucket is auto-created
locally by `wrangler dev` (binding declared in `wrangler.jsonc`).

### Public file serving (no JWT)

- `GET /media/{key}` → when the request `Accept` header prefers an image
  (`image/*`) it streams the raw bytes with `content-type`, `etag` and
  `cache-control: public, max-age=31536000, immutable`; otherwise (e.g. a browser
  navigation typing the URL) it returns a small **HTML metadata viewer** page
  (dimensions, focus point, title/alt/description/**caption**, embedded preview,
  and a badge + chip section labeling which asset the key points at —
  **Media** (default), **Thumbnail (WebP)** or **Variant · {label}** — with links
  to the siblings) linking to the original file. Keys are random UUIDs so URLs are
  effectively unguessable. Outside `/api`, so it works for `PUBLIC_GETS` sites and
  `<img>` tags. 404 if the key is missing/invalid.
- `GET /media/{key}/meta` → small JSON `{ id, key, thumbKey, mime, size, width,
  height, name, title, alt, description, caption, focusX, focusY, variants, url }`
  for the key — a default key, thumbnail key or any variant key all resolve to
  their parent row (404 when unknown keys are requested).

### List (GET `/api/_media`)

Query params: `page` (1), `pageSize` (1–100), `search` (matches name/mime/title via
LIKE), `group`, `category` (exact match on the taxonomy fields), `tag` (LIKE on the
stored tag array). Response: `{ data: MediaObject[], meta: { page, pageSize, total,
totalPages } }`.

### Taxonomy (GET `/api/_media/taxonomy`)

`{ data: MediaTaxonomy }` = distinct `groups`, `categories` and `tags` across all
assets (sorted, empties excluded). Powers the console's filter dropdowns and the
editor's autocomplete suggestions.

### Taxonomy detail (GET `/api/_media/taxonomy/detail`)

`{ data: MediaTaxonomyDetail }` = `{ groups, categories, tags }`, where each
entry is `{ value, count }` (usage count across assets, NOCASE-sorted). Powers
the console's "Manage taxonomy" panel (registered before `/:id`).

### Taxonomy actions (POST `/api/_media/taxonomy`)

Rename or remove a taxonomy value **across every asset**. Body
(`taxonomyActionSchema`, `.strict()`):

```json
{ "type": "group" | "category" | "tag", "from": "Homepage", "to": "Website" }
```

Omitting `to` deletes the value from every asset instead of renaming. Returns
the fresh `{ data: MediaTaxonomyDetail }`. Unknown `type` or a missing `from`
→ 400. Group/category renames update the column in one SQL statement; tag
renames/deletes reserialize each affected asset's tag array.

### Get (GET `/api/_media/{id}`)

`{ data: MediaObject }`.

### Upload (POST `/api/_media`)

`multipart/form-data` with a single `file` field (images only:
`image/*` mime). Rejects empty and non-image payloads (400 `UNSUPPORTED_MEDIA`).
Stores the bytes under `<uuid>.<ext>` in R2, inserts the `_meta_media` row
(rolling the R2 object back if the insert fails), and returns `{ data: MediaObject }`
with HTTP 201.

Optional form fields (validated by `mediaUploadMetaSchema`, `.strict()`):
`name` (display name; defaults to the file name), `title`, `alt`, `description`,
`caption` (shown by the HTML viewer), `group`, `category`, `tags` (JSON array of
strings, or a comma-separated list), `focusX` / `focusY` (percent 0–100).
Empty/unset strings become `null`.

**Companion thumbnail** — an optional second `thumb` file field (images only)
stores a small downscaled image (the console sends a ~320px WebP) under
`<id>.thumb.<ext>` in R2, and the row stores `thumbKey` with a public `thumbUrl`.
Used for lazy loading; the thumbnail is deleted with its parent.

**Crop variants** — one record can bundle several R2 objects under different
ratios. Send repeated `variant` file fields (images only) plus one
`variantMeta` field containing the JSON array of per-variant metadata
(`mediaVariantsMetaSchema`, `.strict()`, max 24), paired index-wise with the
`variant` parts:

```json
[
  { "label": "2:1", "focusX": 20, "focusY": 80 },
  { "label": "1:1", "focusX": 50, "focusY": 50 }
]
```

Each variant is stored under `<id>.<sanitized-label>.<ext>` (label lowercased,
non-alphanumeric run → `-`, `v` fallback; duplicate or >40-char labels → 400
`INVALID_MEDIA`) and returned on the `variants` array with a per-origin `url`.
The whole upload (default + thumbnail + variants) is rolled back from R2 if the
row insert fails, and `DELETE` removes every object.

### Delete (DELETE `/api/_media/{id}`)

Removes the R2 default object, the companion thumbnail, **and every crop variant
object**, then the metadata row → 204.

### Edit metadata (PATCH `/api/_media/{id}`)

Body (any subset; `.strict()` rejects unknown keys):

```json
{
  "name": "hero-photo.png",
  "title": "Sunset over the bay",
  "alt": "A sunset viewed from the pier",
  "description": "Photo used for the home hero",
  "caption": "Shot at dusk from the pier",
  "group": "Homepage",
  "category": "Photography",
  "tags": ["hero", "sunset"],
  "focusX": 62,
  "focusY": 35
}
```

`name` renames the display filename (the R2 key stays a UUID — existing URLs
keep working). Send `""` (or `null`) for title/alt/description/caption/group/
category and `[]`/`null` for `tags` to clear them. `focusX`/`focusY` (0–100,
nullable) move the focal point used when cropping previews; `null` = center.
`variants` are stored as immutable upload-time data — they are **not** editable
through `PATCH` (edit labels by re-uploading). Returns the updated
`{ data: MediaObject }`.

### Replace bytes (PUT `/api/_media/{id}`)

`multipart/form-data` with a single `file` field (images only). The new bytes are
written under the asset's **existing R2 key**, so its URL and id stay the same;
`size`, `mime`, `width`/`height` are refreshed from the uploaded file. An optional
`thumb` field replaces the companion thumbnail the same way (and drops the previous
thumbnail object when the new key differs). Used by the console's resize feature.

### Image dimensions

Every upload and replacement has its width/height extracted from the header
(no deps; PNG/JPEG/GIF/WebP/BMP — see `media/size.ts`). Non-raster / unknown
formats store `null`.

### MediaObject

```ts
{
  id, key, name, mime, size, width, height, title, alt, description, caption,
  group, category, tags, focusX, focusY, thumbKey, thumbUrl, variants, url,
  createdAt, updatedAt
}
```

`url` is an absolute URL to `GET /media/{key}` derived from the request origin.
`thumbKey`/`thumbUrl` are the companion thumbnail's key and public URL (`null` when
none); consumers use `thumbUrl ?? url` for lightweight rendering.
`group`/`category` are optional taxonomy labels (`string | null`); `tags` is a
`string[]` (stored as a JSON array, always `[]` when empty). `focusX`/`focusY`
are percent coordinates (`number | null`) — `null` means center; consumers apply
them via CSS `object-position: {focusX}% {focusY}%` on cropped previews.
`caption` (`string | null`) is a short line surfaced by the HTML viewer.
`variants` (`MediaVariant[]`) is the crop-variant bundle created at upload time:
each entry is `{ label, key, mime, size, width, height, focusX, focusY, url }`
with `url` derived per request origin, `focusX/focusY` percent coordinates
relative to **that variant's own frame**, and `width/height` parsed from the
variant's bytes.

## Files (`/_documents` + `/_attachments`, `/documents/` + `/attachments/`)

A file library for non-image assets (documents and attachments), mirroring the
media manager. Bytes live in the same `MEDIA` R2 bucket under kind-prefixed keys —
`doc/<uuid>.<ext>` and `att/<uuid>.<ext>` — and the `_meta_files` D1 table holds
the metadata. Two independent libraries (one per kind) so a `document` field can
only ever reference a document and vice-versa.

A `FileObject` looks like:

```jsonc
{
  "id": "…uuid…",
  "name": "invoice.pdf",
  "mime": "application/pdf",
  "size": 12804,
  "ext": "pdf",
  "key": "doc/3e2….0f1.pdf",
  "url": "http://localhost:8787/documents/3e2….0f1.pdf",   // absolute, public
  "group": "Legal",         // string | null
  "category": "Contracts",  // string | null
  "tags": ["signed"],       // string[]
  "createdAt": "…",
  "updatedAt": "…"
}
```

### Endpoints

| Method | Endpoint                                        | Purpose                              |
| ------ | ----------------------------------------------- | ------------------------------------ |
| GET    | `/api/_documents` and `/api/_attachments`       | Paginated list: `page`, `pageSize` (≤100), `search` (name/mime/group/category/tags LIKE), `group`, `category`, `tag` exact filters |
| GET    | `/api/_documents/taxonomy` and `/api/_attachments/taxonomy` | Distinct groups/categories/tags |
| GET    | `/api/_documents/{id}` and `/api/_attachments/{id}` | Get one item (by id)               |
| POST   | `/api/_documents` and `/api/_attachments`       | Multipart `file` + `name` + optional `group`/`category`/`tags` → 201 |
| PATCH  | `/api/_documents/{id}` and `/api/_attachments/{id}` | Rename + edit `group`/`category`/`tags` (empty → null) |
| DELETE | `/api/_documents/{id}` and `/api/_attachments/{id}` | Remove the R2 object + row → 204   |

Any image type is accepted — files are **not** restricted to images (unlike media).

### Public serving (no JWT)

| Route                          | Purpose                                                  |
| ------------------------------ | -------------------------------------------------------- |
| `GET /documents/{key}`         | Streams bytes with immutable cache; if the client `Accept`s `text/html`, serves a lightweight metadata HTML viewer |
| `GET /documents/{key}/download`| Same bytes with `content-disposition: attachment`        |
| `GET /attachments/{key}`       | Streams bytes with immutable cache (no HTML viewer)      |

Keys are regex-whitelisted; unknown keys → 404.

## Panels (`/_panels`)

A Panel is a declarative, per-land manifest (`panelDefinitionSchema` in
`packages/types/src/panel.ts`) that describes a custom app surface: a set of **views**
bound to collections, each with its own operations, field ACLs, filters, metrics,
and sort; plus a **menu**, **roles**, and **members**. Manifests are stored in the
`_meta_panels` table, one row per `(land, id)`.

`/_panels` splits into two permission models:

- **Manifest routes** use the global `panels.read` / `panels.write` permissions
  (granted to the seeded `admin` and `manager` roles). These manage definitions.
- **Runtime routes** (`bootstrap`, view records, relations, dashboard, assets)
  require only a **valid session**. Access is decided entirely by the manifest:
  the caller's role in that Panel, their member `attributes`, and each view's
  operations/field ACLs. This is what lets a `panel_user` role — which is seeded
  with **no** global permissions — use a Panel it was assigned to.

### Manifest (global permissions)

| Method | Path | Permission | Purpose |
| ------ | ---- | ---------- | ------- |
| GET | `/api/_panels` | `panels.read` | List all Panel manifests → `{ data: PanelDefinition[] }` |
| POST | `/api/_panels` | `panels.write` | Create from `{ definition }` → `201`; `409 PANEL_EXISTS` if the id is taken |
| GET | `/api/_panels/{id}` | `panels.read` | Single manifest → `{ data: PanelDefinition }` |
| PUT | `/api/_panels/{id}` | `panels.write` | Create-or-replace; `definition.id` must match the path (`400 INVALID_PANEL_ID`) |
| PATCH | `/api/_panels/{id}` | `panels.write` | Same as PUT but `404` when the Panel does not exist |
| DELETE | `/api/_panels/{id}` | `panels.write` | `204`; also cascades every private asset (metadata **and** R2 objects) |

`POST` and `PUT`/`PATCH` validate the whole manifest with `panelDefinitionSchema`;
failures return `400 INVALID_PANEL` with a joined issue list. `DELETE` returns
`204` and leaves no orphaned `_meta_panel_assets` rows or `panels/{land}/…` R2 keys.

### Runtime (session + manifest ACL)

All of these resolve the caller to a Panel role via `loadRuntimeActor` and require
the view's `read` operation, then project only the fields in `fields.read`.

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/_panels/{id}/bootstrap` | `{ data: { panel, role, user, attributes } }` — the manifest **re-filtered** to the caller's views/operations/fields, with `menu` pruned to authorized views and a single effective `role` |
| GET | `/api/_panels/{id}/views/{viewId}/records` | Paginated list; `page`, `pageSize` (≤100), `search`, `sortBy`, `sortDir`, `locale`. Returns `{ data, meta, lastUpdate }` |
| GET | `/api/_panels/{id}/views/{viewId}/records/{recordId}` | One record, field-projected |
| POST | `/api/_panels/{id}/views/{viewId}/records` | Create; requires `create` and validates against the view's `fields.write` |
| PUT/PATCH | `/api/_panels/{id}/views/{viewId}/records/{recordId}` | Update; requires `update` |
| DELETE | `/api/_panels/{id}/views/{viewId}/records/{recordId}` | `204`; requires `delete` |
| GET | `/api/_panels/{id}/views/{viewId}/relations/{field}/options` | Option list for a writable `relation` field; needs `create` or `update` |
| GET | `/api/_panels/{id}/views/{viewId}/dashboard` | Resolves `view.metrics` (`count`, `sum`, `avg`, `min`, `max`) → `501` on non-dashboard views |

View `filters` are applied server-side and may reference member `attributes`; a
mismatch is `400 PANEL_FILTER_MISMATCH`, and a filter that needs a missing
attribute is `400 PANEL_ATTRIBUTE_MISSING`. `search` on a view whose definition
sets `searchable: false` is `403 PANEL_SEARCH_FORBIDDEN`. Dashboard views have no
records/relations/assets (`400 PANEL_VIEW_KIND`).

#### Panel error codes

`INVALID_PANEL`, `INVALID_PANEL_ID`, `PANEL_EXISTS`, `PANEL_VIEW_NOT_FOUND`,
`PANEL_VIEW_KIND`, `PANEL_ACCESS_DENIED`, `PANEL_MEMBERSHIP_REQUIRED`,
`PANEL_OPERATION_FORBIDDEN`, `PANEL_FIELD_FORBIDDEN`, `PANEL_SEARCH_FORBIDDEN`,
`PANEL_FILTER_MISMATCH`, `PANEL_ATTRIBUTE_MISSING`, `PANEL_RECORD_NOT_FOUND`,
`PANEL_METRIC_FORBIDDEN`, `PANEL_METRICS_UNSUPPORTED`, `PANEL_RELATIONS_UNSUPPORTED`,
`PANEL_ASSET_FIELD_INVALID`.

## Panel assets

Panel uploads are private and never use the public `/media`, `/documents`, or
`/attachments` routes. The Core stores metadata in `_meta_panel_assets` and bytes
in the `MEDIA` R2 bucket under `panels/{land}/{panelId}/{uuid}.{ext}`.

Assets are scoped by the view field that requested them. A field must be a
readable `media`, `document`, or `attachment` field; uploads additionally require
`create` or `update` on that view and write access to the field. The query requires
`field`, with optional `page`, `pageSize` (≤100), and `search`.

| Method | Endpoint | Purpose |
| ------ | -------- | ------- |
| GET | `/api/_panels/{panelId}/views/{viewId}/assets?field={field}` | List private assets for the field |
| POST | `/api/_panels/{panelId}/views/{viewId}/assets?field={field}` | Multipart `file`, optional `name` → `201` |
| DELETE | `/api/_panels/{panelId}/views/{viewId}/assets/{assetId}?field={field}` | Delete the R2 object and metadata → `204` |

The returned `PanelAssetObject` contains short-lived `url` and `downloadUrl`
values. Signed URLs are served by `GET /panel-assets/{assetId}` and require
`expires` and `sig`; invalid or expired signatures return `401`. The signing
secret is `PANEL_ASSET_SECRET` when configured, otherwise `JWT_SECRET`. URLs
expire after 15 minutes and are deliberately not valid under the public media or
file-library routes.

Assets are removed with their Panel: `DELETE /api/_panels/{id}` first deletes the
Panel's `_meta_panel_assets` rows, then the corresponding `panels/{land}/…` R2
keys, then the manifest. Deleting the Panel never leaves orphaned metadata or
objects behind.


## Plugins (`/_plugins`)

A small KV-backed data surface for console plugins (todo, kanban). Every entry is
a JSON value stored in the shared `SETTINGS` KV under the per-land prefix
`plugin:{land}:{plugin}:`. Reads require `settings.read`, writes require
`settings.write`.

| Method | Path                  | Body     | Returns                                        |
| ------ | --------------------- | -------- | ---------------------------------------------- |
| `GET`  | `/_plugins/:plugin`   | —        | `{ data: [{ key, value }] }` all stored entries|
| `GET`  | `/_plugins/:plugin/:key` | —     | `{ data: <value> }` / `404 NOT_FOUND`          |
| `PUT`  | `/_plugins/:plugin/:key` | any JSON | `{ data: <value> }` (create or replace)      |
| `DELETE` | `/_plugins/:plugin/:key` | —   | `204`                                          |

The plugin id matches `^[a-z][a-z0-9_-]{0,31}$`, keys
`^[a-zA-Z0-9._:-]+$` (400 otherwise). A missing key returns 404 — the console's
`KvClient.get` maps that to `null`.

## MCP instances (`/_mcp`)

Two surfaces share the `/_mcp` prefix and nothing else: the **operator** API a console
session drives, and two **machine** endpoints an MCP worker calls. They are mounted on
opposite sides of the JWT middleware (`index.ts:84` and `index.ts:621`) because a worker
has no session yet — it is trying to find out what it is.

### Operator (console) — `mcp.read` / `mcp.write`

Scoped like any other resource: `?land=` / `?colony=` and the scope headers, and the
caller must hold the permission **in the instance's own colony**. An instance is bound
to one colony for its whole life.

| Method   | Path                       | Permission   | Description |
| -------- | -------------------------- | ------------ | ----------- |
| `GET`    | `/_mcp/instances`          | `mcp.read`   | List instances in scope. |
| `GET`    | `/_mcp/instances/:id`      | `mcp.read`   | One instance / `404 NOT_FOUND`. |
| `POST`   | `/_mcp/instances`          | `mcp.write`  | Create. The **scope comes from the query/session, not the body** — `land`/`colony` in a body are not part of the schema, so a client cannot create an instance in a colony it did not name in the request. |
| `PUT`    | `/_mcp/instances/:id`      | `mcp.write`  | Partial update: `label`, `enabled`, `readonly`, `toolGroups`, `dynamicCollections`, `dynamicMax`. |
| `DELETE` | `/_mcp/instances/:id`      | `mcp.write`  | Delete the instance **and its tokens**. |
| `GET`    | `/_mcp/instances/:id/tokens` | `mcp.read` | List tokens — metadata only, never the secret. |
| `POST`   | `/_mcp/instances/:id/tokens` | `mcp.write` | Issue a token. `narrowedPermissions` may only **narrow** the instance's derived set, never widen it. The plaintext is in the response **once** and is not retrievable afterwards. |
| `DELETE` | `/_mcp/tokens/:tokenId`    | `mcp.write`  | Revoke one token. |

An instance carries `label`, `enabled` (default `true`), `readonly` (default `false`),
`toolGroups` (default `records,media,meta`; `admin` is opt-in), `dynamicCollections`
and `dynamicMax` (default 10). Its **permissions are derived from those two flags** —
`readonly` drops every `*.write`, and each group maps to a fixed permission set — so
changing the surface changes what the core will accept, not merely what the worker
offers.

### Machine (worker) — instance id in the `Authorization` header

These two are the only ones a worker calls, and the header is **the instance id**, not
a JWT: `Authorization: Bearer mcp_…`. Deliberately unauthenticated apart from that,
because a description of the tool surface is not data — but that is exactly why the id
is a generated high-entropy credential rather than something a person names.

They resolve **no scope from the request**. A worker holding an instance id does not yet
know its own colony — that is what it is asking for — and on a `centralized` core a
request with no `x-land`/`x-colony` is a `400`. The instance row carries the only scope
there is.

| Method | Path                | Returns |
| ------ | ------------------- | ------- |
| `GET`  | `/_mcp/config`      | `{ data: { instance } }` — the instance's scope, `enabled`, `readonly`, `toolGroups`, `dynamicCollections`, `dynamicMax`. `403 MCP_DISABLED` when the toggle is off. |
| `POST` | `/_mcp/session`     | `{ data: { token, expiresAt, instance, tokenId, permissions } }` — a short-lived session JWT to carry for subsequent calls. |

`POST /_mcp/session` takes `{ "token": "<the per-user token>" }` and is where the
console's decisions become enforcement: the permission list is the instance's derived
permissions **intersected with** the token's own `narrowedPermissions`, so the JWT a
worker ends up holding is narrower than the account that issued it. A read-only
instance mints a token with no `*.write` at all, and `requireWrite` in the rest of the
core answers `403` — the worker's own read-only check is a friendlier error message, not
the thing standing between a model and a write.

The minted session has its own subject space, `sub: mcp:{instanceId}:{tokenId}` and
`role: 'mcp'`, so an MCP request is never mistaken for a console login in a log or in
`_auth/me`. A bare `mcp:`-free subject would be.

**A token belongs to one instance.** The instance id from the header is passed to
`verifyMcpToken` alongside the presented token, and a mismatch is rejected — otherwise a
token issued for a narrow, read-only instance would be redeemable through a different
instance's worker and the intersection above would never happen. Instance ids and token
ids are unique across the platform for the same reason.

Status codes are chosen so a worker log tells an operator which of three different
problems occurred: `401` the credential is not accepted (missing, unknown, malformed),
`403` the credential is fine but the instance is switched off, `400` the request is
malformed. The **message** never distinguishes an unknown instance from a revoked token,
so ids cannot be enumerated; only the status does.

Gate: `check:mcp-instance-acl`.

## Universe — lands & colonies (`/_meta/universe/lands`, `/_meta/universe/colonies`)

Global registries — these endpoints **ignore** the scope headers. Access is tiered:
a universe admin sees everything, a **land_admin** sees only the land it owns and
that land's colonies (and may create/delete those colonies, but never a land
itself), and a colony admin has no access. Ids must match the
identifier pattern (`^[a-z][a-z0-9_]*$`); the definition body is `.strict()`, so
unknown keys are rejected with `400 INVALID_LAND`.

| Method | Path                     | Permission     | Description |
| ------ | ------------------------ | -------------- | ----------- |
| GET    | `/_meta/universe/lands`  | `lands.read`    | All lands (`id`, `label`, `createdAt`). |
| GET    | `/_meta/universe/lands/{id}`  | `lands.read`    | One land / `404 NOT_FOUND`. |
| PUT    | `/_meta/universe/lands/{id}`  | `lands.write`   | Upsert a land (`{ label }`; a body `id` must match the path). |
| DELETE | `/_meta/universe/lands/{id}`  | `lands.write`   | Delete a land **and everything it owns** (below). |
| GET    | `/_meta/universe/colonies` | `colonies.read` | All colonies, or `?land=` to scope. |
| GET    | `/_meta/universe/colonies/{id}` | `colonies.read` | One colony / `404 NOT_FOUND`. |
| PUT    | `/_meta/universe/colonies/{id}` | `colonies.write` | Upsert a colony (`{ landId, label }`, both required). |
| DELETE | `/_meta/universe/colonies/{id}` | `colonies.write` | `204`. |

**Land deletion is a full purge.** `DELETE /_meta/universe/lands/{id}` removes the land's
colonies, panels **and their private R2 assets**, media / document / attachment rows
**plus their R2 bytes**, collection metadata **and every physical record table**,
the `privileges` bootstrap table, groups, config rows, auth users, the settings KV
document and every `plugin:{land}:*` KV key, then invalidates the in-memory
land / collection / privilege caches. Land ids are part of the physical table name,
so dropping the tables is what makes deletion final: re-creating the same id starts
completely empty and cannot resurrect old records, assets or roles.

Order and error semantics:

- A land that still owns colonies is refused — `400 LAND_IN_USE`. Delete colonies first.
- The default land is refused — `403 DEFAULT_LAND_RESERVED`.
- Metadata is purged **before** bytes, so an R2/KV failure can never leave rows
  pointing at objects that no longer exist. The trade-off: a failure during byte
  deletion leaves unreferenced R2 objects with no metadata to retry from, so those
  bytes must be removed out of band.
- `DELETE` is idempotent and also works for an **unregistered** id, which makes it a
  usable cleanup path for a half-created land whose registry row is already gone.

Unregistered lands have no privileges table, so any request for one gets
`404 NOT_FOUND` (`Collection 'privileges' is not registered`) instead of silently
bootstrapping an empty role set.

## Errors

| HTTP | Code       | Typical case                             |
| ---- | ---------- | ---------------------------------------- |
| 400  | `…`        | Invalid definition / body / identifiers  |
| 401  | `UNAUTHORIZED` | Missing/invalid JWT                  |
| 404  | `NOT_FOUND`| Unknown collection / record / route     |
| 500  | `INTERNAL` | Unhandled worker error                  |

## Environment variables (`packages/core/wrangler.jsonc`)

| Variable       | Source      | Notes                                            |
| -------------- | ----------- | ------------------------------------------------ |
| `DB` (D1)      | binding     | `hamolus` database — records + collection metadata |
| `SETTINGS` (KV)| binding     | key-value store for the settings blob            |
| `MEDIA` (R2)   | binding     | `hamolus-media` bucket for image assets and private Panel assets |
| `CORE_MODE`    | `vars`      | `independent` (default) \| `centralized` \| `proxy` \| `bridge` |
| `DEFAULT_LAND` | `vars`      | land used by bare/unprefixed tenant requests (default `default`) |
| `PUBLIC_GETS`  | `vars`      | `"true"` enables unauthenticated GET            |
| `PANEL_ASSET_SECRET` | secret | Optional HMAC secret for short-lived private Panel asset URLs; falls back to `JWT_SECRET` |
| `JWT_SECRET`   | secret      | token signing secret — `wrangler secret put`     |
| `ADMIN_KEY`    | secret      | admin login key — `wrangler secret put`          |
| `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` | secret | first platform super-admin, seeded on an empty `_auth_users` |

A secret and a var cannot share a name, so none of the credentials are declared
under `vars` — not even in development.

**Production checklist:** create the D1 database, KV namespace and R2 bucket, then
paste the real `database_id` and KV `id` (a generated configuration does this for
you, and its `verify.mjs` reports any placeholder left behind). Put the secrets
above with `wrangler secret put`, and deploy:

```bash
pnpm -F ./core deploy          # standalone core
pnpm -F ./configs/<id> deploy  # named configuration (staging, production, per land)
```

A configuration's `main` points back at the core part, so one codebase can be
deployed to several environments and lands by adding configuration files only.
frontends.