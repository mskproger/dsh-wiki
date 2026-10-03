/**
 * dsh-wiki — auto-maintained wiki knowledge base for DeepSeek Harness.
 *
 * What it does:
 *
 *   1. System prompt. Registers a short "wiki rules" section so every agent
 *      knows the wiki lives in `<wikiFolder>/` and is maintained by this
 *      plugin — the section replaces the wiki methodology that used to sit in
 *      the global AGENTS.md.
 *
 *   2. Context injection. On `agent/created` it ensures `<wikiFolder>/Home.md`
 *      exists and injects it into the session as a sourced user message, so
 *      the index is visible without any @-import (DSH has none).
 *
 *   3. Auto-updating. On `agent/turn-stopping` of a top-level agent it queues
 *      a background job: collect the turn's changed files through the
 *      `workspaceChanges` service, feed a writer model call (the session's own
 *      provider/model by default), parse the returned JSON, and write the new
 *      or updated page plus Home.md through `ctx.fs`.
 *
 * Everything is defensive: a host without systemPrompt/fs/llm/workspaceChanges
 * services still loads the plugin — the matching feature simply stays off.
 */
import { randomUUID } from 'node:crypto'
import { Config, DEFAULTS } from './settings.js'
import {
  buildHomeSkeleton,
  buildInjectText,
  buildRulesText,
  buildWriterSystemPrompt,
  buildWriterUserPrompt,
  clampInt,
  isIgnored,
  parseWriterResponse,
  projectNameOf,
  renderDiff,
  sanitizeFolder,
  slugify,
} from './wiki.js'

export const name = 'dsh-wiki'
export { Config }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Serialize background jobs per key (one chain per workspace) so two turns
 * never write the wiki of the same project at once.
 */
function createQueue() {
  const chains = new Map()
  return {
    enqueue(key, task) {
      const prev = chains.get(key) ?? Promise.resolve()
      const run = prev.catch(() => {}).then(task)
      chains.set(key, run.catch(() => {}))
      return run
    },
  }
}

/** One scheduled wiki-update job. */
function scheduleJob(ctx, prefs, queue, job) {
  queue.enqueue(job.cwd, () => runJob(ctx, prefs, job)).catch((error) => {
    ctx.logger?.warn?.(`dsh-wiki: background job failed: ${error?.message ?? error}`)
  })
}

/** Whether any other agent is actively running in the same workspace. */
function isCwdBusy(ctx, cwd, excludeSessionId) {
  try {
    const agents = ctx.get('agents')
    if (!agents || typeof agents.list !== 'function') return false
    for (const agent of agents.list()) {
      if (agent?.session?.id === excludeSessionId) continue
      if (agent?.session?.header?.cwd !== cwd) continue
      const kind = agent?.phase?.kind
      if (kind !== undefined && kind !== 'idle') return true
    }
  } catch { /* never block the wiki on a broken registry */ }
  return false
}

