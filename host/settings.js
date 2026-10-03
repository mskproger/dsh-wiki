/**
 * Settings schema for dsh-wiki.
 *
 * On hosts 0.1.7+ the settings form is derived from the profile entry's
 * Config and shows the fields marked `.volatile()`. Older hosts take the
 * schema through the imperative settings registry — the same defensive
 * resolution pattern the dsh-claude-style family uses.
 */
import { createRequire } from 'node:module'

/** Defaults; the browser half of a settings form and this host half share them. */
const PREFS_DEFAULT = Object.freeze({
  /** Wiki folder name inside each workspace root. */
  wikiFolder: 'wiki',
  /** Auto-update the wiki after a completed task. */
  autoUpdate: true,
  /** Inject wiki/Home.md into each session's context on start. */
  injectHome: true,
  /** Also inject Home.md into subagent sessions. */
  injectSubagents: false,
  /** Language of generated wiki pages ('ru' | 'en'). */
  language: 'ru',
  /** Provider for the wiki writer; empty = inherit from the session. */
  provider: '',
  /** Model for the wiki writer; empty = inherit from the session. */
  model: '',
  /** Max tokens for one wiki-writer model call. */
  maxTokens: 8000,
  /** Total bytes of file diffs fed into the writer prompt. */
  maxDiffBytes: 12000,
  /** Max changed files whose diffs are fed into the writer prompt. */
  maxChangedFiles: 30,
  /** Delay before the wiki writer starts after a turn ends. */
  delayMs: 4000,
  /** Timeout of one wiki-writer model call. */
  timeoutMs: 180000,
  /** Order of the dsh-wiki system-prompt section. */
  systemPromptOrder: 20000,
  /** Changed files matching these patterns are ignored (simple globs). */
  ignorePatterns: [
    'wiki/**',
    '**/wiki/**',
    '*.log',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    '.obsidian/**',
    '.git/**',
  ],
})

async function resolveSchemaFactory() {
  try {
    const anchor = typeof process.argv[1] === 'string' && process.argv[1] !== '' ? process.argv[1] : process.execPath
    const factory = createRequire(anchor)('@deepseek-ai/schemastery')
    if (factory !== null && factory !== undefined && typeof factory.object === 'function') return factory
  } catch { /* the anchor carries no schemastery: try normal resolution */ }
  try {
    const module = await import('@deepseek-ai/schemastery')
    return module?.default ?? module?.Schema ?? null
  } catch {
    return null
  }
}

let SchemaFactory = await resolveSchemaFactory()

/** Mark one field editable by the settings page, where the factory supports it. */
function volatileField(field) {
  return typeof field?.volatile === 'function' ? field.volatile() : field
}

export const Config = SchemaFactory === null
  ? undefined
  : SchemaFactory.object({
      wikiFolder: volatileField(SchemaFactory.string().default(PREFS_DEFAULT.wikiFolder)),
      autoUpdate: volatileField(SchemaFactory.boolean().default(PREFS_DEFAULT.autoUpdate)),
      injectHome: volatileField(SchemaFactory.boolean().default(PREFS_DEFAULT.injectHome)),
      injectSubagents: volatileField(SchemaFactory.boolean().default(PREFS_DEFAULT.injectSubagents)),
      language: volatileField(SchemaFactory.string().default(PREFS_DEFAULT.language)),
      provider: volatileField(SchemaFactory.string().default(PREFS_DEFAULT.provider)),
      model: volatileField(SchemaFactory.string().default(PREFS_DEFAULT.model)),
      maxTokens: volatileField(SchemaFactory.number().default(PREFS_DEFAULT.maxTokens)),
      maxDiffBytes: volatileField(SchemaFactory.number().default(PREFS_DEFAULT.maxDiffBytes)),
      maxChangedFiles: volatileField(SchemaFactory.number().default(PREFS_DEFAULT.maxChangedFiles)),
      delayMs: volatileField(SchemaFactory.number().default(PREFS_DEFAULT.delayMs)),
      timeoutMs: volatileField(SchemaFactory.number().default(PREFS_DEFAULT.timeoutMs)),
      systemPromptOrder: volatileField(SchemaFactory.number().default(PREFS_DEFAULT.systemPromptOrder)),
      ignorePatterns: volatileField(SchemaFactory.array(SchemaFactory.string()).default([...PREFS_DEFAULT.ignorePatterns])),
    })

export const DEFAULTS = PREFS_DEFAULT
