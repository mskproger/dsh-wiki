/**
 * Pure helpers for dsh-wiki: prompt building, response parsing, file-name
 * sanitizing, ignore matching, and the Home.md skeleton. No harness imports —
 * this module stays unit-testable in plain Node.
 */

/** Project name = final segment of the workspace path. */
export function projectNameOf(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  const parts = cwd.replace(/\\/g, '/').split('/').filter((part) => part !== '')
  return parts.at(-1) ?? ''
}

/** Turn a model-suggested page title into a safe file name (no extension). */
export function slugify(name) {
  const raw = typeof name === 'string' ? name : ''
  const cleaned = raw
    .replace(/[<>:"|?*\\/]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\.+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  const safe = cleaned.replace(/^\.+/, '') // never a dot-file, never '..'
  return safe === '' ? 'page' : safe
}

/** Translate a simple glob ('*', '**', '?') into a RegExp. */
export function globToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // '**' spans path separators
        out += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

/** Whether a changed-file path matches any ignore pattern. */
export function isIgnored(path, patterns) {
  const slash = String(path ?? '').replace(/\\/g, '/')
  if (slash === '') return false
  for (const pattern of patterns ?? []) {
    const p = String(pattern ?? '').replace(/\\/g, '/').trim()
    if (p === '') continue
    try {
      const re = globToRegExp(p.startsWith('/') ? p.slice(1) : p)
      if (re.test(slash) || re.test(slash.replace(/^\.\//, ''))) return true
    } catch { /* malformed pattern never matches */ }
  }
  return false
}

/** Render one dsh-workspace-changes diff object into compact text. */
export function renderDiff(diff) {
  if (!diff || typeof diff !== 'object') return ''
  if (diff.kind !== 'text') return `[${diff.kind ?? 'no-comparison'}]`
  const head = `--- ${diff.display ?? diff.path ?? ''}${diff.before ? '' : ' (new)'}${diff.after ? '' : ' (deleted)'}\n`
  const body = (diff.hunks ?? []).map((hunk) => {
    const range = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    const lines = (hunk.lines ?? []).join('\n')
    return lines === '' ? range : `${range}\n${lines}`
  }).join('\n')
  return head + body
}

/** Default Home.md content for a fresh wiki. */
export function buildHomeSkeleton(projectName) {
  return [
    `# Home — ${projectName}`,
    '',
    'Вики-база знаний проекта. Ведётся автоматически плагином dsh-wiki.',
    '',
    '## Страницы',
    '',
    '## См. также',
    '',
  ].join('\n')
}

const RULES_RU = [
  'Вики-база знаний проекта ведётся автоматически плагином dsh-wiki: папка `{folder}/` в корне рабочего пространства, индекс `{folder}/Home.md`, страницы в Obsidian-совместимом markdown.',
  'Правила: страницы с перелинковкой `[[Имя страницы]]`, «← [[Home]]» вверху и «## См. также» внизу; секреты и доступы в вики не кладём.',
  'Плагин сам создаёт и обновляет страницы после выполнения задач. При необходимости читай `{folder}/Home.md` и страницы вики (открывая их чтением — @-импортов в DSH нет); правь вики вручную, только когда это часть задачи или попросил пользователь.',
]

const RULES_EN = [
  'The project wiki knowledge base is maintained automatically by the dsh-wiki plugin: folder `{folder}/` in the workspace root, index `{folder}/Home.md`, pages in Obsidian-compatible markdown.',
  'Rules: pages link each other with `[[Page name]]`, «← [[Home]]» on top and «## См. также» at the bottom; never put secrets or credentials into the wiki.',
  'The plugin creates and updates pages by itself after completed tasks. Read `{folder}/Home.md` and wiki pages (open them with file reads — DSH has no @-imports) when you need project knowledge; edit the wiki manually only when the task or the user asks for it.',
]

/** System-prompt section text for the wiki rules. */
export function buildRulesText(prefs) {
  const folder = sanitizeFolder(prefs.wikiFolder)
  const rules = (prefs.language === 'ru' ? RULES_RU : RULES_EN)
    .map((line) => line.replaceAll('{folder}', folder))
  return rules.join('\n')
}

/** Text injected into a session together with Home.md. */
export function buildInjectText(prefs, cwd, homeText) {
  const folder = sanitizeFolder(prefs.wikiFolder)
  const projectName = projectNameOf(cwd) || cwd
  const head = prefs.language === 'ru'
    ? [
        `<wiki-context>`,
        `Индекс вики-базы проекта «${projectName}» (папка \`${folder}/\` в корне workspace).`,
        `Открывай страницы вики чтением файлов из \`${folder}/\`; @-импортов в DSH нет.`,
        `Секретов и доступов в вики не кладём.`,
        ``,
      ]
    : [
        `<wiki-context>`,
        `Wiki knowledge base index of project "${projectName}" (folder \`${folder}/\` in the workspace root).`,
        `Open wiki pages by reading files under \`${folder}/\`; DSH has no @-imports.`,
        `Never put secrets or credentials into the wiki.`,
        ``,
      ]
  return `${head.join('\n')}--- ${folder}/Home.md ---\n${homeText}\n</wiki-context>`
}

/** Writer system prompt: the wiki keeper persona and the JSON contract. */
export function buildWriterSystemPrompt(prefs) {
  const folder = sanitizeFolder(prefs.wikiFolder)
  const lang = prefs.language === 'ru' ? 'ru' : 'en'
  const ru = prefs.language === 'ru'
  return [
    ru
      ? `Ты — хранитель вики-базы знаний проекта (Obsidian-совместимая вика в папке \`${folder}/\`).`
      : `You are the keeper of a project's wiki knowledge base (an Obsidian-compatible wiki in the \`${folder}/\` folder).`,
    ru
      ? 'Тебе передаются: имя проекта, список изменённых за задачу файлов с диффами и текущий индекс Home.md со списком страниц.'
      : 'You receive: the project name, the list of files changed during the task with diffs, and the current Home.md index with the page list.',
    ru ? 'Твоя задача — отразить результат задачи в вики:' : 'Your job is to reflect the task outcome in the wiki:',
    ru
      ? `- одна страница (или обновление существующей) на тему задачи; файл — в \`${folder}/\`, имя — осмысленное, на языке ${lang === 'ru' ? 'русском' : 'english'};`
      : `- one page (or an update to an existing one) per task theme; the file goes into \`${folder}/\` with a meaningful name in ${lang === 'ru' ? 'Russian' : 'English'};`,
    ru
      ? '- страница: «← [[Home]]» вверху, «## См. также» внизу, перелинковка `[[...]]` со смежными страницами; суть задачи, ключевые решения, где что лежит;'
      : '- the page: «← [[Home]]» on top, «## См. также» at the bottom, `[[...]]` links to related pages; the task essence, key decisions, where things live;',
    ru
      ? '- если тема уже описана существующей страницей — обнови её, не плоди дубли;'
      : '- if the theme is already covered by an existing page, update that page instead of duplicating;',
    ru
      ? '- Home.md: добавь строку `- [[Имя страницы]] — краткое описание` В КОНЕЦ раздела «## Страницы» (сразу перед строкой «## См. также»), если такой ссылки ещё нет; остальную структуру Home.md сохрани без изменений;'
      : '- Home.md: add the line `- [[Page name]] — short description` AT THE END of the «## Страницы» section (right before the «## См. также» line) if the link is missing; keep the rest of Home.md unchanged;',
    ru
      ? '- никаких секретов, паролей, ключей и токенов в вики;'
      : '- never write secrets, passwords, keys or tokens into the wiki;',
    ru
      ? '- если изменения незначимы для вики (мусор, логи, форматирование) — верни skip.'
      : '- if the changes do not deserve a wiki entry (noise, logs, formatting) — return skip.',
    '',
    ru
      ? 'Ответь СТРОГО одним JSON-объектом в блоке ```json, без другого текста:'
      : 'Answer with EXACTLY one JSON object in a ```json fence, no other text:',
    '```json',
    '{',
    '  "skip": false,',
    '  "reason": "optional note",',
    '  "pageFile": "Имя-страницы",',
    '  "pageTitle": "Заголовок страницы",',
    '  "pageContent": "полный markdown страницы",',
    '  "homeContent": "полный новый Home.md"',
    '}',
    '```',
    ru
      ? 'При skip=true поля pageFile/pageTitle/pageContent/homeContent можно опустить. homeContent при skip=true игнорируется.'
      : 'When skip=true you may omit pageFile/pageTitle/pageContent/homeContent. homeContent is ignored when skip=true.',
  ].join('\n')
}

/** Build the writer's user message with the collected facts. */
export function buildWriterUserPrompt({ projectName, cwd, diffs, files, homeText, pages, wikiFolder }) {
  const lines = []
  lines.push(`Project: ${projectName}`)
  lines.push(`Workspace: ${cwd}`)
  lines.push(`Wiki folder: ${wikiFolder}`)
  lines.push('')
  lines.push('Changed files this task:')
  if (!files.length) lines.push('(none)')
  for (const item of files) {
    const counts = item.added !== undefined || item.deleted !== undefined
      ? ` (+${item.added ?? 0}/-${item.deleted ?? 0})`
      : ''
    lines.push(`- ${item.display ?? item.path}${counts}`)
  }
  if (diffs.length) {
    lines.push('')
    lines.push('Diffs (truncated to budget):')
    for (const text of diffs) {
      lines.push('```diff')
      lines.push(text.trimEnd())
      lines.push('```')
    }
  }
  lines.push('')
  lines.push('Existing wiki pages:')
  lines.push(pages.length ? pages.map((p) => `- ${p}`).join('\n') : '(none)')
  lines.push('')
  lines.push('Current Home.md:')
  lines.push('```markdown')
  lines.push(homeText)
  lines.push('```')
  return lines.join('\n')
}

/**
 * Parse the writer's JSON answer. Returns
 *  {skip:true, reason} | {skip:false, pageFile, pageTitle, pageContent, homeContent} | null.
 */
export function parseWriterResponse(text) {
  if (typeof text !== 'string' || text === '') return null
  let jsonText = null
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    jsonText = fence[1].trim()
  } else {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start !== -1 && end > start) jsonText = text.slice(start, end + 1)
  }
  if (!jsonText) return null
  let parsed
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.skip === true) {
    return { skip: true, reason: typeof parsed.reason === 'string' ? parsed.reason : '' }
  }
  const pageFile = slugify(parsed.pageFile)
  const pageContent = typeof parsed.pageContent === 'string' ? parsed.pageContent : ''
  const homeContent = typeof parsed.homeContent === 'string' ? parsed.homeContent : ''
  if (pageFile === 'page' && pageContent === '') return null
  if (pageContent === '' && homeContent === '') return null
  return {
    skip: false,
    pageFile,
    pageTitle: typeof parsed.pageTitle === 'string' ? parsed.pageTitle : pageFile,
    pageContent,
    homeContent,
  }
}

/** Keep the folder name a single safe path segment. */
export function sanitizeFolder(folder) {
  const cleaned = String(folder ?? 'wiki')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('/')
  return cleaned === '' ? 'wiki' : cleaned
}

/** Cap a number to a sane positive range. */
export function clampInt(value, fallback, min = 1, max = 1_000_000_000) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}
