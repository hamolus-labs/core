/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

/**
 * MCP instances and the per-user tokens that may call them.
 *
 * Both are internal tables (never a dynamic collection) created at runtime, the
 * same way `_auth_users` and `_configs` are — a core needs no migration step to
 * gain the MCP feature, and a fresh deployment starts with both tables.
 *
 * Two things here are load-bearing and easy to get wrong later:
 *
 * 1. **A token secret is stored hashed, never in the clear.** The row keeps the
 *    token *id* (which is a lookup key and is displayed so an operator can tell
 *    two tokens apart) and the `sha256` of the secret. That is what makes revoke
 *    possible at all: the core's session JWTs are stateless and 24h, so without
 *    row state there is no answer to "cut off user X today".
 * 2. **The instance id is the worker's credential.** It is generated here with
 *    ~155 bits of entropy rather than being operator-chosen, because being able
 *    to guess one is the same as being one.
 */

import { sql, type SQL } from 'drizzle-orm'
import { COLONY_DEFAULT, LAND_DEFAULT } from '@hamolus/types'
import type {
  McpInstance,
  McpInstanceConfig,
  McpToolGroup,
  McpToken,
  Permission,
} from '@hamolus/types'
import {
  DEFAULT_MCP_TOOL_GROUPS,
  formatMcpToolGroups,
  mcpPermissions,
  parseMcpToolGroups,
  MCP_INSTANCE_ID_PATTERN,
  MCP_TOKEN_PATTERN,
} from '@hamolus/types'
import type { Db } from '../db/client'
import { badRequest, forbidden, notFound, unauthorized } from '../errors'

const INSTANCE_TABLE = '_mcp_instances'
const TOKEN_TABLE = '_mcp_tokens'

