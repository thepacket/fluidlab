// Writes public/licenses.txt: FluidLab's own licence, then the licence of everything that ends up in the bundle.
// The texts are copied from the installed packages, never retyped. Run with `npm run licenses` after changing
// dependencies; the file is served at /licenses.txt, so the notices travel with the built site as MIT and OFL ask.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const modules = join(root, 'node_modules')
const paths = execSync('npm ls --omit=dev --all --parseable', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((p) => p.includes('node_modules'))
  // type declarations are not part of the bundle
  .filter((p) => !/node_modules\/(@types\/|csstype$)/.test(p))

const seen = new Set()
const parts = []
for (const dir of paths.sort()) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const key = `${pkg.name}@${pkg.version}`
  if (seen.has(key)) continue
  seen.add(key)
  const file = readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f))
  if (!file) throw new Error(`${key} (${relative(modules, dir)}) ships no licence file — add its text by hand`)
  const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '')
  parts.push([`${pkg.name} ${pkg.version} — ${pkg.license}`, repo.replace(/^git\+/, '').replace(/\.git$/, ''), '', readFileSync(join(dir, file), 'utf8').trim()].join('\n'))
}

const rule = `\n\n${'='.repeat(100)}\n\n`
const own = readFileSync(join(root, 'LICENSE'), 'utf8').trim()
const epanet = [
  'EPANET 2.2 (Open Water Analytics) — MIT',
  'https://github.com/OpenWaterAnalytics/EPANET',
  '',
  'The hydraulic solver inside epanet-js is the OWA-EPANET 2.2 toolkit compiled to WebAssembly. It is released under',
  'the MIT licence (see LICENSE and AUTHORS in the repository above) and descends from EPANET, written at the',
  'U.S. Environmental Protection Agency and placed in the public domain.',
].join('\n')
const head = [
  'FluidLab — open-source notices',
  '',
  'FluidLab is distributed under the MIT licence, reproduced first below. The built site also contains the',
  `software and fonts listed after it (${parts.length} packages), each under its own licence.`,
].join('\n')

const out = join(root, 'public', 'licenses.txt')
if (!existsSync(join(root, 'public'))) throw new Error('public/ is missing')
writeFileSync(out, [head, `FluidLab\n\n${own}`, epanet, ...parts].join(rule) + '\n')
console.log(`${relative(root, out)}: FluidLab + EPANET + ${parts.length} packages`)
