import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(fs.readFileSync('src/analytics.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace('export function', 'function').replaceAll('import.meta.env.PROD', 'production')

function browser({ production = true, origin = 'https://fluidlab.fly.dev', choice = null, dnt = '0', gpc = false, blockedStorage = false } = {}) {
  const elements = []
  const cookies = []
  const storage = new Map(choice ? [['fluidlab.analytics-consent.v1', choice]] : [])
  const createElement = tag => {
    const node = { tag, children: [], setAttribute() {}, append(...nodes) { this.children.push(...nodes) } }
    elements.push(node)
    return node
  }
  const document = {
    head: createElement('head'), body: createElement('body'), createElement,
    getElementById: id => elements.find(el => el.id === id),
    get cookie() { return '_ga=secret; _ga_PDC9Z8T1LC=secret; rig=keep' },
    set cookie(value) { cookies.push(value) },
  }
  const context = vm.createContext({ production, document, location: {origin}, window: {}, navigator: {doNotTrack:dnt,globalPrivacyControl:gpc},
    localStorage: { getItem: k => { if (blockedStorage) throw Error(); return storage.get(k) ?? null }, setItem: (k,v) => { if (blockedStorage) throw Error(); storage.set(k,v) } } })
  vm.runInContext(source + '\ninitAnalytics()', context)
  const click = text => elements.find(el => el.textContent === text).onclick()
  const scripts = () => document.head.children.filter(el => el.tag === 'script')
  const events = () => (context.window.dataLayer ?? []).map(args => Array.from(args))
  return { context, document, elements, cookies, storage, click, scripts, events }
}
for (const options of [{production:false},{origin:'http://localhost:5173'},{origin:'https://preview.example'}]) {
  const b = browser(options); assert.equal(b.elements.length,2); assert.equal(b.scripts().length,0)
}
const b=browser(); assert.equal(b.scripts().length,0)
b.click('Decline'); assert.equal(b.scripts().length,0)
b.click('Allow analytics'); assert.equal(b.scripts().length,1)
assert.equal(b.events().filter(e=>e[0]==='event'&&e[1]==='page_view').length,1)
const config = b.events().find(e=>e[0]==='config')[2]
assert.equal(config.send_page_view,false)
const fields=b.events().find(e=>e[0]==='set')[1]
assert.equal(fields.page_location,'https://fluidlab.fly.dev/')
assert.equal(fields.page_referrer,''); assert.equal(fields.page_title,'FluidLab')
assert.equal(fields.allow_google_signals,false)
b.click('Allow analytics'); vm.runInContext('initAnalytics()',b.context)
assert.equal(b.scripts().length,1)
assert.equal(b.events().filter(e=>e[0]==='event').length,1)
b.click('Decline'); assert.equal(b.context.window['ga-disable-G-PDC9Z8T1LC'],true)
assert.equal(b.cookies.length,12); assert.ok(b.cookies.every(c=>c.startsWith('_ga')))
b.click('Allow analytics'); assert.equal(b.context.window['ga-disable-G-PDC9Z8T1LC'],false)
for(const options of [{dnt:'1',choice:'granted'},{gpc:true,choice:'granted'}]) {
  const p=browser(options);p.click('Allow analytics');assert.equal(p.scripts().length,0)
}
assert.equal(browser({choice:'granted'}).scripts().length,1)
assert.equal(browser({choice:'denied'}).scripts().length,0)
const p=browser({blockedStorage:true});p.click('Allow analytics');assert.equal(p.scripts().length,1)
console.log('Analytics checks passed: production gate, consent, privacy fields, duplicates, withdrawal, browser opt-out, blocked storage.')