/** 62 symbols, so a 26-char id is ~155 bits and a 43-char secret is ~256 bits. */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export interface McpInstanceRow {
  land: string
  colony: string
  id: string
  label: string
  enabled: number
  readonly: number
  tool_groups: string
  dynamic_tools: string
  dynamic_max: number
  /**
   * What the worker said it was running, and when it last said it. Both are written
   * only by `touchMcpInstanceHeartbeat`, never by an operator route — a reported
   * version is a claim made by the deployment, and accepting one from a request body
   * would let the console certify a version that nothing is running.
   */
  reported_version: string | null
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export interface McpTokenRow {
  land: string
  colony: string
  id: string
  instance_id: string
  name: string
  token_hash: string
  permissions: string | null
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
  created_at: string
}

let tablesReady = false

export async function ensureMcpTables(db: Db): Promise<void> {
  if (tablesReady) return
  const boot = db
      .run(sql.raw(`
        CREATE TABLE IF NOT EXISTS ${INSTANCE_TABLE} (
          land TEXT NOT NULL DEFAULT 'root_lnd',
          colony TEXT NOT NULL DEFAULT 'root_cny',
          id TEXT NOT NULL,
          label TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          readonly INTEGER NOT NULL DEFAULT 0,
          tool_groups TEXT NOT NULL DEFAULT 'records,media,meta',
          dynamic_tools TEXT NOT NULL DEFAULT '',
          dynamic_max INTEGER NOT NULL DEFAULT 10,
          reported_version TEXT,
          last_seen_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (land, colony, id)
        )
      `))
      .then(async () => {
        // `CREATE TABLE IF NOT EXISTS` is a no-op against a table a previous release
        // already made, and this one predates the two heartbeat columns — so a core
        // upgraded in place has a table without them and every `SELECT *` maps the
        // following two onto `undefined`. The same PRAGMA-diff `ADD COLUMN` pass the
        // other internal tables use, so an upgraded core reports "never seen" for its
        // existing rows rather than failing the whole MCP surface.
        const cols = await db.all<{ name: string }>(
          sql`PRAGMA table_info('_mcp_instances')`,
        )
        if (!cols.some((c) => c.name === 'reported_version')) {
          await db.run(sql`ALTER TABLE _mcp_instances ADD COLUMN reported_version TEXT`)
        }
        if (!cols.some((c) => c.name === 'last_seen_at')) {
          await db.run(sql`ALTER TABLE _mcp_instances ADD COLUMN last_seen_at TEXT`)
        }
        await db.run(sql.raw(`
          CREATE TABLE IF NOT EXISTS ${TOKEN_TABLE} (
            land TEXT NOT NULL DEFAULT 'root_lnd',
            colony TEXT NOT NULL DEFAULT 'root_cny',
            id TEXT NOT NULL,
            instance_id TEXT NOT NULL,
            name TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            permissions TEXT,
            expires_at TEXT,
            revoked_at TEXT,
            last_used_at TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            PRIMARY KEY (land, colony, id)
          )
        `))
        // The composite primary key is (land, colony, id), which is what makes a
        // listing scoped to one colony. It is NOT what makes an id unique: the
        // machine routes look a row up by `id` alone, because a worker presents an
        // instance id and nothing else — no land, no colony. Two colonies that each
        // generated an `mcp_…` would then be indistinguishable, and the wrong one
        // could be served.
        //
        // So uniqueness is asserted separately, platform-wide, and it is a UNIQUE
        // index rather than another primary key so the scoped reads keep the
        // composite key they already have.
        await db.run(
          sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_${sql.raw(INSTANCE_TABLE)}_id ON ${sql.raw(INSTANCE_TABLE)} (id)`,
        )
        await db.run(
          sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_${sql.raw(TOKEN_TABLE)}_id ON ${sql.raw(TOKEN_TABLE)} (id)`,
        )
        // Tokens are always listed and verified per instance, and an instance's
        // tokens must go when it does, so both queries walk this index.
        await db.run(
          sql`CREATE INDEX IF NOT EXISTS idx_${sql.raw(TOKEN_TABLE)}_instance ON ${sql.raw(TOKEN_TABLE)} (instance_id)`,
        )
        await db.run(
          sql`CREATE INDEX IF NOT EXISTS idx_${sql.raw(TOKEN_TABLE)}_hash ON ${sql.raw(TOKEN_TABLE)} (token_hash)`,
        )
      })
  await boot
  tablesReady = true
}

/**
 * Uniform base62 string.
 *
 * Rejection sampling rather than `% 62`: 256 is not a multiple of 62, so plain
 * modulo would make the first eight symbols measurably more likely than the
 * rest. That is a real bias in a credential, and it is the kind of thing nobody
 * looks at again once it ships.
 */
function randomBase62(length: number): string {
  const limit = 256 - (256 % BASE62.length)
  const out: string[] = []
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2))
    for (const b of bytes) {
      if (b >= limit) continue
      out.push(BASE62[b % BASE62.length]!)
      if (out.length === length) break
    }
  }
  return out.join('')
}

export function newMcpInstanceId(): string {
  return `mcp_${randomBase62(26)}`
}

export function newMcpTokenId(): string {
  return randomBase62(12)
}

