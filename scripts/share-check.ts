// Shareable links: every experiment must survive the trip through a URL unchanged, and stay a sensible length.
import { EXPERIMENTS } from '../src/experiments'
import { decodeRig, encodeRig, rigInHash, shareUrl } from '../src/share'

let worst = { id: '', length: 0 }
let failed = 0
for (const ex of EXPERIMENTS) {
  const { nodes, edges } = ex.build()
  const json = JSON.stringify({ app: 'FluidLab', version: 1, name: ex.title, fluidId: ex.fluidId ?? 'water20', nodes, edges }, null, 2)
  const url = await shareUrl(json, 'https://fluidlab.fly.dev/')
  const back = await decodeRig(rigInHash(new URL(url).hash)!)
  if (JSON.stringify(JSON.parse(back)) !== JSON.stringify(JSON.parse(json))) {
    failed++
    console.log(`✗ ${ex.id}: did not come back the same`)
  }
  if (url.length > worst.length) worst = { id: ex.id, length: url.length }
}
const plain = await decodeRig(`j${Buffer.from('{"nodes":[],"edges":[]}').toString('base64url')}`)
if (plain !== '{"nodes":[],"edges":[]}') (failed++, console.log('✗ uncompressed fallback'))
let rejected = false
await decodeRig('zAAAA').catch(() => (rejected = true))
if (!rejected) (failed++, console.log('✗ a corrupt link must be rejected'))
console.log(`${EXPERIMENTS.length} rigs round-tripped · longest link ${worst.length} characters (${worst.id})`)
if (failed || worst.length > 8000) {
  console.error('share checks failed')
  process.exit(1)
}
console.log('share checks passed')
