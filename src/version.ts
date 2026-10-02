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
 * The version this core reports.
 *
 * A constant rather than a build-time injection, for two reasons. A generated core
 * ships raw TypeScript (`main` points at `src/index.ts`), so there is no bundler step
 * that could stamp a value into it — the only place a version can live is a line of
 * source a human edits. And an operator needs the answer at *runtime*, not at build
 * time: `pnpm check:package-versions` cannot see a deployed worker, so a core that is
 * two releases behind its console is only discoverable if the running worker says so.
 *
 * It is deliberately a literal and not a read of `package.json`. The package manifest
 * is not shipped inside the Worker bundle, and `wrangler deploy` compiles from `src/`.
 *
 * Load-bearing: `scripts/release.mjs` rewrites this line on every bump, and
 * `packages/cli/scripts/check-package-versions.mjs` fails the build when it does not
 * match the lockstep version. Both exist because a mismatch here is silent — the core
 * keeps working perfectly while answering `/api/health` with last month's number, and
 * the console then shows an operator a version that does not match the behaviour they
 * are looking at.
 */
export const CORE_VERSION = '0.2.11'