async function runJob(ctx, prefs, job) {
  const folder = sanitizeFolder(prefs.wikiFolder)
  const delayMs = clampInt(prefs.delayMs, DEFAULTS.delayMs, 0, 300000)
  if (delayMs > 0) await sleep(delayMs)

  // Wait out a continued turn in the same workspace (steering, a follow-up
  // prompt, or another session) — writing a wiki page under an active turn
  // would race its file tools.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!isCwdBusy(ctx, job.cwd, job.sessionId)) break
    if (attempt === 3) {
      ctx.logger?.info?.(`dsh-wiki: workspace ${job.cwd} stays busy; skipping wiki update for turn ${job.turn}`)
      return
    }
    await sleep(10000)
  }

  const fs = ctx.get('fs')
  if (!fs || typeof fs.resolve !== 'function') return

  // Changed files for this turn.
  const workspaceChanges = ctx.get('workspaceChanges')
  const summary = typeof workspaceChanges?.summary === 'function'
    ? workspaceChanges.summary(job.sessionId, job.turn)
    : undefined
  if (!summary || !Array.isArray(summary.files) || summary.files.length === 0) {
    ctx.logger?.info?.(`dsh-wiki: no changed files recorded for turn ${job.turn}; nothing to write`)
    return
  }

  const maxChangedFiles = clampInt(prefs.maxChangedFiles, DEFAULTS.maxChangedFiles, 1, 500)
  const maxDiffBytes = clampInt(prefs.maxDiffBytes, DEFAULTS.maxDiffBytes, 0, 10_000_000)

  const picked = []
  for (let index = 0; index < summary.files.length && picked.length < maxChangedFiles; index++) {
    const file = summary.files[index]
    if (isIgnored(file?.display ?? file?.path, prefs.ignorePatterns)) continue
    picked.push({ index, file })
  }
  if (picked.length === 0) {
    ctx.logger?.info?.(`dsh-wiki: turn ${job.turn} changed only ignored files; nothing to write`)
    return
  }

  // Collect diffs within the byte budget. The index must stay the ORIGINAL
  // summary index — workspaceChanges.diff() addresses files by it.
  const abort = new AbortController()
  const diffs = []
  let budget = maxDiffBytes
  if (typeof workspaceChanges?.diff === 'function') {
    for (const { index } of picked) {
      if (budget <= 0) break
      try {
        const diff = await workspaceChanges.diff(job.sessionId, job.turn, index, abort.signal)
        if (!diff) continue
        const text = renderDiff(diff).trimEnd()
        if (text === '') continue
        const clipped = text.length > budget ? `${text.slice(0, budget)}\n…` : text
        diffs.push(clipped)
        budget -= clipped.length
      } catch (error) {
        ctx.logger?.warn?.(`dsh-wiki: diff ${index} failed: ${error?.message ?? error}`)
      }
    }
  }

  // Current wiki state.
  const projectName = projectNameOf(job.cwd) || job.cwd
  let homeText
  try {
    const homeTarget = await fs.resolve(`${folder}/Home.md`, { cwd: job.cwd })
    homeText = await fs.readText(homeTarget)
  } catch {
    homeText = null
  }
  const pages = []
  try {
    const dirTarget = await fs.resolve(folder, { cwd: job.cwd })
    const entries = await fs.listDir(dirTarget)
    for (const entry of entries ?? []) {
      if (entry?.type === 'file' && /\.md$/i.test(entry.name ?? '') && entry.name !== 'Home.md') {
        pages.push(entry.name.replace(/\.md$/i, ''))
      }
    }
  } catch { /* no wiki folder yet */ }

  // Writer model call.
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') {
    ctx.logger?.warn?.('dsh-wiki: llm service unavailable; skipping wiki update')
    return
  }

  const userPrompt = buildWriterUserPrompt({
    projectName,
    cwd: job.cwd,
    diffs,
    files: picked.map(({ file }) => file),
    homeText: homeText ?? '',
    pages,
    wikiFolder: folder,
  })
  const timeoutMs = clampInt(prefs.timeoutMs, DEFAULTS.timeoutMs, 10000, 3_600_000)
  const maxTokens = clampInt(prefs.maxTokens, DEFAULTS.maxTokens, 256, 128000)
  const timeout = setTimeout(() => abort.abort(new Error(`dsh-wiki: writer call timed out after ${timeoutMs}ms`)), timeoutMs)

  let answer = ''
  try {
    const stream = llm.stream({
      provider: job.provider,
      model: job.model,
      maxTokens,
      signal: abort.signal,
      messages: [
        { role: 'user', content: [{ type: 'text', text: buildWriterSystemPrompt(prefs) }] },
        { role: 'user', content: [{ type: 'text', text: userPrompt }] },
      ],
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') answer += chunk.text
      else if (chunk?.type === 'finish' && chunk.kind === 'error') {
        throw new Error(`writer call failed: ${chunk.failure?.code ?? chunk.failure?.message ?? 'unknown'}`)
      }
    }
  } catch (error) {
    if (abort.signal.aborted && timeoutMs && !error?.message?.includes('writer call failed')) {
      ctx.logger?.warn?.(`dsh-wiki: writer call aborted: ${error?.message ?? error}`)
    } else {
      ctx.logger?.warn?.(`dsh-wiki: writer call failed: ${error?.message ?? error}`)
    }
    return
  } finally {
    clearTimeout(timeout)
  }

  const result = parseWriterResponse(answer)
  if (result === null) {
    ctx.logger?.warn?.(`dsh-wiki: writer returned no valid JSON (${answer.length} chars); skipping`)
    return
  }
  if (result.skip === true) {
    ctx.logger?.info?.(`dsh-wiki: writer skipped the wiki update${result.reason ? `: ${result.reason}` : ''}`)
    return
  }

  // Write the page, then Home.md.
  await writeWikiFiles(ctx, fs, folder, job.cwd, result, homeText)
}

async function writeWikiFiles(ctx, fs, folder, cwd, result, oldHomeText) {
  const pagePath = `${folder}/${slugify(result.pageFile)}.md`
  const pageContent = result.pageContent ?? ''
  if (pageContent.trim() !== '') {
    try {
      await upsertFile(fs, pagePath, cwd, pageContent)
      ctx.logger?.info?.(`dsh-wiki: wrote ${pagePath}`)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-wiki: could not write ${pagePath}: ${error?.message ?? error}`)
    }
  }
  const homeContent = result.homeContent ?? ''
  if (homeContent.trim() !== '' && homeContent.trim() !== (oldHomeText ?? '').trim()) {
    try {
      await upsertFile(fs, `${folder}/Home.md`, cwd, homeContent)
      ctx.logger?.info?.(`dsh-wiki: updated ${folder}/Home.md`)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-wiki: could not update ${folder}/Home.md: ${error?.message ?? error}`)
    }
  }
}

