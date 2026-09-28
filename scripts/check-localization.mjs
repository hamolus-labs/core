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
 * Localization contract regression check.
 *
 * Why this exists: localization is spread across three layers that can only agree
 * by convention — the schemas in `@hamolus/types`, the `core.config.ts` floor in
 * `packages/core/src/config.ts`, and the record schema both the dynamic routes and
 * the panels build from `effectiveLocaleCodes(settings)`. Nothing in the type
 * checker ties them together, so the failure modes are silent and data-losing:
 *
 *   - a merge that starts blending per locale instead of replacing, so an operator
 *     removes a locale in settings and the stale one from the file comes back;
 *   - `defaultLocale` quietly falling back to the first locale when it is not among
 *     the declared ones, preselecting a language nobody declared;
 *   - the empty-locale case regressing into "reject plain strings", which would
 *     start failing every existing write on a project that never opted into locales.
 *
 * All three are pinned below, against the real modules — `packages/core/src/config.ts`
 * is imported as source, the type-level contracts through the built `@hamolus/types`
 * (whose freshness is asserted first, so this can never silently test a stale dist).
 *
 *   pnpm -F @hamolus/core check:localization
 *
 * Fully offline: no server, no network, no shared state. The only writes are a
 * temp directory inside this package (so the template copies resolve
 * `@hamolus/types` through this package's node_modules), removed in `finally`.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildEntitySchema,
  defineConsoleConfig,
  defineCoreConfig,
  fieldValueSchema,
  localeCodes,
  localeLabel,
  mergeLocalization,
  resolveLocalization,
} from '@hamolus/types'
import {
  effectiveLocaleCodes,
  effectiveLocalization,
  getCoreConfig,
  setCoreConfig,
} from '../src/config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '..', '..')
const TMP = join(PKG, '.check-localization')

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
/** Assert a call throws, and hand the error to `check` for a message assertion. */
const throws = (fn) => {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}
const codes = (value) => JSON.stringify(localeCodes(value))
const codesOf = (input) => codes(resolveLocalization(input))

// --- 0. The built types must not be older than their source ---------------------
// A stale `dist` would make every assertion below describe yesterday's contract.
{
  const dist = join(REPO, 'packages', 'types', 'dist', 'index.js')
  const srcDir = join(REPO, 'packages', 'types', 'src')
  let newest = 0
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const path = join(srcDir, entry.name)
    newest = Math.max(newest, statSync(path).mtimeMs)
  }
  const built = statSync(dist).mtimeMs
  ok(
    'the built @hamolus/types is newer than its source (run: pnpm -F @hamolus/types build)',
    built >= newest,
    `dist ${new Date(built).toISOString()} vs src ${new Date(newest).toISOString()}`,
  )
}

// --- 1. resolveLocalization: both shapes normalize to one result ---------------
{
  const legacy = resolveLocalization({ languages: ['en', 'id'] })
  ok('legacy { languages } resolves', codes(legacy) === '["en","id"]', codes(legacy))
  ok('legacy default falls back to the first code', legacy?.defaultLocale === 'en', legacy?.defaultLocale)
  ok('two locales report multilingual', legacy?.multilingual === true)
  ok('one locale is not multilingual', resolveLocalization({ languages: ['en'] })?.multilingual === false)

  const legacyNamed = resolveLocalization({ languages: ['en', 'id'], defaultLocale: 'id' })
  ok('legacy honours an explicit defaultLocale', legacyNamed?.defaultLocale === 'id', legacyNamed?.defaultLocale)
  const legacyUnknown = resolveLocalization({ languages: ['en', 'id'], defaultLocale: 'fr' })
  ok(
    'legacy ignores a defaultLocale that was not declared',
    legacyUnknown?.defaultLocale === 'en',
    legacyUnknown?.defaultLocale,
  )

  const modern = resolveLocalization({
    defaultLocale: 'id',
    locales: [{ code: 'en', label: 'English' }, { code: 'id', label: 'Bahasa Indonesia' }],
  })
  ok('the locales shape resolves', codes(modern) === '["en","id"]', codes(modern))
  ok('labels survive normalization', localeLabel(modern, 'id') === 'Bahasa Indonesia')
  ok('direction survives normalization', resolveLocalization({ locales: [{ code: 'ar', direction: 'rtl' }] })?.locales[0]?.direction === 'rtl')
  ok('the locales shape honours defaultLocale', modern?.defaultLocale === 'id', modern?.defaultLocale)
  ok(
    'a defaultLocale outside the list falls back to the first',
    resolveLocalization({ defaultLocale: 'fr', locales: [{ code: 'en' }, { code: 'id' }] })?.defaultLocale === 'en',
  )

  const dupes = resolveLocalization({
    defaultLocale: 'en',
    locales: [{ code: 'en', label: 'First' }, { code: 'en', label: 'Second' }, { code: 'id' }],
  })
  ok('a duplicated code collapses to one entry', codes(dupes) === '["en","id"]', codes(dupes))
  ok('the first definition of a duplicated code wins', localeLabel(dupes, 'en') === 'First')

  // "Not configured" has to be distinguishable from "configured", or a project
  // that never declared locales inherits an empty switcher and rejected writes.
  ok('a bad code is not configuration', resolveLocalization({ locales: [{ code: 'EN' }] }) === undefined)
  ok('an empty locale list is not configuration', resolveLocalization({ locales: [] }) === undefined)
  ok('a non-object is not configuration', resolveLocalization('en') === undefined)
  ok('null settings are not configuration', resolveLocalization(null) === undefined)
  ok('an object without locales/languages is not configuration', resolveLocalization({ site: {} }) === undefined)
  ok('an all-invalid legacy list is not configuration', resolveLocalization({ languages: ['EN', '!!'] }) === undefined)
  ok('localeCodes of nothing is an empty list', codesOf(null).toString() === codesOf(undefined))
}

