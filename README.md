# @hamolus/core

<!-- deploy:begin -->
<!-- Written by scripts/export-deploy-repo.mjs — do not edit by hand. -->

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hamolus-labs/core)

That button forks this repository into your own GitHub account, names the Worker,
provisions the KV namespace, D1 database and R2 bucket on your account, and wires
up Workers Builds so later pushes deploy themselves.

**Secrets are not part of the deploy.** The button uploads code and provisions
resources, but it cannot set secrets — and a core that comes up without them
rejects every login. Set these immediately after the first deploy:

```bash
wrangler secret put JWT_SECRET
wrangler secret put ADMIN_KEY
```

or paste them into Settings → Variables and Secrets in the dashboard. Use
different values than the ones in a local `.dev.vars`.

**`PUBLIC_GETS` ships as `true`, which means every unauthenticated `GET` on this
worker answers** — all collections, records, settings and media, with no token. That
is what an SSG site needs and what a private install does not. Set it to `false` in
Settings → Variables and Secrets unless you are serving a public read-only site.
`CORE_MODE`, `DEFAULT_LAND` and `DEFAULT_COLONY` are declared too, so you can see and
change the scope without editing the config; `default` there is the reserved sentinel
for the unnamed scope (`root_lnd` / `root_cny`), not a land by that name.
<!-- deploy:end -->

The Hamolus core API: a Hono + Drizzle Cloudflare Worker that turns collection
metadata into a dynamic, multi-tenant CRUD API on D1, with KV settings, R2
media/file libraries, panel ACLs and an MCP-ready surface.

Collections are not hard-coded. `PUT /api/_meta/collections/{name}` stores a
definition and the Worker creates or migrates the physical D1 table, then serves
`GET/POST/PUT/DELETE /api/{collection}` with the field definitions driving
validation, coercion, search, relations and localization.

## Bindings

| Binding | Resource |
| ------- | -------- |
| `DB` | D1 — records + collection metadata |
| `SETTINGS` | KV — the settings blob |
| `MEDIA` | R2 — media, files and private panel assets |

`CORE_MODE` (`independent` | `centralized` | `proxy` | `bridge`), `DEFAULT_LAND` and
`DEFAULT_COLONY` control scope resolution, and all three are declared in
`wrangler.jsonc` so they show up in the dashboard rather than hiding behind a code
default. In `DEFAULT_LAND`/`DEFAULT_COLONY`, `default` is the reserved sentinel for the
unnamed scope — the ids are `root_lnd` / `root_cny` — and a real name there is what moves
a deployment onto a named land.

`PUBLIC_GETS` (`true`) makes every unauthenticated `GET` answer: all collections,
records, settings and media, no token. That is what an SSG site needs and what a private
install does not want. `JWT_SECRET`, `ADMIN_KEY`, `PANEL_ASSET_SECRET` and the
`SUPER_ADMIN_*` pair are **secrets**, not vars, and a committed config cannot carry them.

## Use it

Normally you do not import this directly — `hamolus create` generates a thin core
whose `src/index.ts` re-exports the app from this package, so you can wrap it
without forking:

```ts
export { default } from '@hamolus/core'
```

## Development

```bash
pnpm dev              # wrangler dev
pnpm db:setup         # optional eager DDL (the core self-bootstraps)
pnpm typecheck
```

## Reference

- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
- [KV settings](docs/settings.md)

## What's new

The `mcp` column on `_meta_collections`, added automatically on the first
request after upgrade.

See the [changelog](https://github.com/hamolus-labs/hamolus/blob/main/CHANGELOG.md#022--2026-09-28) for every release.

## License

MIT
