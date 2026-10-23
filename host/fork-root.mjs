// Where the IeumOffice checkout is. In this repository the fork is the `ieumoffice/`
// submodule; a checkout beside this folder (`../ieumoffice`) or this folder living inside
// the fork also work. IEUM_FORK_ROOT overrides all of them. The fork's sources are
// imported as `@ieum/…` (build.mjs maps that prefix here).
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// a usable checkout has its dependencies installed (the runtime image keeps only
// package.json, part of packages/ and node_modules)
const isFork = (dir) => ['package.json', 'packages', 'node_modules'].every((p) => existsSync(resolve(dir, p)))

/** @param {string} web this folder (the one holding host/) */
export function findForkRoot(web) {
  const tried = [
    process.env.IEUM_FORK_ROOT,
    resolve(web, 'ieumoffice'),
    resolve(web, '../ieumoffice'),
    resolve(web, '..'),
  ].filter(Boolean)
  const root = tried.find(isFork)
  if (!root) {
    throw new Error(
      `IeumOffice checkout not found (tried ${tried.join(', ')}): ` +
        'run `git submodule update --init` and `npm ci` in ieumoffice/, or set IEUM_FORK_ROOT',
    )
  }
  return root
}
