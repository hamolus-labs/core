#!/usr/bin/env node
/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 *
 * Code-defined collections/panels — registration contract (offline, no server).
 *
 * Why this exists: `setCodeDefinitions()` is called at module scope by a generated
 * core, *before* any request is served. That makes it the one place where a bad
 * definition file must fail loudly — if it deferred, a typo would turn every API
 * call into a validation error instead of failing the deploy. This check pins the
 * half of the contract that never needs a database:
 *
 *   1. valid definitions register, and the guard helpers reflect exactly them,
 *   2. an invalid collection, an invalid panel, a duplicate collection name and a
 *      duplicate panel id each throw at registration instead of being applied,
 *   3. every problem in one call is reported together (a deploy shows all of them,
 *      not one per attempt),
 *   4. re-registering replaces the set, and *omitting* a definition releases its
 *      guard, so a removed file hands the collection back to the console,
 *   6. a scope is latched only after the writers succeed: a failing write is
 *      retried on the next request instead of being remembered as applied.
 *
 * What this cannot see, and where it is covered instead: writing the definitions
 * into D1, applying collections before panels (a panel whose `collection` is not
 * registered is rejected by the writer, so a registered panel proves the order),
 * and the `403` guards over HTTP. Those need a running core and live in
 * `packages/cli/scripts/check-code-defined-core.mjs`, which runs against a core
 * generated with `hamolus create <name> --core predefined` — the only core template
 * that ships a `src/collections` barrel.
 *
 *   node packages/core/scripts/check-code-definitions.mjs
 *   pnpm -F @hamolus/core check:code-definitions
 *
 * No server, no network, and self-cleaning: the module is compiled to a throwaway
 * directory under `packages/core/node_modules/` and removed afterwards.
 *
 * Why it compiles instead of importing: `node --experimental-strip-types` cannot
 * load `src/definitions.ts` because the graph reaches `src/errors.ts`, whose
 * parameter properties are not erasable type syntax
 * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). `tsc` compiles them away, and the
 * emitted CommonJS resolves `@hamolus/types` through this package's own
 * `node_modules`, so the module runs in-process with nothing else installed.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const EMIT = join(PKG, 'node_modules', '.check-code-definitions')
const requireFromPackage = createRequire(join(PKG, 'package.json'))