// --- 2. mergeLocalization: settings replace the file, they never blend ----------
{
  const base = resolveLocalization({ defaultLocale: 'en', locales: [{ code: 'en' }, { code: 'id' }] })
  const settings = resolveLocalization({ defaultLocale: 'id', locales: [{ code: 'id' }, { code: 'fr' }] })

  const merged = mergeLocalization(base, { defaultLocale: 'id', locales: [{ code: 'id' }, { code: 'fr' }] })
  ok('settings replace the file list outright', codes(merged) === '["id","fr"]', codes(merged))
  ok(
    'a locale removed in settings does not come back from the file',
    !codes(merged).includes('en'),
    codes(merged),
  )
  ok('settings replace the default locale', merged?.defaultLocale === 'id', merged?.defaultLocale)
  ok('absent settings keep the file config', mergeLocalization(base, undefined) === base)
  ok('absent settings (null) keep the file config', mergeLocalization(base, null) === base)
  ok(
    'invalid settings fall back to the file config',
    mergeLocalization(base, { locales: [{ code: 'EN' }] }) === base,
  )
  ok('nothing configured anywhere is undefined', mergeLocalization(undefined, undefined) === undefined)
  ok('settings alone work with no file config', codes(mergeLocalization(undefined, settings)) === '["id","fr"]')
}

// --- 3. defineCoreConfig / defineConsoleConfig: fail loudly, name the file -----
{
  const config = defineCoreConfig({
    localization: { defaultLocale: 'en', locales: [{ code: 'en' }, { code: 'id', label: 'Bahasa' }] },
  })
  ok('a valid core config is returned', codesOf(config.localization) === '["en","id"]')

  const empty = defineCoreConfig({})
  ok('an empty core config is valid', empty.localization === undefined)

  const strict = throws(() => defineCoreConfig({ localization: {}, site: { name: 'x' } }))
  ok('an unknown core config key is rejected', strict !== null, 'no error thrown')
  ok('the error names core.config.ts', /core\.config\.ts/.test(String(strict)), String(strict))
  ok('the error names the offending key', /site/.test(String(strict)), String(strict))

  const mismatch = throws(() =>
    defineCoreConfig({ localization: { defaultLocale: 'fr', locales: [{ code: 'en' }] } }),
  )
  ok(
    'defaultLocale must be one of the declared locales',
    mismatch !== null && /defaultLocale/.test(String(mismatch)),
    String(mismatch),
  )
  ok('an empty locales array is rejected', throws(() => defineCoreConfig({ localization: { defaultLocale: 'en', locales: [] } })) !== null)

  // The console config is host-level only: localization lives in the core, so the
  // old keys must now be rejected loudly rather than accepted and ignored.
  // `plugins` carries a schema default, so an empty host config is valid *and*
  // resolves to a complete config — "no plugins", not "no keys".
  const consoleEmpty = defineConsoleConfig({})
  ok('an empty console config is valid', Array.isArray(consoleEmpty.plugins) && consoleEmpty.plugins.length === 0, JSON.stringify(consoleEmpty))
  for (const key of ['localization', 'defaultLocale']) {
    const legacy = throws(() =>
      defineConsoleConfig({ [key]: { defaultLocale: 'en', locales: [{ code: 'en' }] } }),
    )
    ok(`a console config no longer accepts \`${key}\``, legacy !== null, 'no error thrown')
    ok(
      `the \`${key}\` error names console.config.ts`,
      /console\.config\.ts/.test(String(legacy)),
      String(legacy),
    )
    ok(`the \`${key}\` error names the offending key`, new RegExp(key).test(String(legacy)), String(legacy))
  }
  const consoleStrict = throws(() => defineConsoleConfig({ endpoints: [] }))
  ok('an unknown console config key is rejected', consoleStrict !== null)
  ok('the error names console.config.ts', /console\.config\.ts/.test(String(consoleStrict)), String(consoleStrict))
}

