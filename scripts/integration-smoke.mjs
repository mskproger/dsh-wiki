// Integration smoke for dsh-wiki: runs the real apply() against a mocked
// harness context and checks the full cycle — Home.md creation + injection,
// and an auto-update after a turn ends.
import { mkdtemp, writeFile, readFile, mkdir, readdir, stat as statFs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as pathResolve } from 'node:path'
import assert from 'node:assert'
import { apply } from '../host/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeFs() {
  return {
    async resolve(p, opts) {
      const full = pathResolve(opts.cwd ?? process.cwd(), p)
      return { targetKey: full, displayPath: full }
    },
    async stat(target) {
      try {
        const s = await statFs(target.targetKey)
        return { version: `${s.mtimeMs}:${s.size}`, type: 'file', size: s.size }
      } catch (e) {
        if (e.code === 'ENOENT') return undefined
        throw e
      }
    },
    async readText(target) {
      try {
        return await readFile(target.targetKey, 'utf8')
      } catch (e) {
        if (e.code === 'ENOENT') {
          const err = new Error(`not found: ${target.displayPath}`)
          err.code = 'FS_NOT_FOUND'
          throw err
        }
        throw e
      }
    },
    async writeText(target, content, expected) {
      const targetKey = target.targetKey
      await mkdir(join(targetKey, '..'), { recursive: true }) // как fs-local: mkdir -p
      let existing = null
      try { existing = await readFile(targetKey, 'utf8') } catch { /* absent */ }
      if (expected?.kind === 'createIfAbsent' && existing !== null) {
        const err = new Error('exists'); err.code = 'FS_NOT_OBSERVED'; throw err
      }
      await writeFile(targetKey, content, 'utf8')
      return { operation: existing === null ? 'create' : 'update', version: 'v' }
    },
    async listDir(target) {
      const entries = await readdir(target.targetKey, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
    },
  }
}

function makeLlm(jsonText) {
  return {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: '```json\n' }
      yield { type: 'text-delta', index: 0, text: jsonText }
      yield { type: 'text-delta', index: 0, text: '\n```' }
      yield { type: 'finish', kind: 'success' }
    },
  }
}

function makeCtx({ fs, llm, workspaceChanges, injected }) {
  const listeners = new Map()
  const systemPrompt = {
    __sections: [],
    section: (s) => systemPrompt.__sections.push(s),
  }
  const services = {
    fs,
    llm,
    workspaceChanges,
    systemPrompt,
    agents: { list: () => [] },
  }
  const ctx = {
    get: (name) => services[name],
    on: (event, fn) => listeners.set(event, fn),
    listeners,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  injected ??= []
  ctx.injected = injected
  return ctx
}

function fakeAgent(cwd, sessionId, ctx) {
  return {
    session: {
      id: sessionId,
      header: { cwd, origin: 'app' },
      requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }),
    },
    inject: (msg) => ctx.injected.push(msg),
  }
}

const workspace = await mkdtemp(join(tmpdir(), 'dsh-wiki-smoke-'))
await mkdir(join(workspace, 'src'), { recursive: true })
await writeFile(join(workspace, 'src', 'a.js'), 'console.log(1)\n', 'utf8')

const summary = {
  files: [
    { path: 'src/a.js', display: 'src/a.js', added: 1, deleted: 1 },
    { path: 'debug.log', display: 'debug.log', added: 1, deleted: 0 },
  ],
  total: 2,
}
const workspaceChanges = {
  summary: () => summary,
  diff: async (_sid, _seq, index) => index === 0
    ? { kind: 'text', path: 'src/a.js', display: 'src/a.js', before: true, after: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-console.log(1)', '+console.log(42)'] }] }
    : { kind: 'text', path: 'debug.log', display: 'debug.log', before: true, after: true, hunks: [] },
}

const json = JSON.stringify({
  skip: false,
  pageFile: 'Тест-страница',
  pageTitle: 'Тест-страница',
  pageContent: '# Тест-страница\n\n← [[Home]]\n\nТело страницы.\n\n## См. также\n',
  homeContent: '# Home — smoke\n\n## Страницы\n\n- [[Тест-страница]]\n\n## См. также\n',
})

const ctx = makeCtx({ fs: makeFs(), llm: makeLlm(json), workspaceChanges, injected: [] })
// Real loader shape: volatile Config fields arrive as cosmokit refs —
// `{ get(), [Symbol()]: set }`, so only `get` is detectable.
const volatile = (value) => ({ get: () => value, [Symbol('write')]: (v) => { value = v } })
apply(ctx, { delayMs: volatile(50), timeoutMs: volatile(5000), wikiFolder: volatile('wiki'), language: volatile('ru'), ignorePatterns: volatile(['wiki/**', '*.log']) })

// 1) agent/created: Home.md created + injected
const created = ctx.listeners.get('agent/created')
assert.ok(created, 'agent/created listener registered')
await created({ agent: fakeAgent(workspace, 'session-1', ctx) })
const homeAfterCreated = await readFile(join(workspace, 'wiki', 'Home.md'), 'utf8')
assert.ok(homeAfterCreated.includes('# Home —'), 'Home.md skeleton created')
assert.strictEqual(ctx.injected.length, 1, 'Home.md injected')
assert.ok(ctx.injected[0].content[0].text.includes('wiki/Home.md'), 'inject text references Home.md')

// 2) agent/turn-stopping: auto-update
const stopping = ctx.listeners.get('agent/turn-stopping')
assert.ok(stopping, 'agent/turn-stopping listener registered')
stopping({ agent: fakeAgent(workspace, 'session-1', ctx), turn: 1 })
await sleep(800)

const pages = await readdir(join(workspace, 'wiki'))
assert.ok(pages.includes('Тест-страница.md'), `page written (got: ${pages.join(', ')})`)
const pageText = await readFile(join(workspace, 'wiki', 'Тест-страница.md'), 'utf8')
assert.ok(pageText.includes('Тело страницы'), 'page content written')
const homeAfterTurn = await readFile(join(workspace, 'wiki', 'Home.md'), 'utf8')
assert.ok(homeAfterTurn.includes('[[Тест-страница]]'), 'Home.md updated with the link')

// 3) system prompt section registered (text is a live function)
assert.strictEqual(ctx.get('systemPrompt').__sections.length, 1, 'system prompt section registered')
assert.strictEqual(typeof ctx.get('systemPrompt').__sections[0].text, 'function', 'section text is a function')
assert.ok(ctx.get('systemPrompt').__sections[0].text().includes('wiki'), 'section mentions wiki')

console.log('integration smoke OK — workspace:', workspace)