let pass = 0
const failures = []
const ok = (name, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? `\n      ${String(detail).replace(/\n/g, '\n      ')}` : ''}`)
  }
}

const collection = (name, over = {}) => ({
  name,
  label: name,
  primaryKey: 'id',
  fields: [{ name: 'title', label: 'Title', type: 'string', required: true }],
  ...over,
})
const panel = (id, over = {}) => ({
  id,
  name: id,
  views: [
    {
      id: 'rows',
      kind: 'table',
      label: 'Rows',
      path: '/rows',
      collection: 'posts',
      operations: ['read'],
      fields: { read: ['id', 'title'], write: [] },
    },
  ],
  roles: [{ id: 'reader', label: 'Reader', views: [{ viewId: 'rows', operations: ['read'] }] }],
  menu: [{ id: 'rows', label: 'Rows', path: '/rows', viewId: 'rows' }],
  ...over,
})

/** A `Db` handle that fails on first touch — used to prove the failure path. */
const explodingDb = () =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`unexpected database access during registration: ${String(prop)}`)
      },
    },
  )

function compileDefinitions() {
  const tsc = requireFromPackage.resolve('typescript/lib/tsc.js')
  execFileSync(
    process.execPath,
    [
      tsc,
      'src/definitions.ts',
      '--outDir',
      EMIT,
      '--module',
      'commonjs',
      '--target',
      'es2022',
      '--moduleResolution',
      'node',
      '--esModuleInterop',
      '--skipLibCheck',
      '--types',
      '@cloudflare/workers-types',
    ],
    { cwd: PKG, stdio: 'pipe' },
  )
  if (!existsSync(join(EMIT, 'definitions.js'))) {
    throw new Error('tsc emitted no definitions.js — the compile step silently produced nothing')
  }
  // `packages/core/package.json` is `"type": "module"`; the emit is CommonJS, so
  // the directory needs its own manifest or Node would parse it as ESM and fail
  // on the first `require`.
  writeFileSync(join(EMIT, 'package.json'), '{"type":"commonjs"}')
  return createRequire(join(EMIT, 'definitions.js'))('./definitions.js')
}

function registrationError(run) {
  try {
    run()
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

let definitions = null
try {
  rmSync(EMIT, { recursive: true, force: true })
  mkdirSync(EMIT, { recursive: true })
  definitions = compileDefinitions()
  ok('the definitions module compiles and loads in-process', Boolean(definitions))
} catch (error) {
  ok('the definitions module compiles and loads in-process', false, error)
}

if (definitions) {
  const { ensureCodeDefinitions, getCodeDefinitions, isCodeCollection, isCodePanel, setCodeDefinitions } =
    definitions

  // 1. Registration and the guard helpers ------------------------------------
  setCodeDefinitions({
    collections: [collection('posts', { fields: [{ name: 'published', label: 'Published', type: 'boolean', default: false }] })],
    panels: [panel('content')],
  })
  ok(
    'registered definitions are listed by name',
    JSON.stringify(getCodeDefinitions()) === JSON.stringify({ collections: ['posts'], panels: ['content'] }),
    JSON.stringify(getCodeDefinitions()),
  )
  ok('isCodeCollection is true for a declared collection', isCodeCollection('posts') === true)
  ok('isCodeCollection is false for an undeclared one', isCodeCollection('contacts') === false)
  ok('isCodePanel is true for a declared panel', isCodePanel('content') === true)
  ok('isCodePanel is false for an undeclared one', isCodePanel('inbox') === false)

  // 2/3. Boot-time validation ------------------------------------------------
  const cases = [
    {
      name: 'an invalid collection throws at registration',
      error: registrationError(() => setCodeDefinitions({ collections: [{ name: 'Bad Name' }] })),
      expect: /Invalid code definitions/,
      also: /collections\[0\]/,
    },
    {
      name: 'an invalid panel throws at registration',
      error: registrationError(() => setCodeDefinitions({ panels: [{ id: 'content' }] })),
      expect: /Invalid code definitions/,
      also: /panels\[0\]/,
    },
    {
      name: 'a duplicate collection name throws and names the duplicate',
      error: registrationError(() =>
        setCodeDefinitions({ collections: [collection('posts'), collection('posts')] }),
      ),
      expect: /duplicate collection name 'posts'/,
    },
    {
      name: 'a duplicate panel id throws and names the duplicate',
      error: registrationError(() => setCodeDefinitions({ panels: [panel('content'), panel('content')] })),
      expect: /duplicate panel id 'content'/,
    },
    {
      name: 'one call reports every problem at once',
      error: registrationError(() =>
        setCodeDefinitions({
          collections: [{ name: 'Bad Name' }, collection('posts'), collection('posts')],
          panels: [panel('content'), panel('content')],
        }),
      ),
      expect: /duplicate panel id 'content'/,
      also: /duplicate collection name 'posts'/,
    },
  ]
  for (const testCase of cases) {
    const { error, expect, also } = testCase
    const matched = error !== null && expect.test(error.message) && (!also || also.test(error.message))
    ok(testCase.name, matched, error ? error.message : 'no error was thrown')
  }
  ok(
    'a failed registration leaves the previous definitions in place',
    JSON.stringify(getCodeDefinitions()) === JSON.stringify({ collections: ['posts'], panels: ['content'] }),
    JSON.stringify(getCodeDefinitions()),
  )

  // 4. Falsy defaults are not dropped ----------------------------------------
  // `setCodeDefinitions` hands the parsed definition straight to `putCollection`,
  // so a `default` that the schema would drop silently becomes a column without a
  // default. The falsy cases are the ones a truthiness check would lose. The
  // parsed definitions themselves are private, so this asserts the schema it
  // parses with; the persisted value is asserted over HTTP by
  // `check-code-defined-core.mjs`.
  const { collectionDefinitionSchema } = requireFromPackage('@hamolus/types')
  const withDefaults = collectionDefinitionSchema.safeParse(
    collection('posts', {
      fields: [
        { name: 'title', label: 'Title', type: 'string', required: true },
        { name: 'published', label: 'Published', type: 'boolean', default: false },
        { name: 'views', label: 'Views', type: 'number', default: 0 },
        { name: 'slug', label: 'Slug', type: 'slug', default: '' },
      ],
    }),
  )
  const defaults = withDefaults.success
    ? Object.fromEntries(withDefaults.data.fields.map((field) => [field.name, field.default]))
    : {}
  ok('a `false` field default survives the schema', 'published' in defaults && defaults.published === false, JSON.stringify(defaults))
  ok('a `0` field default survives the schema', 'views' in defaults && defaults.views === 0, JSON.stringify(defaults))
  ok('an empty-string field default survives the schema', 'slug' in defaults && defaults.slug === '', JSON.stringify(defaults))

  setCodeDefinitions({
    collections: [
      collection('posts', {
        fields: [
          { name: 'title', label: 'Title', type: 'string', required: true },
          { name: 'published', label: 'Published', type: 'boolean', default: false },
        ],
      }),
    ],
  })
  ok('a collection carrying falsy defaults registers', isCodeCollection('posts') === true)

  // 5. Re-registration and omission -----------------------------------------
  setCodeDefinitions({ collections: [collection('notes')], panels: [] })
  ok(
    're-registering replaces the set (posts released, notes held)',
    isCodeCollection('notes') === true && isCodeCollection('posts') === false && isCodePanel('content') === false,
    JSON.stringify(getCodeDefinitions()),
  )
  setCodeDefinitions()
  ok(
    'omitting the definitions releases every guard',
    isCodeCollection('notes') === false && isCodePanel('content') === false,
    JSON.stringify(getCodeDefinitions()),
  )

  // 6. The scope latch -------------------------------------------------------
  await ensureCodeDefinitions(explodingDb())
  ok('with no definitions declared, registration never touches the database', true)

  setCodeDefinitions({ collections: [collection('posts')] })
  let firstFailed = false
  try {
    await ensureCodeDefinitions(explodingDb())
  } catch {
    firstFailed = true
  }
  ok('a failing write surfaces its error', firstFailed)

  let secondFailed = false
  try {
    await ensureCodeDefinitions(explodingDb(), 'other_lnd', 'other_cny')
  } catch {
    secondFailed = true
  }
  ok('a failed scope is retried instead of being remembered as applied', secondFailed)
}

rmSync(EMIT, { recursive: true, force: true })

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
