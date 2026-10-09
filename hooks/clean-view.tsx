import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, Timer } from 'claude-code'

import type { CleanViewChecklist, CleanViewTask } from '../types'

type $ = EngineInterface

const PLUGIN = 'clean-view'
const PLAN_TOOL = `mcp__${PLUGIN}__plan_steps`
const PROGRESS_TOOL = `mcp__${PLUGIN}__report_progress`
const ALWAYS_ALLOWED = new Set([
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  PLAN_TOOL,
  PROGRESS_TOOL,
])

const MAX_NAME = 40
const METER = 10
const TICK_MS = 250
const COLLAPSE_MS = 5000
const FAILURES_BEFORE_STUCK = 3

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

const REASON = {
  permission: 'Claude needs your OK to continue',
  question: 'Claude has a question for you',
  waiting: 'Claude is waiting for your reply',
  saidNo: 'you said no to a step, so Claude paused',
  failing: 'a step keeps failing, Claude is trying another way',
  refusal: "Claude couldn't help with that request",
  rateLimit: 'you hit your usage limit, try again a little later',
  overloaded: "Claude's servers are busy, try again in a minute",
  tooLong: 'the conversation is too long, type /compact and try again',
  network: 'the internet connection dropped, try again',
  auth: "Claude isn't signed in, type /login",
  unknownError: 'something went wrong, try again',
} as const

const CODE_EXTENSIONS =
  'tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|css|scss|sass|less|html?|json|ya?ml|toml|mdx?|sh|zsh|bash|sql|xml|vue|svelte|lock|env|ini|cfg|conf'
const FILE_NAME = new RegExp(`\\S*\\.(?:${CODE_EXTENSIONS})(?![A-Za-z0-9])\\S*`, 'gi')

/**
 * The one cleaner every step and job name goes through: no code, no paths,
 * no file names, one line, capitalised, at most 40 characters.
 */
