/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 */

import type { FieldDefinition } from '@hamolus/types'
import { currencyBaseOf } from '@hamolus/types'

/** Convert input values (JSON) into the values stored in D1. */
export function toDbValue(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return null
  const isHasMany = field.type === 'relation' && field.relation?.kind === 'hasMany'
  switch (field.type) {
    case 'boolean':
      return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0
    case 'number': {
      const n = Number(value)
      return Number.isNaN(n) ? null : n
    }
    case 'currency':
    case 'custom_currency': {
      // Accept the raw amount (number/string) or a serialized read shape —
      // `{ base, currency, display }` / `{ base, symbol, display }`. Only the
      // amount is stored; the rest is derived per read.
      return currencyBaseOf(value)
    }
    case 'richtext':
    case 'json':
    case 'media':
    case 'document':
    case 'attachment':
      return typeof value === 'string' ? value : JSON.stringify(value)
    default:
      if (isHasMany) return typeof value === 'string' ? value : JSON.stringify(value)
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
  }
}

/** Convert a D1 row value back into the API shape. */
export function fromDbValue(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return null
  const isHasMany = field.type === 'relation' && field.relation?.kind === 'hasMany'
  const isMultiEnum = field.type === 'enum' && field.control === 'multichecklist'
  switch (field.type) {
    case 'boolean':
      return value === 1 || value === '1' || value === true
    case 'json':
    case 'media':
    case 'document':
    case 'attachment':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      }
      return value
    case 'richtext':
      if (field.format === 'markdown' || field.format === 'mdx') return value
      if (typeof value === 'string') {
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      }
      return value
    default:
      if ((isHasMany || isMultiEnum) && typeof value === 'string') {
        try { return JSON.parse(value) as unknown[] } catch { return value }
      }
      return value
  }
}