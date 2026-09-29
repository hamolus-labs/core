# KV-backed settings (`/api/_meta/settings`)

Settings are a **single free-form JSON object** stored in a Cloudflare KV namespace
(binding name `SETTINGS`). This is the config bucket for stuff that shouldn't require
redeploying a Worker or a D1 table — site config, navigation, UI copy, feature toggles,
third-party keys for frontends, etc.

## The key is per scope

| Request scope | KV key |
| ------------- | ------ |
| root land + root colony | `settings:v1` (the legacy key, kept so pre-scope blobs keep working) |
| any other land/colony | `settings:{land}:{colony}:v1` |

`settingsKey()` in `src/meta/settings.ts` is the only place that builds this. The same
split applies to the key/value entries in `src/auth/config.ts` (`_configs`, keyed by
`(land, colony, key)`) — those are a different store, documented in the console guide.

## API

- `GET /api/_meta/settings` → `{ "data": { … } }` (the whole blob).
- `PUT /api/_meta/settings` with a JSON **object** body → merges shallowly over the
  current blob and persists; response is the merged result. **There is no way to delete
  a single top-level key**: a key removed from the body comes back on the next read,
  because the merge only adds and overwrites.

```bash
# login (once)
KEY='dev-admin-key-change-me'
TOKEN=$(curl -s -X POST http://localhost:8787/api/_auth/token \
  -H 'content-type: application/json' -d "{\"key\":\"$KEY\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')

# read
curl -s http://localhost:8787/api/_meta/settings -H "authorization: Bearer $TOKEN"

# write/merge
curl -s -X PUT http://localhost:8787/api/_meta/settings \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"site":{"name":"Acme"}}'
```

Access is decided by `requireRead` (GET) and `requireWrite` (PUT):

- `PUT` always needs a session with `settings.write`; there is no anonymous path.
- `GET` needs a session **only if one is presented**: `requireRead` returns early when
  there is no `Authorization` header, and the auth middleware lets a header-less `GET`
  through while `PUBLIC_GETS=true`. So a public site build can read the blob with no
  token. The trap is sending a token that *lacks* `settings.read` — that is a 403, not a
  silent downgrade to anonymous. A front end that has `CORE_API_TOKEN` should send it.
- `PUBLIC_GETS=false` closes this along with the rest of the read surface.

## Recommended shape

The seed writes the canonical example. The `site.*` keys are the conventional place for a
front end to look, but nothing resolves them for you — a site has to fetch the blob and
read the keys itself (the templates `hamolus add site` writes do not fetch it at all):

```jsonc
{
  "localization": {
    "languages": ["en", "id"]
  },
  "site": {
    "name": "Worker Stacks",
    "tagline": "A Cloudflare Workers monorepo: core API, admin console, and public site.",
    "navigation": [
      { "label": "Home", "href": "/" },
      { "label": "Posts", "href": "/posts" },
      { "label": "Categories", "href": "/categories" }
    ]
  }
  // add anything else you like:
  // "social": { "github": "…", "twitter": "…" },
  // "announcement": { "enabled": true, "text": "…" }
}
```

Because the blob is free-form, `PUT` never validates a fixed schema — it only requires
the body to be a JSON object. The console's **Settings blob** section on `/config` edits
it as JSON; it loads what the core returned rather than starting from a placeholder, and
an empty blob gets an explicit "Insert an example" button instead of a prefilled editor.

## Localization

When `localization.languages` is set (an array of language codes like `["en", "id"]`),
fields marked with `localized: true` in their collection definition will store values
as a JSON object keyed by language code:

```jsonc
// stored value for a localized text field
{ "en": "Hello world", "id": "Halo dunia" }
```

The console automatically renders language tabs for localized fields, allowing editors
to input values for each configured language. The core API validates that localized
values match the configured language structure.

## `core.config.ts` — the build-time floor

A project declares a *floor* for its settings in a checked-in `core.config.ts` at the
project root. The generated Worker hands it to the core at start-up:

```ts
// src/index.ts
import app, { setCoreConfig } from '@hamolus/core'
import { config } from '../core.config'

setCoreConfig(config)
export default app
```

```ts
// core.config.ts
import { defineCoreConfig } from '@hamolus/types'

export const config = defineCoreConfig({
  localization: {
    defaultLocale: 'en',
    locales: [
      { code: 'en', label: 'English' },
      { code: 'id', label: 'Bahasa Indonesia' },
    ],
  },
})
```

**Precedence**: `core.config.ts` supplies defaults; a **valid** `localization` object in
KV replaces the configured value entirely (it is not merged per-locale), so a
non-empty KV `localization` makes the file's locales irrelevant at runtime. With no
valid KV override, the file's value is what the core uses.

Two consequences worth knowing:

- A project with **no** locales (`locales: []`, or no `localization` block) stays
  monolingual, and a `localized: true` field then accepts a plain string — declaring
  zero languages must not make localized fields stricter.
- `GET /api/_meta/localization` returns the effective value (`data: null` when the
  project declares none) so clients never have to mirror the list. It needs
  `settings.read`, and under `PUBLIC_GETS=true` it is public like the rest of the
  `_meta` read surface.

## Consumption in the site

- `src/lib/api.ts` → `getSettings()` returns the blob (or `{}` on failure).
- `src/layouts/Base.astro` → `site.name` (brand/title/footer), `site.navigation`
  (header links; falls back to listing all collections if absent).
- `src/pages/index.astro` → `site.name` + `site.tagline` for the hero.

## Production notes

- Reveal the namespace id (`wrangler kv namespace list`) and set it in
  `packages/core/wrangler.jsonc` under `kv_namespaces`.
- The blob is readable by any token holder and by the site at runtime — don't store
  server secrets that belong in `wrangler secret`.