export function cleanName(raw: unknown, fallback = 'Working on it'): string {
  let text = typeof raw === 'string' ? raw : ''
  text = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/`/g, ' ')
    .replace(/\S*[/\\]\S*/g, ' ')
    .replace(FILE_NAME, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s,;:.)\]–—-]+/, '')
    .replace(/[\s,;:([–—-]+$/, '')
    .trim()

  if (text === '') {
    return fallback
  }

  text = text.charAt(0).toUpperCase() + text.slice(1)

  if (text.length <= MAX_NAME) {
    return text
  }

  const head = text.slice(0, MAX_NAME - 1)
  const lastSpace = head.lastIndexOf(' ')
  const cut = (lastSpace > 0 ? head.slice(0, lastSpace) : head).replace(/[\s,;:.–—-]+$/, '')

  return `${cut}…`
}

/** A job title from Haiku: the cleaner, then 2 to 6 words, or nothing. */
function cleanTitle(raw: string): string | null {
  const firstLine = raw.split('\n').find(line => line.trim() !== '') ?? ''
  const words = cleanName(firstLine.replace(/["'“”‘’*_#.!?]/g, ''), '')
    .split(' ')
    .filter(Boolean)

  if (words.length < 2) {
    return null
  }

  return cleanName(words.slice(0, 6).join(' '))
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60

  if (h > 0) {
    return `${h}h ${m}m`
  }

  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function clampPercent(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

// ---------------------------------------------------------------------------
// Checklist transitions (pure)
// ---------------------------------------------------------------------------

function newChecklist(title: string, startedAt: number): CleanViewChecklist {
  return {
    title,
    phase: 'working',
    tasks: [
      { id: 'placeholder-1', name: 'Understand your request', status: 'active', percent: 0, hasReported: false },
      { id: 'placeholder-2', name: 'Plan the steps', status: 'upcoming', percent: 0, hasReported: false },
    ],
    needsYouReason: null,
    stuckReason: null,
    startedAt,
    finishedAt: null,
    isCollapsed: false,
    isPlanned: false,
  }
}

/** Makes the first upcoming step active when nothing is active and work remains. */
function ensureActive(tasks: CleanViewTask[]): CleanViewTask[] {
  if (tasks.some(t => t.status === 'active')) {
    return tasks
  }

  const next = tasks.findIndex(t => t.status === 'upcoming')

  return next === -1
    ? tasks
    : tasks.map((t, i) => (i === next ? { ...t, status: 'active', percent: 0, hasReported: false } : t))
}

function backToWork(c: CleanViewChecklist): CleanViewChecklist {
  return {
    ...c,
    phase: 'working',
    needsYouReason: null,
    stuckReason: null,
    finishedAt: null,
    isCollapsed: false,
  }
}

function withPlan(c: CleanViewChecklist, names: string[]): CleanViewChecklist {
  const tasks: CleanViewTask[] = names.map((name, i) => ({
    id: `step-${i + 1}`,
    name,
    status: i === 0 ? 'active' : 'upcoming',
    percent: 0,
    hasReported: false,
  }))

  return { ...backToWork(c), tasks, isPlanned: true }
}

function withProgress(c: CleanViewChecklist, name: string, percent: number): CleanViewChecklist {
  let tasks = [...c.tasks]
  let index = tasks.findIndex(t => sameName(t.name, name))

  if (index === -1) {
    const step: CleanViewTask = {
      id: `step-${tasks.length + 1}-${tasks.filter(t => t.id.startsWith('step-')).length}`,
      name,
      status: 'active',
      percent: 0,
      hasReported: false,
    }
    const activeAt = tasks.findIndex(t => t.status === 'active')
    index = activeAt === -1 ? tasks.length : activeAt
    tasks.splice(index, 0, step)
  }

  tasks = tasks.map((t, i) => {
    if (i < index) {
      return { ...t, status: 'done', percent: 100 }
    }

    if (i === index) {
      return percent >= 100
        ? { ...t, status: 'done', percent: 100, hasReported: true }
        : { ...t, status: 'active', percent, hasReported: true }
    }

    return t.status === 'active' ? { ...t, status: 'upcoming', percent: 0, hasReported: false } : t
  })

  return { ...backToWork(c), tasks: ensureActive(tasks), isPlanned: true }
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

function withTodos(c: CleanViewChecklist, todos: readonly Todo[]): CleanViewChecklist {
  if (todos.length === 0) {
    return c
  }

  const tasks: CleanViewTask[] = todos.map((todo, i) => {
    const name = cleanName(todo.content)
    const before = c.tasks.find(t => sameName(t.name, name))
    const status = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'
    const keep = status === 'active' && before?.status === 'active' && before.hasReported

    return {
      id: `todo-${i + 1}`,
      name,
      status,
      percent: status === 'done' ? 100 : keep ? before.percent : 0,
      hasReported: status === 'done' || Boolean(keep),
    }
  })

  return { ...backToWork(c), tasks: ensureActive(tasks), isPlanned: true }
}

function withTaskCreated(c: CleanViewChecklist, id: string, subject: string): CleanViewChecklist {
  const base = c.isPlanned ? c.tasks : []
  const task: CleanViewTask = { id: `task-${id}`, name: cleanName(subject), status: 'upcoming', percent: 0, hasReported: false }

  return { ...backToWork(c), tasks: ensureActive([...base, task]), isPlanned: true }
}

type TaskUpdate = { taskId: string; subject?: string; status?: 'pending' | 'in_progress' | 'completed' | 'deleted' }

function withTaskUpdated(c: CleanViewChecklist, u: TaskUpdate): CleanViewChecklist {
  const id = `task-${u.taskId}`

  if (!c.tasks.some(t => t.id === id)) {
    return c
  }

  let tasks = c.tasks
    .filter(t => !(t.id === id && u.status === 'deleted'))
    .map(t => {
      if (t.id === id) {
        const name = u.subject === undefined ? t.name : cleanName(u.subject)

        if (u.status === 'completed') {
          return { ...t, name, status: 'done' as const, percent: 100 }
        }

        if (u.status === 'in_progress') {
          return { ...t, name, status: 'active' as const }
        }

        if (u.status === 'pending') {
          return { ...t, name, status: 'upcoming' as const, percent: 0, hasReported: false }
        }

        return { ...t, name }
      }

      return u.status === 'in_progress' && t.status === 'active'
        ? { ...t, status: 'upcoming' as const, percent: 0, hasReported: false }
        : t
    })
  tasks = ensureActive(tasks)

  return { ...backToWork(c), tasks }
}

function apiErrorReason(kind: string, details: string): string {
  const said = details.toLowerCase()

  if (/prompt is too long|too long|context (window|length)|max.*tokens/.test(said)) {
    return REASON.tooLong
  }

  if (/econn|enotfound|network|socket|fetch failed|connection|timed? ?out|offline/.test(said)) {
    return REASON.network
  }

  switch (kind) {
    case 'rate_limit':
    case 'billing_error':
      return REASON.rateLimit
    case 'overloaded':
    case 'server_error':
      return REASON.overloaded
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'cloud_credential_error':
      return REASON.auth
    case 'invalid_request':
      return REASON.tooLong
    default:
      return REASON.unknownError
  }
}

const USER_SAID_NO = /doesn.t want to proceed|user rejected|was rejected|user declined|denied by the user/i

const SYSTEM_PROMPT = [
  '# Clean View',
  'The person using this session is not technical. Instead of your tool calls they see one simple checklist of the steps you take, so write it for them.',
  `- For every request, even a quick question, call \`${PLAN_TOOL}\` first with every step of the job, 2 to 8 short names in order. If it is deferred, load it with ToolSearch first (query "select:${PLAN_TOOL},${PROGRESS_TOOL}"). Other tools are refused until a plan exists.`,
  '- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".',
  '- Never put file paths, file names, commands, code or tool names in a step name.',
  `- Call \`${PROGRESS_TOOL}\` with the step's name and a percent as real progress happens, and with 100 the moment a step finishes.`,
  '- If this session has TodoWrite or TaskCreate, you may use your to-do list as the plan instead; the same naming rules apply to every item.',
].join('\n')

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