/**
 * Create the file, or replace it version-guarded; on a stale version re-read
 * once and retry — the wiki may have been touched by another session.
 */
async function upsertFile(fs, path, cwd, content) {
  const target = await fs.resolve(path, { cwd })
  let existing
  try {
    existing = await fs.readText(target)
  } catch {
    existing = null
  }
  if (existing === null) {
    await fs.writeText(target, content, { kind: 'createIfAbsent' })
    return
  }
  try {
    const stat = await fs.stat(target)
    await fs.writeText(target, content, { kind: 'replaceIfVersion', version: stat?.version })
  } catch (error) {
    if (error?.code === 'FS_STALE_VERSION') {
      // One retry against the newest observed version.
      const fresh = await fs.stat(target)
      await fs.writeText(target, content, { kind: 'replaceIfVersion', version: fresh?.version })
      return
    }
    throw error
  }
}

/** Ensure the wiki exists and return the current Home.md text. */
async function ensureWikiHome(fs, cwd, folder) {
  const homeTarget = await fs.resolve(`${folder}/Home.md`, { cwd })
  try {
    return await fs.readText(homeTarget)
  } catch (error) {
    if (error?.code !== 'FS_NOT_FOUND') throw error
  }
  const skeleton = buildHomeSkeleton(projectNameOf(cwd) || cwd)
  await fs.writeText(homeTarget, skeleton, { kind: 'createIfAbsent' })
  return skeleton
}

/**
 * Register the plugin's host surfaces.
 * @param ctx - host plugin context.
 * @param config - profile/config overrides merged by the loader.
 */
export function apply(ctx, config) {
  const prefs = { ...DEFAULTS, ...(config ?? {}) }
  const folder = sanitizeFolder(prefs.wikiFolder)
  const queue = createQueue()

  // 1. System prompt: the wiki rules, replacing the AGENTS.md block.
  try {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      const order = clampInt(prefs.systemPromptOrder, DEFAULTS.systemPromptOrder, -1000000, 1000000)
      systemPrompt.section({
        name: 'dsh-wiki:rules',
        order,
        text: buildRulesText(prefs),
      })
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-wiki: system prompt section unavailable: ${error?.message ?? error}`)
  }

  // 2. Inject wiki/Home.md into each session.
  ctx.on('agent/created', async ({ agent }) => {
    if (!prefs.injectHome) return
    try {
      const header = agent?.session?.header
      const cwd = header?.cwd
      if (typeof cwd !== 'string' || cwd === '') return
      if (header.origin === 'subagent' && !prefs.injectSubagents) return
      const fs = ctx.get('fs')
      if (!fs || typeof fs.resolve !== 'function') return
      const homeText = await ensureWikiHome(fs, cwd, folder)
      if (typeof agent.inject !== 'function') return
      agent.inject({
        role: 'user',
        id: `dsh-wiki-${randomUUID()}`,
        content: [{ type: 'text', text: buildInjectText(prefs, cwd, homeText) }],
        source: { kind: 'dsh-wiki' },
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-wiki: Home.md injection failed: ${error?.message ?? error}`)
    }
  })

  // 3. Queue the wiki update when a top-level task is about to finish.
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!prefs.autoUpdate) return
    try {
      const header = agent?.session?.header
      const cwd = header?.cwd
      if (typeof cwd !== 'string' || cwd === '') return
      if (header.origin === 'subagent' || header.parentSession !== undefined) return
      const sessionId = agent.session.id
      if (typeof sessionId !== 'string' || sessionId === '') return

      // Inherit the session's own provider/model unless overridden in config.
      let provider = prefs.provider
      let model = prefs.model
      try {
        const requestConfig = agent.session.requestHeader?.()?.config
        if (!provider && requestConfig?.provider) provider = requestConfig.provider
        if (!model && requestConfig?.model) model = requestConfig.model
      } catch { /* header not materialized yet */ }
      if (!provider || !model) {
        ctx.logger?.warn?.('dsh-wiki: no provider/model resolvable for the wiki writer; skipping auto-update')
        return
      }
      scheduleJob(ctx, prefs, queue, { cwd, sessionId, turn, provider, model })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-wiki: turn-stopping handler failed: ${error?.message ?? error}`)
    }
  })
}
