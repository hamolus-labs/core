# KV-backed settings (`/api/_meta/settings`)

Settings are a **single free-form JSON object** stored in a Cloudflare KV namespace
under the key `settings:v1` (binding name `SETTINGS`). This is the config bucket for
stuff that shouldn't require redeploying a Worker or a D1 table — site config,
navigation, UI copy, feature toggles, third-party keys for frontends, etc.

## API

- `GET /api/_meta/settings` → `{ "data": { … } }` (the whole blob).
- `PUT /api/_meta/settings` with a JSON **object** body → merges shallowly over the
  current blob and persists; response is the merged result.

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

Both endpoints require a JWT by default (they are NOT public even with
`PUBLIC_GETS=true`, which only opens GET on `/{collection}` records). Frontends that
call settings from the edge pass their `CORE_API_TOKEN` like any other request.

## Recommended shape

The seed writes the canonical example; the public site reads the `site.*` keys:

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
the body to be a JSON object. The console's **Settings** page edits it as JSON.

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