// Module state: lost on a hot reload, which is fine for each of these.
let ticker: Timer | undefined
let failures = 0
let lastApiError: string | null = null

async function isEnabled($: $): Promise<boolean> {
  return read($, enabledAtom)
}

function syncTicker($: $, c: CleanViewChecklist | null, enabled: boolean): void {
  const isLive = enabled && c !== null && (c.phase === 'working' || c.phase === 'needs-you')

  if (isLive && ticker === undefined) {
    ticker = $.clock.every(TICK_MS, () => {
      void update($, tickAtom, n => (n + 1) % 1_000_000)
    })
  } else if (!isLive && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
  }
}

async function change(
  $: $,
  fn: (c: CleanViewChecklist) => CleanViewChecklist | null,
): Promise<CleanViewChecklist | null> {
  let after: CleanViewChecklist | null = null
  await update($, checklistAtom, c => {
    after = c === null ? null : fn(c)

    return after
  })
  syncTicker($, after, await isEnabled($))

  return after
}

/** A checklist to write into, even when the plan arrives before any prompt was seen. */
async function ensureJob($: $): Promise<void> {
  if ((await read($, checklistAtom)) === null) {
    const job = newChecklist('Working on it', await $.clock.now())
    await update($, checklistAtom, () => job)
  }
}

async function startJob($: $, prompt: string): Promise<void> {
  const startedAt = await $.clock.now()
  const job = newChecklist(cleanName(prompt), startedAt)
  failures = 0
  lastApiError = null
  await update($, checklistAtom, () => job)
  syncTicker($, job, true)

  // Name the job in the background so the turn never waits on it.
  $.clock.after(0, () => {
    void nameJob($, prompt, startedAt)
  })
}

async function nameJob($: $, prompt: string, startedAt: number): Promise<void> {
  const reply = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 30,
    timeoutMs: 20_000,
    system:
      'You name jobs for a non-technical person. Reply with the name only: 2 to 6 plain words, starting with a verb, no punctuation, no file names, no code.',
    prompt: `Name this job:\n\n${prompt.slice(0, 2000)}`,
  })

  if (!reply.isAnswered) {
    return
  }

  const title = cleanTitle(reply.text)

  if (title === null) {
    return
  }

  // A newer job has started: this name belongs to the old one.
  await update($, checklistAtom, c => (c !== null && c.startedAt === startedAt ? { ...c, title } : c))
}

async function setEnabled($: $, value: boolean): Promise<void> {
  await update($, enabledAtom, () => value)
  await $.store.set('cleanViewEnabled', value)
  syncTicker($, await read($, checklistAtom), value)
  $.ui.toast(value ? 'Clean View is on: the technical details are hidden.' : 'Clean View is off: showing everything.')
}

