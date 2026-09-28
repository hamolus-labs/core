/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 *
 * Code-defined collections and panels.
 *
 * A generated core can ship its schema in source control instead of (or as well
 * as) creating it through the console. The Worker entry point hands the
 * definitions over once at module scope:
 *
 * ```ts
 * import app, { setCodeDefinitions } from '@hamolus/core'
 * import { collections } from './collections'
 * import { panels } from './panels'
 *
 * setCodeDefinitions({ collections, panels })
 * export default app
 * ```
 *
 * Two properties make this safe to expose as a normal API surface:
 *
 * 1. **The file is authoritative.** Definitions are re-applied on deploy for
 *    every registered scope, mirroring how `PRIVILEGES_DEF` seeds the
 *    platform-owned `privileges` collection.
 * 2. **The definition is read-only at runtime.** `PUT`/`DELETE` on a
 *    code-defined collection, and any mutation of a code-defined panel, are
 *    refused with `403`. Records inside a code-defined collection stay fully
 *    editable, which is what makes the collection useful — the schema is frozen,
 *    the data is not.
 *
 * Defining something here and then editing it in the console is therefore a
 * no-op at best and a `403` at worst; the file is the only place to change it.
 */
import {
  COLONY_DEFAULT,
  LAND_DEFAULT,
  collectionDefinitionSchema,
  panelDefinitionSchema,
  type CollectionDefinition,
  type CollectionDefinitionInput,
  type PanelDefinition,
  type PanelDefinitionInput,
} from '@hamolus/types'
import type { Db } from './db/client'
import { putCollection } from './meta/store'
import { putPanel } from './meta/panels'

export interface CodeDefinitions {
  /** Collection definitions, applied in array order before any panel. */
  collections?: CollectionDefinitionInput[]
  /** Panel definitions, applied after collections so their references resolve. */
  panels?: PanelDefinitionInput[]
}

const EMPTY: CodeDefinitions = { collections: [], panels: [] }

let current: { collections: CollectionDefinition[]; panels: PanelDefinition[] } = {
  collections: [],
  panels: [],
}

/** Scopes whose code definitions have already been applied. */
const applied = new Set<string>()

function describe(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
}

/**
 * Register the definitions declared in source control. Call once at module
 * scope, next to `setCoreConfig`. Invalid definitions throw here rather than on
 * the first request, so a bad definition file fails loudly at boot instead of
 * turning every API call into a validation error.
 */
export function setCodeDefinitions(input: CodeDefinitions = EMPTY): void {
  const problems: string[] = []
  const collections: CollectionDefinition[] = []
  const panels: PanelDefinition[] = []
  const seenCollections = new Set<string>()
  const seenPanels = new Set<string>()

  for (const [index, candidate] of (input.collections ?? []).entries()) {
    const parsed = collectionDefinitionSchema.safeParse(candidate)
    if (!parsed.success) {
      problems.push(`collections[${index}]: ${describe(parsed.error.issues)}`)
      continue
    }
    if (seenCollections.has(parsed.data.name)) {
      problems.push(`collections[${index}]: duplicate collection name '${parsed.data.name}'`)
      continue
    }
    seenCollections.add(parsed.data.name)
    collections.push(parsed.data)
  }

  for (const [index, candidate] of (input.panels ?? []).entries()) {
    const parsed = panelDefinitionSchema.safeParse(candidate)
    if (!parsed.success) {
      problems.push(`panels[${index}]: ${describe(parsed.error.issues)}`)
      continue
    }
    if (seenPanels.has(parsed.data.id)) {
      problems.push(`panels[${index}]: duplicate panel id '${parsed.data.id}'`)
      continue
    }
    seenPanels.add(parsed.data.id)
    panels.push(parsed.data)
  }

  if (problems.length) {
    throw new Error(`Invalid code definitions:\n  - ${problems.join('\n  - ')}`)
  }

  current = { collections, panels }
  // A new definition set must reach scopes that were already bootstrapped.
  applied.clear()
}

/** The collection names and panel ids currently declared in code. */
export function getCodeDefinitions(): { collections: string[]; panels: string[] } {
  return { collections: current.collections.map((def) => def.name), panels: current.panels.map((p) => p.id) }
}

/** True when `name` is a code-defined collection and its definition is frozen. */
export function isCodeCollection(name: string): boolean {
  return current.collections.some((def) => def.name === name)
}

/** True when `id` is a code-defined panel and its definition is frozen. */
export function isCodePanel(id: string): boolean {
  return current.panels.some((panel) => panel.id === id)
}

function scopeKey(land: string, colony: string): string {
  return `${land || LAND_DEFAULT}\u0000${colony || COLONY_DEFAULT}`
}

/**
 * Apply the code definitions to one scope, once. Called per registered scope
 * from the same bootstrap that seeds privileges, so a freshly created land
 * starts from the same baseline as the default one.
 */
export async function ensureCodeDefinitions(
  db: Db,
  land: string = LAND_DEFAULT,
  colony: string = COLONY_DEFAULT,
): Promise<void> {
  if (current.collections.length === 0 && current.panels.length === 0) return
  const key = scopeKey(land, colony)
  if (applied.has(key)) return
  const pending = (async () => {
    // Collections first: a panel may reference a collection, and the panel
    // writer rejects a definition whose views point at unregistered ones.
    for (const def of current.collections) {
      // `putCollection` re-validates through the same schema and accepts an
      // untrusted record; the parsed definition is a valid one.
      await putCollection(db, { ...def }, land, colony)
    }
    for (const panel of current.panels) {
      await putPanel(db, panel, land, colony)
    }
  })()
  await pending
  // A completion latch, NOT a shared promise. Awaiting a promise created inside
  // another request resumes in that request's async context, and the next D1
  // call throws `Cannot perform I/O on behalf of a different request`
  // (I/O type: `UserTraceAsyncContext`) — a self-sustaining 500 loop under load.
  // Both writers are idempotent upserts, so duplicate work is harmless, and
  // latching only after `await pending` means a transient failure retries.
  applied.add(key)
}