// --- 4. The core floor: core.config.ts, overridden by settings ------------------
{
  setCoreConfig({})
  ok('with nothing configured, localization is undefined', effectiveLocalization(null) === undefined)
  ok('with nothing configured, no locale codes are enforced', effectiveLocaleCodes(null).length === 0)

  setCoreConfig({
    localization: { defaultLocale: 'en', locales: [{ code: 'en' }, { code: 'id', label: 'Bahasa Indonesia' }] },
  })
  ok('getCoreConfig reflects what was set', codesOf(getCoreConfig().localization) === '["en","id"]')
  ok(
    'the file config applies while settings say nothing',
    codes(effectiveLocalization(null)) === '["en","id"]',
    codes(effectiveLocalization(null)),
  )
  ok(
    'the file config applies when settings have no localization block',
    codes(effectiveLocalization({ site: { name: 'Demo' } })) === '["en","id"]',
  )
  ok(
    'valid settings localization wins over the file',
    codes(effectiveLocalization({ localization: { defaultLocale: 'id', locales: [{ code: 'id' }, { code: 'fr' }] } })) === '["id","fr"]',
    codes(effectiveLocalization({ localization: { defaultLocale: 'id', locales: [{ code: 'id' }, { code: 'fr' }] } })),
  )
  ok(
    'an operator can therefore drop a locale without a redeploy',
    !codes(effectiveLocalization({ localization: { defaultLocale: 'en', locales: [{ code: 'en' }] } })).includes('id'),
  )
  ok(
    'unusable settings localization fall back to the file config',
    codes(effectiveLocalization({ localization: { locales: 'nope' } })) === '["en","id"]',
    codes(effectiveLocalization({ localization: { locales: 'nope' } })),
  )
  ok('effectiveLocaleCodes mirrors effectiveLocalization', effectiveLocaleCodes({ localization: { defaultLocale: 'en', locales: [{ code: 'en' }] } }).toString() === 'en')
  setCoreConfig({})
}

