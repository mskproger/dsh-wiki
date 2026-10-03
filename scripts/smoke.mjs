// Smoke test for dsh-wiki pure helpers: prompt building and JSON parsing.
import { isIgnored, parseWriterResponse, slugify, renderDiff, buildWriterUserPrompt, buildWriterSystemPrompt, sanitizeFolder, projectNameOf } from '../host/wiki.js'
import assert from 'node:assert'

// slugify
assert.strictEqual(slugify('Плагин dsh-wiki: замысел'), 'Плагин dsh-wiki- замысел')
assert.strictEqual(slugify('..'), 'page') // безопасный fallback, не '..'
assert.strictEqual(slugify('../etc/passwd'), '-etc-passwd')
assert.ok(!slugify('a/b\\c').includes('/') && !slugify('a/b\\c').includes('\\'))

// ignore matching
const patterns = ['wiki/**', '**/wiki/**', '*.log', 'package-lock.json', 'pnpm-lock.yaml', '.obsidian/**', '.git/**']
assert.ok(isIgnored('wiki/Home.md', patterns))
assert.ok(isIgnored('sub/dir/wiki/x.md', patterns))
assert.ok(isIgnored('debug.log', patterns))
assert.ok(isIgnored('package-lock.json', patterns))
assert.ok(isIgnored('.obsidian/workspace.json', patterns))
assert.ok(isIgnored('.git/config', patterns))
assert.ok(!isIgnored('src/main.js', patterns))
assert.ok(!isIgnored('README.md', patterns))
assert.ok(!isIgnored('wiki-page.md', patterns)) // не начинается с wiki/

// renderDiff
const d = renderDiff({ kind: 'text', display: 'src/a.js', before: true, after: true, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] })
assert.ok(d.includes('--- src/a.js') && d.includes('@@ -1,2 +1,1 @@') && d.includes('-old') && d.includes('+new'))
assert.strictEqual(renderDiff({ kind: 'oversized', display: 'big.bin' }), '[oversized]')

// parseWriterResponse
const good = parseWriterResponse('```json\n{"skip":false,"pageFile":"Плагин","pageTitle":"Плагин","pageContent":"# X","homeContent":"# Home"}\n```')
assert.strictEqual(good.skip, false)
assert.strictEqual(good.pageFile, 'Плагин')
assert.strictEqual(good.pageContent, '# X')
const skip = parseWriterResponse('{ "skip": true, "reason": "логи" }')
assert.strictEqual(skip.skip, true)
assert.strictEqual(skip.reason, 'логи')
assert.strictEqual(parseWriterResponse('no json here'), null)
assert.strictEqual(parseWriterResponse('```json\n{"skip":false,"pageFile":"","pageContent":"","homeContent":""}\n```'), null)

// prompt builders
const prefs = { wikiFolder: 'wiki', language: 'ru', ignorePatterns: [] }
const sys = buildWriterSystemPrompt(prefs)
assert.ok(sys.includes('```json') && sys.includes('skip'))
const user = buildWriterUserPrompt({ projectName: 'demo', cwd: 'C:/demo', diffs: ['--- x'], files: [{ display: 'x.md', added: 2, deleted: 0 }], homeText: '# Home', pages: ['A'], wikiFolder: 'wiki' })
assert.ok(user.includes('Project: demo') && user.includes('- x.md (+2/-0)') && user.includes('```diff') && user.includes('A'))

// sanitize / project name
assert.strictEqual(sanitizeFolder('a/../../b'), 'a/b'.replace(/\//g, '/'))
assert.strictEqual(projectNameOf('C:\\work\\мой проект'), 'мой проект')

console.log('smoke OK')