async function finishJob($: $): Promise<void> {
  const finishedAt = await $.clock.now()
  const done = await change($, c => ({
    ...c,
    phase: 'done',
    needsYouReason: null,
    stuckReason: null,
    finishedAt,
    isCollapsed: false,
    tasks: c.tasks.map(t => ({ ...t, status: 'done', percent: 100 })),
  }))

  if (done === null) {
    return
  }

  $.clock.after(COLLAPSE_MS, () => {
    void update($, checklistAtom, c =>
      c !== null && c.startedAt === done.startedAt && c.phase === 'done' ? { ...c, isCollapsed: true } : c,
    )
  })
}

export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    await Promise.all([
      $.tool.register({
        name: 'plan_steps',
        description:
          'Lay out every step of the job up front, before any other tool: 2 to 8 short plain-English step names in order, each under 40 characters and starting with a verb. No file paths, file names, commands, code or tool names. The first step starts right away.',
        inputSchema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 8,
              description: 'The step names, in order.',
            },
          },
          required: ['steps'],
        },
        isDeferred: false,
      }),
      $.tool.register({
        name: 'report_progress',
        description:
          'Report real progress on the current step. Use the step name exactly as planned; percent 0 to 100, and 100 the moment the step is finished, which starts the next one. A new plain-English name adds a step.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The step name, as planned.' },
            percent: { type: 'number', minimum: 0, maximum: 100 },
          },
          required: ['task', 'percent'],
        },
        isDeferred: false,
      }),
      $.command.register({
        name: 'simple',
        description: 'Turn Clean View on or off (no argument flips it)',
        argumentHint: '[on|off]',
        immediate: true,
      }),
    ])

    const saved = await $.store.get('cleanViewEnabled')
    await update($, enabledAtom, () => saved !== false)
    syncTicker($, await read($, checklistAtom), saved !== false)

    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: 'Use /simple on, /simple off, or /simple on its own to switch.' }
    }

    const value = arg === '' ? !(await isEnabled($)) : arg === 'on'
    await setEnabled($, value)

    return { text: value ? 'Clean View is on.' : 'Clean View is off.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (!(await isEnabled($))) {
      return composed
    }

    return {
      sections: [
        ...composed.sections.filter(s => s.id !== `${PLUGIN}:plain-steps`),
        { id: `${PLUGIN}:plain-steps`, text: SYSTEM_PROMPT, scope: 'session' as const },
      ],
    }
  })

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()

    if (text !== '' && !text.startsWith('/') && (await isEnabled($))) {
      const c = await read($, checklistAtom)
      const isRunning = c !== null && (c.phase === 'working' || c.phase === 'needs-you' || c.phase === 'stuck')

      if (isRunning) {
        // The person replied to a running job: carry on with it.
        await change($, backToWork)
      } else {
        await startJob($, text)
      }
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const enabled = await isEnabled($)
    const isMain = e.agentId === undefined

    if (tool === PLAN_TOOL) {
      const raw: unknown = (e as { steps?: unknown }).steps
      const names = (Array.isArray(raw) ? raw : [])
        .map(step => cleanName(step, ''))
        .filter(name => name !== '')
        .slice(0, 8)

      if (names.length === 0) {
        return { deny: 'plan_steps needs 2 to 8 plain-English step names in `steps`.' }
      }

      await ensureJob($)
      await change($, c => withPlan(c, names))

      return { result: `Planned ${names.length} steps. The first one has started.` }
    }

    if (tool === PROGRESS_TOOL) {
      const input = e as { task?: unknown; percent?: unknown }
      const percent = clampPercent(input.percent)
      const name = cleanName(input.task)

      await ensureJob($)
      await change($, c => withProgress(c, name, percent))

      return { result: `Progress noted: ${percent}%.` }
    }

    if (enabled && isMain && !ALWAYS_ALLOWED.has(tool)) {
      const c = await read($, checklistAtom)

      if (c === null || !c.isPlanned) {
        return {
          deny: `Clean View: call ${PLAN_TOOL} first to lay out the steps of this job in plain English (load it with ToolSearch if it is deferred), then try again.`,
        }
      }
    }

    if (isMain && tool === 'AskUserQuestion') {
      await change($, c => ({ ...c, phase: 'needs-you', needsYouReason: REASON.question }))
    } else if (isMain) {
      await change($, c => (c.phase === 'needs-you' ? { ...c, phase: 'working', needsYouReason: null } : c))
    }

    const ran = await next(e)

    if (!isMain) {
      return ran
    }

    if (ran.deny !== undefined || ran.isError === true) {
      const said = `${ran.deny ?? ''} ${ran.text ?? ''}`

      if (USER_SAID_NO.test(said)) {
        failures = 0
        await change($, c => ({ ...c, phase: 'stuck', stuckReason: REASON.saidNo, needsYouReason: null }))
      } else {
        failures += 1

        if (failures >= FAILURES_BEFORE_STUCK) {
          await change($, c => ({ ...c, phase: 'stuck', stuckReason: REASON.failing, needsYouReason: null }))
        }
      }

      return ran
    }

    failures = 0

    if (tool === 'TodoWrite' || tool === 'TaskCreate') {
      await ensureJob($)
    }

    if (tool === 'TodoWrite') {
      const todos = (e as { todos?: Todo[] }).todos ?? []
      await change($, c => withTodos(c, todos))
    } else if (tool === 'TaskCreate') {
      const created = (ran.result as { task?: { id?: string; subject?: string } } | undefined)?.task
      const subject = created?.subject ?? (e as { subject?: string }).subject ?? ''

      if (created?.id !== undefined) {
        await change($, c => withTaskCreated(c, String(created.id), subject))
      }
    } else if (tool === 'TaskUpdate') {
      await change($, c => withTaskUpdated(c, e as unknown as TaskUpdate))
    } else {
      await change($, c => (c.phase === 'needs-you' || c.phase === 'stuck' ? backToWork(c) : c))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const kind = String(e.notification_type ?? '')
    const isPermission = kind === 'permission_prompt' || /permission/i.test(e.message ?? '')
    const isQuestion = kind.startsWith('elicitation')

    if (isPermission || isQuestion) {
      await change($, c =>
        c.phase === 'working' || c.phase === 'stuck' || c.phase === 'needs-you'
          ? { ...c, phase: 'needs-you', needsYouReason: isPermission ? REASON.permission : REASON.question }
          : c,
      )
    }

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    lastApiError = apiErrorReason(String(e.error), String(e.error_details ?? ''))
    const reason = lastApiError
    const finishedAt = await $.clock.now()
    await change($, c => (c.phase === 'done' ? c : { ...c, phase: 'stuck', stuckReason: reason, needsYouReason: null, finishedAt }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || (await read($, checklistAtom)) === null) {
      return next(e)
    }

    const finishedAt = await $.clock.now()

    if (e.reason === 'aborted') {
      await change($, c => ({ ...c, phase: 'stopped', needsYouReason: null, finishedAt }))
    } else if (e.reason === 'refusal') {
      await change($, c => ({ ...c, phase: 'stuck', stuckReason: REASON.refusal, needsYouReason: null, finishedAt }))
    } else if (e.reason === 'error') {
      const reason = lastApiError ?? REASON.unknownError
      await change($, c => ({ ...c, phase: 'stuck', stuckReason: reason, needsYouReason: null, finishedAt }))
    } else {
      const c = await read($, checklistAtom)
      const isUnfinished = c !== null && c.isPlanned && c.tasks.some(t => t.status !== 'done')

      if (c?.phase === 'stuck') {
        // Keep the reason (a "no" to a permission ends the turn as an answer).
      } else if (isUnfinished) {
        await change($, current => ({ ...current, phase: 'needs-you', needsYouReason: REASON.waiting }))
      } else {
        await finishJob($)
      }
    }

    lastApiError = null

    return next(e)
  })

  // Hide the technical rows while Clean View is on.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { Box } = $.ui.resolve(e)

    return (await isEnabled($)) ? <Box display="none" /> : next(e)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { Box } = $.ui.resolve(e)

    return (await isEnabled($)) ? <Box display="none" /> : next(e)
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { Box } = $.ui.resolve(e)

    return (await isEnabled($)) ? <Box display="none" /> : next(e)
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) =>
    (await isEnabled($)) ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    // What the app and later mods draw in this band: the branch, worktree and merge status
    // indicators among them. A tree drawn here replaces theirs, so theirs always goes under ours.
    const theirs = await next(e)
    const ours = await (async (): Promise<RenderElement> => {
    const enabled = await read($, enabledAtom)
    const c = await read($, checklistAtom)
    const tick = await read($, tickAtom)
    const now = await $.clock.now()
    const columns = Math.max(20, e.props.bodyColumns)
    const { Box, Text, Button } = $.ui.resolve(e)

    const toggle = (
      <Button
        key="clean-view-toggle"
        label={enabled ? '● Clean View: ON' : '○ Clean View: OFF'}
        variant={enabled ? 'primary' : 'secondary'}
        onPress={() => setEnabled($, !enabled)}
      />
    )

    if (!enabled || c === null) {
      return (
        <Box flexDirection="row" justifyContent="flex-end" width={columns}>
          {toggle}
        </Box>
      )
    }

    const elapsed = formatDuration((c.finishedAt ?? now) - c.startedAt)
    const header =
      c.phase === 'needs-you' ? (
        <Text key="header" wrap="truncate-end">
          <Text backgroundColor="warning" color="inverseText" bold>
            {' Needs you '}
          </Text>
          {` ${c.needsYouReason ?? REASON.waiting}`}
        </Text>
      ) : c.phase === 'stuck' ? (
        <Text key="header" color="warning" wrap="truncate-end">
          {`⚠ Stuck: ${c.stuckReason ?? REASON.unknownError}`}
        </Text>
      ) : c.phase === 'stopped' ? (
        <Text key="header" wrap="truncate-end">
          {`■ Stopped · ${c.title} · you pressed Esc`}
        </Text>
      ) : c.phase === 'done' ? (
        <Text key="header" color="success" wrap="truncate-end">
          {`✓ All done · ${c.title} · took ${elapsed}`}
        </Text>
      ) : (
        <Text key="header" wrap="truncate-end">
          <Text bold>{c.title}</Text>
          {` · ${elapsed}`}
        </Text>
      )

    const headerRow = (
      <Box key="header-row" flexDirection="row" justifyContent="space-between" width={columns}>
        <Box flexGrow={1} flexShrink={1} marginRight={1}>
          {header}
        </Box>
        {toggle}
      </Box>
    )

    if (c.phase === 'done' && c.isCollapsed) {
      return <Box flexDirection="column">{headerRow}</Box>
    }

    // marker + space, name, two spaces, meter, two spaces, label ("Up next")
    const nameWidth = Math.max(4, columns - 2 - 2 - METER - 2 - 7)
    const firstUpcoming = c.tasks.findIndex(t => t.status === 'upcoming')
    const isMoving = c.phase === 'working' || c.phase === 'needs-you'

    const rows = c.tasks.map((task, i) => {
      const shown = task.name.length > nameWidth ? `${task.name.slice(0, nameWidth - 1)}…` : task.name
      const name = shown.padEnd(nameWidth)
      const key = `row-${task.id}`

      if (task.status === 'done') {
        return (
          <Text key={key} wrap="truncate-end">
            <Text color="success">✓ </Text>
            <Text dimColor>{name}</Text>
            {`  ${'█'.repeat(METER)}  `}
            <Text dimColor>Done</Text>
          </Text>
        )
      }

      if (task.status === 'active') {
        const meter = task.hasReported
          ? '█'.repeat(Math.round(task.percent / 10)).padEnd(METER, '░')
          : sweep(isMoving ? tick : 0)
        const label = task.hasReported ? `${task.percent}%` : 'Working'

        return (
          <Text key={key} wrap="truncate-end">
            <Text color="claude">{c.phase === 'needs-you' ? '‖ ' : '▶ '}</Text>
            <Text bold>{name}</Text>
            <Text color="claude">{`  ${meter}  `}</Text>
            {label}
          </Text>
        )
      }

      return (
        <Text key={key} dimColor wrap="truncate-end">
          {`○ ${name}  ${'░'.repeat(METER)}  ${i === firstUpcoming ? 'Next' : 'Up next'}`}
        </Text>
      )
    })

    return (
      <Box flexDirection="column">
        {headerRow}
        {rows}
      </Box>
    )
    })()

    const { Box: Band } = $.ui.resolve(e)

    return (
      <Band flexDirection="column">
        {ours}
        {theirs}
      </Band>
    )
  })
}

/** A three-cell block sweeping across the meter while no percent is known. */
function sweep(tick: number): string {
  const span = METER + 3
  const head = tick % span
  let out = ''

  for (let i = 0; i < METER; i += 1) {
    out += i <= head && i > head - 3 ? '▓' : '░'
  }

  return out
}
