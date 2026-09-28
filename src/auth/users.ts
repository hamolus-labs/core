/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import { sql, type SQL } from 'drizzle-orm'
import { COLONY_DEFAULT, LAND_DEFAULT, type AuthUser, type PrivilegeScope } from '@hamolus/types'
import type { Db } from '../db/client'
import { isIdentifier, quoteIdentifier } from '../db/table'
import { badRequest, notFound } from '../errors'
import { getPrivilegesMap } from './privileges'

/** Internal table backing the `users` management feature (never a dynamic collection). */
const TABLE = '_auth_users'

export interface AuthUserRow {
  id: string
  land: string
  colony: string
  username: string
  name: string | null
  password_hash: string
  privilege_id: string
  is_active: number
  created_at: string
  updated_at: string
}

export interface PrivilegeRef {
  name: string
  label: string
  scope: PrivilegeScope
}

let usersReady = false

async function pkIsComposite(db: Db, table: string): Promise<boolean> {
  const indexes = await db.all<{ name: string; origin: string }>(
    sql`PRAGMA index_list(${sql.raw(`'${table}'`)})`,
  )
  const pkIdx = indexes.find((i) => i.origin === 'pk')
  if (!pkIdx) return false
  const info = await db.all<{ seqno: number }>(
    sql`PRAGMA index_info(${sql.raw(`'${pkIdx.name}'`)})`,
  )
  return info.length > 1
}

export async function ensureAuthUsersTable(db: Db): Promise<void> {
  if (usersReady) return
  const boot = db
      .run(sql.raw(`
        CREATE TABLE IF NOT EXISTS _auth_users (
          land TEXT NOT NULL DEFAULT 'root_lnd',
          colony TEXT NOT NULL DEFAULT 'root_cny',
          id TEXT NOT NULL,
          username TEXT NOT NULL COLLATE NOCASE,
          name TEXT,
          password_hash TEXT NOT NULL,
          privilege_id TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (land, colony, id)
        )
      `))
      .then(async () => {
        const cols = await db.all<{ name: string }>(
          sql`PRAGMA table_info('_auth_users')`,
        )
        if (!cols.some((c) => c.name === 'land')) {
          await db.run(sql`ALTER TABLE _auth_users ADD COLUMN land TEXT NOT NULL DEFAULT 'root_lnd'`)
        }
        if (!cols.some((c) => c.name === 'colony')) {
          await db.run(
            sql`ALTER TABLE _auth_users ADD COLUMN colony TEXT NOT NULL DEFAULT 'root_cny'`,
          )
        }
        if (!(await pkIsComposite(db, '_auth_users'))) {
          // NOTE: sqlite autoindexes cannot be dropped and rename with their
          // table; RENAME carries the old unique-index autoindex over to the
          // legacy table automatically.
          await db.run(sql`ALTER TABLE _auth_users RENAME TO _auth_users_legacy`)
          await db.run(sql.raw(`
            CREATE TABLE _auth_users (
              land TEXT NOT NULL DEFAULT 'root_lnd',
              colony TEXT NOT NULL DEFAULT 'root_cny',
              id TEXT NOT NULL,
              username TEXT NOT NULL COLLATE NOCASE,
              name TEXT,
              password_hash TEXT NOT NULL,
              privilege_id TEXT NOT NULL,
              is_active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              PRIMARY KEY (land, colony, id),
              UNIQUE (username)
            )
          `))
          await db.run(sql.raw(`
            INSERT INTO _auth_users (land, colony, id, username, name, password_hash, privilege_id, is_active, created_at, updated_at)
            SELECT 'root_lnd', 'root_cny', id, username, name, password_hash, privilege_id, is_active, created_at, updated_at FROM _auth_users_legacy
          `))
          await db.run(sql`DROP TABLE IF EXISTS _auth_users_legacy`)
        }
      })
  await boot
  usersReady = true
}

