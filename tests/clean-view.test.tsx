import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

import { cleanName } from '../hooks/clean-view'

const PLUGIN = 'clean-view'
const PLAN = 'mcp__clean-view__plan_steps'
const PROGRESS = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const

type Band = Mounted<RenderSurface, 'AbovePrompt'>

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
}

/** The engine beneath the plugin: everything it calls on `$` gets an answer. */
function stubEngine(on: On, { withStore = true } = {}): void {
  if (withStore) {
    mock.store(on)
  }

  mock.clock(on, { now: 1_000_000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__clean-view__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: 'Build my landing page',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.Notification', () => ({}))
  on('tool.call', { tool: 'TodoWrite' }, (_$, e) => ({ result: { oldTodos: [], newTodos: e.todos } }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  on('tool.call', { tool: 'ToolSearch' }, () => ({ result: { matches: [], query: 'select:x', total_deferred_tools: 0 } }))
}

function mountBand($: Engine, surface: RenderSurface) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND_PROPS })
}

/** The full text of the checklist row that names `step`. */
async function rowText(ui: Band, step: string): Promise<string> {
  const found = await ui.findAll({ type: 'Text', text: step })

  return found.map(el => el.text).sort((a, b) => b.length - a.length)[0] ?? ''
}

async function bandText(ui: Band): Promise<string> {
  return (await ui.findAll({ type: 'Text' })).map(el => el.text).join('\n')
}

test('1. names are cleaned into plain English', () => {
  expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  expect(cleanName('Update the header in src/components/Header.tsx before launch')).toBe(
    'Update the header in before launch',
  )
  expect(cleanName('fix layout.css spacing')).toBe('Fix spacing')

  const long = cleanName(
    'Rewrite every paragraph of the about page so it sounds warmer and friendlier to new visitors today',
  )
  expect(long.length).toBeLessThanOrEqual(40)
  expect(long).toEndWith('…')
  expect(cleanName('`npm run build`')).toBe('Working on it')
})

test('2. a to-do list plus a 60% report draws done, current, next and up next', async ($, on) => {
  stubEngine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading your brand notes' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building the pricing section' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding the contact form' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing the footer' },
    ],
  })
  await $.tool.call({ tool: PROGRESS, task: 'Build the pricing section', percent: 60 })

  for (const surface of SURFACES) {
    const ui = await mountBand($, surface)
    const done = await rowText(ui, 'Read your brand notes')
    const current = await rowText(ui, 'Build the pricing section')
    const next = await rowText(ui, 'Add the contact form')
    const later = await rowText(ui, 'Polish the footer')

    expect(done).toContain('✓')
    expect(done).toContain('██████████')
    expect(done).toContain('Done')
    expect(current).toContain('▶')
    expect(current).toContain('██████░░░░')
    expect(current).toContain('60%')
    expect(next).toContain('○')
    expect(next).toEndWith('Next')
    expect(next).not.toContain('Up next')
    expect(later).toEndWith('Up next')
    expect(await ui.find({ type: 'Button', key: 'clean-view-toggle' })).toBeDefined()
    await ui.unmount()
  }
})

test('3. a permission prompt shows Needs you', async ($, on) => {
  stubEngine(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.classic.Notification({
    message: 'Claude needs your permission to use Bash',
    notification_type: 'permission_prompt',
  })

  for (const surface of SURFACES) {
    const ui = await mountBand($, surface)
    const text = await bandText(ui)

    expect(text).toContain('Needs you')
    expect(text).toContain('Claude needs your OK to continue')
    expect(text).toContain('‖')
    await ui.unmount()
  }
})

test('4. /simple off hides the band and shows the tool rows again', async ($, on) => {
  const saved: Record<string, unknown> = {}
  on('store.get', (_$, e) => ({ value: saved[e.key] }))
  on('store.set', (_$, e) => {
    saved[e.key] = e.value

    return { value: undefined }
  })
  stubEngine(on, { withStore: false })
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })

  const row = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'ToolUse',
    props: {
      tool_use_id: 'tu-1',
      tool: 'Bash',
      input: { command: 'ls' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  })
  expect((await row.find({ type: 'Box' }))?.props.display).toBe('none')
  await row.unmount()

  const before = await mountBand($, 'terminal')
  expect(await bandText(before)).toContain('Understand your request')
  await before.unmount()

  await $.command.run({
    command: 'simple',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  for (const surface of SURFACES) {
    const ui = await mountBand($, surface)
    const button = await ui.find({ type: 'Button', key: 'clean-view-toggle' })

    expect(String(button?.props.label)).toContain('OFF')
    expect(await bandText(ui)).not.toContain('Understand your request')
    await ui.unmount()
  }

  expect(saved.cleanViewEnabled).toBe(false)
})

test('5. report_progress at 100 checks off step one and starts step two', async ($, on) => {
  stubEngine(on)
  const planned = await $.tool.call({
    tool: PLAN,
    steps: ['Read your brand notes', 'Build the pricing section', 'Polish the footer'],
  })
  expect(planned.result).toBe('Planned 3 steps. The first one has started.')

  const reported = await $.tool.call({ tool: PROGRESS, task: 'Read your brand notes', percent: 140 })
  expect(reported.result).toBe('Progress noted: 100%.')

  const ui = await mountBand($, 'terminal')
  const first = await rowText(ui, 'Read your brand notes')
  const second = await rowText(ui, 'Build the pricing section')
  const third = await rowText(ui, 'Polish the footer')

  expect(first).toStartWith('✓')
  expect(first).toEndWith('Done')
  expect(second).toStartWith('▶')
  expect(second).toEndWith('Working')
  expect(third).toEndWith('Next')
  await ui.unmount()
})

test('6. tools are denied before a plan exists and allowed after', async ($, on) => {
  stubEngine(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })

  const before = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(`${before.deny ?? ''}${before.text ?? ''}`).toContain('plan_steps')

  const search = await $.tool.call({ tool: 'ToolSearch', query: 'select:x', max_results: 1 })
  expect(search.deny).toBeUndefined()

  await $.tool.call({ tool: PLAN, steps: ['Look around', 'Make the change'] })

  const after = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(after.deny).toBeUndefined()
  expect(after.isError).toBeUndefined()
})