/** `hmcp_<id>_<secret>` — the id is public, the secret is shown exactly once. */
export function newMcpTokenString(): { id: string; token: string; secret: string } {
  const id = newMcpTokenId()
  const secret = randomBase62(43)
  return { id, secret, token: `hmcp_${id}_${secret}` }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hashMcpSecret(secret: string): Promise<string> {
  return sha256Hex(secret)
}

/** Length-independent, branch-free compare — the hashes are attacker-supplied input. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Split a presented token into its lookup id and the secret to hash. */
export function parseMcpTokenString(token: string): { id: string; secret: string } | null {
  const m = MCP_TOKEN_PATTERN.exec(token.trim())
  if (!m) return null
  return { id: m[1]!, secret: m[2]! }
}

function rowToInstance(row: McpInstanceRow, counts: { total: number; active: number }): McpInstance {
  return {
    id: row.id,
    land: row.land,
    colony: row.colony,
    label: row.label,
    enabled: row.enabled === 1,
    readonly: row.readonly === 1,
    toolGroups: parseMcpToolGroups(row.tool_groups),
    dynamicTools: row.dynamic_tools,
    dynamicMax: row.dynamic_max,
    tokenCount: counts.total,
    activeTokenCount: counts.active,
    reportedVersion: row.reported_version ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * The subset a worker needs to build its server. Deliberately narrower than
 * {@link McpInstance}: the worker has no business knowing the label, the token
 * count, or the timestamps.
 */
function rowToConfig(row: McpInstanceRow): McpInstanceConfig {
  return {
    id: row.id,
    label: row.label,
    land: row.land,
    colony: row.colony,
    enabled: row.enabled === 1,
    readonly: row.readonly === 1,
    toolGroups: parseMcpToolGroups(row.tool_groups) as McpToolGroup[],
    dynamicTools: row.dynamic_tools,
    dynamicMax: row.dynamic_max,
  }
}

function rowToToken(row: McpTokenRow): McpToken {
  let permissions: Permission[] | null = null
  if (row.permissions) {
    try {
      const parsed = JSON.parse(row.permissions) as unknown
      if (Array.isArray(parsed)) permissions = parsed as Permission[]
    } catch {
      permissions = null
    }
  }
  return {
    id: row.id,
    instanceId: row.instance_id,
    land: row.land,
    colony: row.colony,
    name: row.name,
    permissions,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }
}

export interface McpInstanceTarget {
  land?: string
  colony?: string
}

/**
 * Accepts a semver-ish string an MCP worker claims for itself, or nothing.
 *
 * The cap is the part that matters. This value is stored and rendered in the console,
 * so a worker is not allowed to write an unbounded string into a column another party
 * reads; 32 characters covers `0.2.10` and every `1.0.0-rc.1` shape the release
 * tooling can produce. An over-long claim is dropped to `null` rather than truncated,
 * because a version cut mid-string is a wrong answer and "did not report" is not.
 */
const REPORTED_VERSION_PATTERN = /^[\w.+-]{1,32}$/

/**
 * Record that a deployment reached this core, and which release it says it is.
 *
 * Called from the machine routes on every authenticated worker request, which makes
 * two decisions worth spelling out:
 *
 * - **`land`/`colony` are not filtered.** The instance id is unique platform-wide and
 *   is the only credential on those routes — a worker holding one cannot know its own
 *   scope, because asking for the config is how it learns it. Narrowing this by a
 *   header would mean refusing to record a heartbeat for a worker that did nothing
 *   wrong.
 * - **`updated_at` is left alone.** This is machine bookkeeping on an operator row; if
 *   it bumped `updated_at`, every poll would make an untouched instance look edited
 *   and the console's "changed" ordering would become meaningless.
 *
 * A missing `version` argument still stamps `last_seen_at`: liveness and version are
 * independent facts, and an older worker that does not report its release is still
 * alive. Recording the two together — or refusing the heartbeat when the version is
 * absent — would lose the first fact because of a missing second one.
 */
export async function touchMcpInstanceHeartbeat(
  db: Db,
  id: string,
  version: string | undefined,
): Promise<void> {
  await ensureMcpTables(db)
  const reported = version && REPORTED_VERSION_PATTERN.test(version) ? version : null
  // One statement rather than a read-then-write: the row may legitimately not exist
  // (deleted between the credential check and here), and `changes === 0` is the same
  // "nothing to record" either way, with no chance of the two disagreeing.
  await db.run(
    sql`UPDATE ${sql.raw(INSTANCE_TABLE)} SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         reported_version = COALESCE(${reported}, reported_version)
       WHERE id = ${id}`,
  )
}

export async function listMcpInstances(
  db: Db,
  target: McpInstanceTarget = {},
): Promise<McpInstance[]> {
  await ensureMcpTables(db)
  const where: SQL[] = []
  if (target.colony) where.push(sql`colony = ${target.colony}`)
  else if (target.land) where.push(sql`land = ${target.land}`)
  const cond = where.length > 0 ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``
  const rows = await db.all<McpInstanceRow>(
    sql`SELECT * FROM ${sql.raw(INSTANCE_TABLE)} ${cond} ORDER BY land ASC, colony ASC, label ASC, id ASC`,
  )
  // One grouped count beats a query per row; the instance list is small but the
  // token table is not, and N+1 here is the difference between one and two
  // round trips on a page the operator opens often.
  const counts = await db.all<{ instance_id: string; total: number; active: number }>(
    sql`SELECT instance_id, count(*) AS total,
         sum(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN 1 ELSE 0 END) AS active
       FROM ${sql.raw(TOKEN_TABLE)} GROUP BY instance_id`,
  )
  const byInstance = new Map(counts.map((c) => [c.instance_id, c]))
  return rows.map((row) => {
    const c = byInstance.get(row.id)
    return rowToInstance(row, { total: c?.total ?? 0, active: c?.active ?? 0 })
  })
}

export async function getMcpInstanceRow(
  db: Db,
  id: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<McpInstanceRow> {
  await ensureMcpTables(db)
  const rows = await db.all<McpInstanceRow>(
    sql`SELECT * FROM ${sql.raw(INSTANCE_TABLE)} WHERE land = ${land} AND colony = ${colony} AND id = ${id} LIMIT 1`,
  )
  if (rows.length === 0) throw notFound(`MCP instance '${id}' not found`)
  return rows[0]!
}

export async function getMcpInstance(
  db: Db,
  id: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<McpInstance> {
  const row = await getMcpInstanceRow(db, id, land, colony)
  const tokens = await listMcpTokens(db, id, land, colony)
  const now = new Date().toISOString()
  return rowToInstance(row, {
    total: tokens.length,
    active: tokens.filter((t) => !t.revokedAt && (!t.expiresAt || t.expiresAt > now)).length,
  })
}

export async function getMcpInstanceConfig(db: Db, id: string): Promise<McpInstanceConfig> {
  await ensureMcpTables(db)
  // The instance id is the only credential presented here, so there is no land or
  // colony to narrow by — the id is unique platform-wide, which is what lets a
  // worker find its own scope without being told it.
  const rows = await db.all<McpInstanceRow>(
    sql`SELECT * FROM ${sql.raw(INSTANCE_TABLE)} WHERE id = ${id} LIMIT 1`,
  )
  // 401 rather than 404: this is a credential check, and a distinct "no such
  // instance" answer would confirm which ids are real to anyone probing.
  if (rows.length === 0) throw unauthorized('Unknown MCP instance', 'MCP_NOT_FOUND')
  return rowToConfig(rows[0]!)
}

export interface CreateMcpInstanceInput {
  label: string
  enabled?: boolean
  readonly?: boolean
  toolGroups?: readonly string[]
  dynamicTools?: string
  dynamicMax?: number
}

export async function createMcpInstance(
  db: Db,
  input: CreateMcpInstanceInput,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<McpInstance> {
  await ensureMcpTables(db)
  const id = newMcpInstanceId()
  if (!MCP_INSTANCE_ID_PATTERN.test(id)) throw badRequest('Generated instance id is malformed')
  // `formatMcpToolGroups([])` is the empty string, which parses back as the defaults
  // — but writing the defaults explicitly keeps the stored row legible in a sqlite
  // shell, which is where anyone debugging an instance actually starts.
  const groups =
    input.toolGroups && input.toolGroups.length > 0 ? input.toolGroups : DEFAULT_MCP_TOOL_GROUPS
  await db.run(
    sql`INSERT INTO ${sql.raw(INSTANCE_TABLE)} (land, colony, id, label, enabled, readonly, tool_groups, dynamic_tools, dynamic_max)
      VALUES (${land}, ${colony}, ${id}, ${input.label}, ${input.enabled === false ? 0 : 1}, ${input.readonly ? 1 : 0}, ${formatMcpToolGroups(groups)}, ${input.dynamicTools ?? ''}, ${input.dynamicMax ?? 10})`,
  )
  return getMcpInstance(db, id, land, colony)
}

export interface UpdateMcpInstanceInput {
  label?: string
  enabled?: boolean
  readonly?: boolean
  toolGroups?: readonly string[]
  dynamicTools?: string
  dynamicMax?: number
}

export async function updateMcpInstance(
  db: Db,
  id: string,
  input: UpdateMcpInstanceInput,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<McpInstance> {
  await ensureMcpTables(db)
  const sets: SQL[] = []
  if (input.label !== undefined) sets.push(sql`label = ${input.label}`)
  if (input.enabled !== undefined) sets.push(sql`enabled = ${input.enabled ? 1 : 0}`)
  if (input.readonly !== undefined) sets.push(sql`readonly = ${input.readonly ? 1 : 0}`)
  if (input.toolGroups !== undefined) sets.push(sql`tool_groups = ${formatMcpToolGroups(input.toolGroups)}`)
  if (input.dynamicTools !== undefined) sets.push(sql`dynamic_tools = ${input.dynamicTools}`)
  if (input.dynamicMax !== undefined) sets.push(sql`dynamic_max = ${input.dynamicMax}`)
  if (sets.length === 0) throw badRequest('Nothing to update')
  sets.push(sql`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
  const res = await db.run(
    sql`UPDATE ${sql.raw(INSTANCE_TABLE)} SET ${sql.join(sets, sql`, `)} WHERE land = ${land} AND colony = ${colony} AND id = ${id}`,
  )
  if (res.meta.changes === 0) throw notFound(`MCP instance '${id}' not found`)
  return getMcpInstance(db, id, land, colony)
}

export async function deleteMcpInstance(
  db: Db,
  id: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<void> {
  await ensureMcpTables(db)
  const res = await db.run(
    sql`DELETE FROM ${sql.raw(INSTANCE_TABLE)} WHERE land = ${land} AND colony = ${colony} AND id = ${id}`,
  )
  if (res.meta.changes === 0) throw notFound(`MCP instance '${id}' not found`)
  // Tokens die with their instance. Leaving them behind would mean a deleted
  // instance's credentials still resolve to a scope, and the next instance
  // created in this colony would be one `CREATE` away from accepting them.
  await db.run(
    sql`DELETE FROM ${sql.raw(TOKEN_TABLE)} WHERE land = ${land} AND colony = ${colony} AND instance_id = ${id}`,
  )
}

export async function listMcpTokens(
  db: Db,
  instanceId: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<McpToken[]> {
  await ensureMcpTables(db)
  const rows = await db.all<McpTokenRow>(
    sql`SELECT * FROM ${sql.raw(TOKEN_TABLE)} WHERE land = ${land} AND colony = ${colony} AND instance_id = ${instanceId} ORDER BY created_at DESC, id ASC`,
  )
  return rows.map(rowToToken)
}

export interface CreateMcpTokenInput {
  name: string
  permissions?: readonly Permission[]
  expiresAt?: string | null
}

export interface VerifiedMcpToken {
  token: McpToken
  instance: McpInstanceConfig
  permissions: Permission[]
}

/**
 * Resolve a presented token to an instance and the exact permissions it carries.
 *
 * The lookup is by token id — a primary key hit — and only then compares hashes.
 * The instance's permission set is computed first and the token's own list
 * intersects it, so a token can narrow what its instance allows but can never
 * widen it. That direction is the whole reason the two are stored separately.
 *
 * **`instanceId` is required, and the token must belong to *that* instance.**
 *
 * It is easy to miss why, because each half looks sufficient on its own. The token
 * already names its instance in `instance_id`, so checking that alone would resolve
 * to the right scope — and the instance id in the header would only ever be used to
 * authenticate the caller. That is exactly the bug: any worker, in any colony, could
 * present its own valid instance id and exchange somebody else's token, and the
 * session it got back would be scoped to the *other* colony. The token would then
 * work against data the presenting worker has no business reaching, and the
 * worker's own id would appear legitimate in every log along the way.
 *
 * The header id is therefore an assertion by the caller about which instance it
 * believes it is, and the only safe reading is to hold it against the token.
 */
export async function verifyMcpToken(
  db: Db,
  presented: string,
  instanceId: string,
): Promise<VerifiedMcpToken> {
  await ensureMcpTables(db)
  // 401, not 400: every one of these is "your credential is not accepted", and an
  // agent treats 400 as a bug in its own request while 401 as "re-authenticate".
  // The *codes* still differ, because the console and the worker both need to tell
  // a revoked token from a wrong one in order to say anything useful — but the
  // message does not, so a caller cannot enumerate which token ids exist.
  const parsed = parseMcpTokenString(presented)
  if (!parsed) throw unauthorized('Invalid token', 'INVALID_TOKEN')
  const rows = await db.all<McpTokenRow>(
    sql`SELECT * FROM ${sql.raw(TOKEN_TABLE)} WHERE id = ${parsed.id} LIMIT 1`,
  )
  const row = rows[0]
  // Uniform message on purpose: a caller must not be able to tell "no such token"
  // from "wrong secret" and walk the id space.
  if (!row) throw unauthorized('Invalid token', 'INVALID_TOKEN')
  if (!timingSafeEqual(row.token_hash, await hashMcpSecret(parsed.secret))) {
    throw unauthorized('Invalid token', 'INVALID_TOKEN')
  }
  if (row.revoked_at) throw unauthorized('This token has been revoked', 'TOKEN_REVOKED')
  if (row.expires_at && row.expires_at <= new Date().toISOString()) {
    throw unauthorized('This token has expired', 'TOKEN_EXPIRED')
  }
  const instanceRows = await db.all<McpInstanceRow>(
    sql`SELECT * FROM ${sql.raw(INSTANCE_TABLE)} WHERE id = ${row.instance_id} LIMIT 1`,
  )
  const instanceRow = instanceRows[0]
  if (!instanceRow) throw unauthorized('Invalid token', 'INVALID_TOKEN')
  // The token's own instance, not the one in the header. A mismatch means the caller
  // is a different deployment than the credential belongs to.
  if (row.instance_id !== instanceId) throw unauthorized('Invalid token', 'INVALID_TOKEN')
  const instance = rowToConfig(instanceRow)
  // 403 here and only here: the credential is valid, the thing it points at is off.
  // A disabled instance is a deliberate switch in the console, not a bad token, and
  // conflating the two would send an operator hunting for a credential problem.
  if (!instance.enabled) throw forbidden('This MCP instance is disabled', 'MCP_DISABLED')

  const instancePerms = mcpPermissions({
    toolGroups: instance.toolGroups,
    readonly: instance.readonly,
  })
  const token = rowToToken(row)
  const granted = token.permissions
    ? instancePerms.filter((p) => (token.permissions as Permission[]).includes(p))
    : instancePerms

  await db.run(
    sql`UPDATE ${sql.raw(TOKEN_TABLE)} SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE land = ${row.land} AND colony = ${row.colony} AND id = ${row.id}`,
  )
  return { token, instance, permissions: granted }
}

export interface CreatedMcpToken {
  token: McpToken
  /** Plaintext, returned exactly once. */
  secret: string
}

export async function createMcpToken(
  db: Db,
  instanceId: string,
  input: CreateMcpTokenInput,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<CreatedMcpToken> {
  await ensureMcpTables(db)
  // Fails loudly rather than minting a token for an instance that is not there.
  await getMcpInstanceRow(db, instanceId, land, colony)
  const { id, secret, token } = newMcpTokenString()
  const perms = input.permissions && input.permissions.length > 0 ? JSON.stringify([...input.permissions]) : null
  await db.run(
    sql`INSERT INTO ${sql.raw(TOKEN_TABLE)} (land, colony, id, instance_id, name, token_hash, permissions, expires_at)
      VALUES (${land}, ${colony}, ${id}, ${instanceId}, ${input.name}, ${await hashMcpSecret(secret)}, ${perms}, ${input.expiresAt ?? null})`,
  )
  const rows = await db.all<McpTokenRow>(
    sql`SELECT * FROM ${sql.raw(TOKEN_TABLE)} WHERE land = ${land} AND colony = ${colony} AND id = ${id} LIMIT 1`,
  )
  return { token: rowToToken(rows[0]!), secret: token }
}

export async function revokeMcpToken(
  db: Db,
  id: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<McpToken> {
  await ensureMcpTables(db)
  const res = await db.run(
    sql`UPDATE ${sql.raw(TOKEN_TABLE)} SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE land = ${land} AND colony = ${colony} AND id = ${id} AND revoked_at IS NULL`,
  )
  if (res.meta.changes === 0) throw notFound('Token not found or already revoked')
  const rows = await db.all<McpTokenRow>(
    sql`SELECT * FROM ${sql.raw(TOKEN_TABLE)} WHERE land = ${land} AND colony = ${colony} AND id = ${id} LIMIT 1`,
  )
  return rowToToken(rows[0]!)
}