function rowToUser(row: AuthUserRow, privById: Map<string, PrivilegeRef>): AuthUser {
  const priv = privById.get(row.privilege_id)
  return {
    id: row.id,
    land: row.land,
    colony: row.colony,
    username: row.username,
    name: row.name,
    privilegeId: row.privilege_id,
    privilegeName: priv?.name ?? null,
    privilegeLabel: priv?.label ?? null,
    privilegeScope: priv?.scope ?? null,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function countUsers(db: Db): Promise<number> {
  await ensureAuthUsersTable(db)
  const res = await db.get<{ total: number }>(sql`SELECT count(*) AS total FROM ${sql.raw(TABLE)}`)
  return Number(res?.total ?? 0)
}

export async function listUserRows(
  db: Db,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<AuthUserRow[]> {
  await ensureAuthUsersTable(db)
  return db.all<AuthUserRow>(
    sql`SELECT * FROM ${sql.raw(TABLE)} WHERE land = ${land} AND colony = ${colony} ORDER BY created_at ASC, id ASC`,
  )
}

/** Every user row of a land, across all of its colonies (land-admin view). */
export async function listUserRowsForLand(db: Db, land: string = LAND_DEFAULT): Promise<AuthUserRow[]> {
  await ensureAuthUsersTable(db)
  return db.all<AuthUserRow>(
    sql`SELECT * FROM ${sql.raw(TABLE)} WHERE land = ${land} ORDER BY colony ASC, created_at ASC, id ASC`,
  )
}

export async function getUserRowById(
  db: Db,
  id: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<AuthUserRow> {
  await ensureAuthUsersTable(db)
  return getOne(
    db,
    sql`${sql.raw(quoteIdentifier('land'))} = ${land} AND ${sql.raw(quoteIdentifier('colony'))} = ${colony} AND ${sql.raw(quoteIdentifier('id'))} = ${id}`,
  )
}

/** Global username lookup (usernames are unique across the whole platform). */
export async function getUserRowByUsername(db: Db, username: string): Promise<AuthUserRow> {
  await ensureAuthUsersTable(db)
  return getOne(db, sql`${sql.raw(quoteIdentifier('username'))} = ${username}`)
}

async function getOne(db: Db, cond: SQL): Promise<AuthUserRow> {
  const rows = await db.all<AuthUserRow>(
    sql`SELECT * FROM ${sql.raw(TABLE)} WHERE ${cond} LIMIT 1`,
  )
  if (rows.length === 0) throw notFound('User not found')
  return rows[0]!
}

export interface CreateUserInput {
  username: string
  name: string | null
  passwordHash: string
  privilegeId: string
  isActive?: boolean
}

export async function createUserRow(
  db: Db,
  input: CreateUserInput,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<AuthUserRow> {
  await ensureAuthUsersTable(db)
  const id = crypto.randomUUID()
  if (!isIdentifier(input.username)) throw badRequest('Invalid username')
  try {
    await db.run(
      sql`INSERT INTO ${sql.raw(TABLE)} (land, colony, id, username, name, password_hash, privilege_id, is_active, created_at, updated_at) VALUES (${land}, ${colony}, ${id}, ${input.username}, ${input.name}, ${input.passwordHash}, ${input.privilegeId}, ${input.isActive === false ? 0 : 1}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    )
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw badRequest(`Username '${input.username}' is already taken`, 'DUPLICATE')
    throw err
  }
  return getUserRowById(db, id, land, colony)
}

export interface UpdateUserInput {
  name?: string | null
  passwordHash?: string
  privilegeId?: string
  isActive?: boolean
}

export async function updateUserRow(
  db: Db,
  id: string,
  input: UpdateUserInput,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<AuthUserRow> {
  await ensureAuthUsersTable(db)
  const sets: SQL[] = []
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`)
  if (input.passwordHash !== undefined) sets.push(sql`password_hash = ${input.passwordHash}`)
  if (input.privilegeId !== undefined) sets.push(sql`privilege_id = ${input.privilegeId}`)
  if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive ? 1 : 0}`)
  sets.push(sql`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
  const res = await db.run(
    sql`UPDATE ${sql.raw(TABLE)} SET ${sql.join(sets, sql`, `)} WHERE ${sql.raw(quoteIdentifier('land'))} = ${land} AND ${sql.raw(quoteIdentifier('colony'))} = ${colony} AND ${sql.raw(quoteIdentifier('id'))} = ${id}`,
  )
  if (res.meta.changes === 0) throw notFound('User not found')
  return getUserRowById(db, id, land, colony)
}

export async function deleteUserRow(
  db: Db,
  id: string,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<void> {
  await ensureAuthUsersTable(db)
  const res = await db.run(
    sql`DELETE FROM ${sql.raw(TABLE)} WHERE ${sql.raw(quoteIdentifier('land'))} = ${land} AND ${sql.raw(quoteIdentifier('colony'))} = ${colony} AND ${sql.raw(quoteIdentifier('id'))} = ${id}`,
  )
  if (res.meta.changes === 0) throw notFound('User not found')
}

/** Number of active users holding the 'admin' privilege (used to protect the last admin). */
export async function countActiveAdmins(
  db: Db,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<number> {
  const rows = await listUserRows(db, land, colony)
  const privById = await getPrivilegesMap(db, land, colony)
  return rows.filter((r) => r.is_active === 1 && privById.get(r.privilege_id)?.name === 'admin').length
}

/** Serialize rows into public AuthUser shape (password hash never leaves the row type). */
export function serializeUsers(rows: AuthUserRow[], privById: Map<string, PrivilegeRef>): AuthUser[] {
  return rows.map((r) => rowToUser(r, privById))
}

export function serializeUser(row: AuthUserRow, privById: Map<string, PrivilegeRef>): AuthUser {
  return rowToUser(row, privById)
}