// --- 5. Localized record validation, driven by those effective codes -----------
{
  const localizedString = { name: 'title', type: 'string', localized: true }
  const plain = fieldValueSchema(localizedString, ['en', 'id'])

  const full = plain.safeParse({ en: 'Hello', id: 'Halo' })
  ok('a value for every declared locale is accepted', full.success, JSON.stringify(full.error?.issues))
  const partial = plain.safeParse({ en: 'Hello' })
  ok('a missing declared locale is rejected', !partial.success)
  ok(
    'the rejection points at the missing locale',
    partial.success === false && partial.error.issues[0]?.path[0] === 'id',
    JSON.stringify(partial.error?.issues),
  )
  const extra = plain.safeParse({ en: 'Hello', id: 'Halo', fr: 'Bonjour' })
  ok('an undeclared locale key is ignored, not stored', extra.success && extra.data.fr === undefined, JSON.stringify(extra.data))
  ok('a plain string is rejected once locales are configured', !plain.safeParse('Hello').success)
  ok('a wrong per-locale type is rejected', !plain.safeParse({ en: 'Hello', id: 42 }).success)
  ok('a number is still rejected for a string field', !plain.safeParse({ en: 1, id: 2 }).success)

  // The regression that would break every existing write on a project that never
  // opted into locales.
  ok('an empty locale list accepts a plain string', fieldValueSchema(localizedString, []).safeParse('Hello').success)
  ok('an undefined locale list accepts a plain string', fieldValueSchema(localizedString, undefined).safeParse('Hello').success)
  ok('an empty locale list still enforces the field type', !fieldValueSchema(localizedString, []).safeParse(42).success)
  ok(
    'a required localized field accepts a plain string when no locale is configured',
    fieldValueSchema({ ...localizedString, required: true }, []).safeParse('Hello').success,
  )
  ok(
    'a required localized field demands an object once locales are configured',
    !fieldValueSchema({ ...localizedString, required: true }, ['en']).safeParse('Hello').success,
  )
  ok('a field with a default is optional even when localized', fieldValueSchema({ ...localizedString, default: 'x' }, ['en']).safeParse(undefined).success)

  const lex = { root: { type: 'root', children: [] } }
  const localizedRich = { name: 'body', type: 'richtext', localized: true }
  ok(
    'localized rich text accepts a Lexical document per locale',
    fieldValueSchema(localizedRich, ['en', 'id']).safeParse({ en: lex, id: lex }).success,
  )
  // A richtext value is deliberately a union: a markdown/HTML source string is a
  // legitimate stored value, not a half-built Lexical document.
  ok(
    'localized rich text accepts a source string per locale',
    fieldValueSchema(localizedRich, ['en', 'id']).safeParse({ en: '<p>hi</p>', id: '<p>hai</p>' }).success,
  )
  ok(
    'localized rich text rejects a value of the wrong shape per locale',
    !fieldValueSchema(localizedRich, ['en']).safeParse({ en: { nope: true } }).success,
  )
  ok('rich text accepts a Lexical document when no locale is configured', fieldValueSchema(localizedRich, []).safeParse(lex).success)

  ok(
    'a non-localized field is unaffected by the locale list',
    fieldValueSchema({ name: 'slug', type: 'slug', localized: false }, ['en', 'id']).safeParse('a-slug').success,
  )
  ok('slug rules still apply alongside locales', !fieldValueSchema({ name: 'slug', type: 'slug', localized: true }, ['en']).safeParse({ en: 'Not A Slug' }).success)

  const entity = buildEntitySchema(
    { primaryKey: 'id', fields: [localizedString, { name: 'views', type: 'number' }] },
    ['en', 'id'],
  )
  ok('a valid record parses', entity.safeParse({ views: 1, title: { en: 'Hi', id: 'Halo' } }).success)
  ok(
    'an unknown field is rejected (injection guard)',
    !entity.safeParse({ views: 1, title: { en: 'Hi', id: 'Halo' }, bogus: 1 }).success,
  )
}

// --- 6. The shipped templates must satisfy the contract they document ----------
{
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const templates = [
    ['cores/basic/core.config.ts', 'core.config.ts'],
    ['consoles/basic/console.config.ts', 'console.config.ts'],
  ]
  for (const [from, to] of templates) {
    const src = join(REPO, 'templates', from)
    try {
      cpSync(src, join(TMP, to))
    } catch (error) {
      ok(`templates/${from} exists`, false, String(error))
    }
  }
  try {
    const mod = await import(join(TMP, 'core.config.ts'))
    const declared = resolveLocalization(mod.config.localization)
    ok(
      'the generated core.config.ts declares a valid localization',
      declared !== undefined && declared.locales.length > 0,
      JSON.stringify(declared),
    )
    ok(
      'the generated core.config.ts defaultLocale is declared',
      declared?.locales.some((locale) => locale.code === declared?.defaultLocale) === true,
      JSON.stringify(declared),
    )

    const consoleMod = await import(join(TMP, 'console.config.ts'))
    const consoleConfig = consoleMod.config
    ok(
      'the generated console.config.ts still validates',
      consoleConfig !== null && typeof consoleConfig === 'object',
      JSON.stringify(consoleConfig),
    )
    ok(
      'the generated console.config.ts carries no localization',
      consoleConfig.localization === undefined && consoleConfig.defaultLocale === undefined,
      JSON.stringify(consoleConfig),
    )
    // The template's prose is the contract: it must tell the reader where
    // localization went, or someone will add the key back.
    const templateSrc = readFileSync(join(REPO, 'templates/consoles/basic/console.config.ts'), 'utf8')
    ok(
      'the generated console.config.ts points localization at the core',
      /core\.config\.ts/.test(templateSrc) && /_meta\/localization/.test(templateSrc),
    )
  } finally {
    rmSync(TMP, { recursive: true, force: true })
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
