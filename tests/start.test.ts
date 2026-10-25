import { expect, test } from 'claude-code/testing'

const NOW = 1_000_000_000_000

type On = Parameters<Parameters<typeof test>[1]>[1]

// Nothing sits beneath the plugin: these hooks stand for the engine, with
// the store holding `stored` and the clock reading NOW. Resolves what the
// mod wrote for the band; what it saves lands back in `stored`, and a save
// under `refused` fails as a full store would.
const engine = (on: On, stored: Record<string, unknown>, toasts: string[] = [], refused?: string) => {
  const views: unknown[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'tamatem' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => {
    if (e.key === refused) throw new Error('store over 4 MiB')
    stored[e.key] = e.value

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete stored[e.key]

    return { value: undefined }
  })
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    views.push((e.value as { value: unknown }).value)

    return { value: { isSet: true, version: 1 } }
  })

  return views
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('a running block resumes on the band', async ($, on) => {
  const views = engine(on, {
    timer: { next: 'focus', cycle: 1, running: { phase: 'focus', endsAt: NOW + 1_000_000, minutes: 25 } },
  })
  await start($)

  expect(views.at(-1)).toEqual({ phase: 'focus', leftMs: 1_000_000, totalMs: 1_500_000, cycle: 1, rounds: 4 })
})

test("a finished block shows today's count on the band", async ($, on) => {
  const today = new Date(NOW)
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const views = engine(on, {
    timer: { next: 'break', cycle: 2, tip: "Grab some water.", endedAt: NOW - 60_000 },
    history: { days: { [day]: { blocks: 3, minutes: 75 } } },
  })
  await start($)

  expect(views.at(-1)).toEqual({ phase: 'done', cycle: 2, rounds: 4, tip: "Grab some water.", breakMinutes: 5, today: 3 })
})

test('nothing running clears the band', async ($, on) => {
  const views = engine(on, { timer: { next: 'focus', cycle: 0 } })
  await start($)

  expect(views.at(-1)).toBeNull()
})

const run = ($: Parameters<Parameters<typeof test>[1]>[0], args: string) =>
  $.command.run({ command: 'tamatem', args })

test('start refuses minutes out of bounds or not whole', async ($, on) => {
  const stored: Record<string, unknown> = {}
  engine(on, stored)

  for (const args of ['start 0', 'start 181', 'start 0.5', 'start 1e305', 'start -3', 'start 200 fix login']) {
    expect((await run($, args)).text).toContain('whole minutes from 1 to 180')
  }
  expect(stored.timer).toBeUndefined()

  expect((await run($, 'start 180')).text).toBe('🧠 focus started: 180 min.')
})

test('a break is bounded by its own length', async ($, on) => {
  engine(on, { timer: { next: 'break', cycle: 4 } })

  expect((await run($, 'break 121')).text).toContain('A long break takes whole minutes from 1 to 120')
})

test('a store written badly falls back instead of breaking', async ($, on) => {
  const views = engine(on, {
    timer: { next: 'focus', cycle: 1, running: { phase: 'focus', endsAt: null, minutes: 1e305 } },
    settings: { focus: -1, rounds: 1e9, sound: 'yes', notify: true },
  })
  await start($)

  // No end time means nothing is running; the bad settings fell back.
  expect(views.at(-1)).toBeNull()
  expect((await run($, 'set')).text).toContain('focus 25 min')
  expect((await run($, 'set')).text).toContain('long break after 4 rounds · sound off')
  expect((await run($, 'stats')).text).toContain('All time:   0 🍅')
})

test('history that could not be real is dropped from the stats', async ($, on) => {
  engine(on, {
    history: {
      days: {
        '2026-10-01': { blocks: 1, minutes: 1e305 },
        __proto__: { blocks: 5, minutes: 50 },
        'not-a-day': { blocks: 5, minutes: 50 },
        '2026-10-02': { blocks: 2, minutes: 50 },
      },
    },
  })

  expect((await run($, 'stats')).text).toContain('All time:   2 🍅 · 50 min focused')
})

test('pause keeps the time left, and resume carries on from it', async ($, on) => {
  const stored: Record<string, unknown> = {
    timer: { next: 'focus', cycle: 0, running: { phase: 'focus', endsAt: NOW + 600_000, minutes: 25 } },
  }
  const views = engine(on, stored)

  expect((await run($, 'pause')).text).toBe('⏸ Paused the focus with 10:00 left. /tamatem resume to carry on.')
  expect(views.at(-1)).toEqual({ phase: 'focus', leftMs: 600_000, totalMs: 1_500_000, cycle: 0, rounds: 4, isPaused: true })
  expect((await run($, '')).text).toContain('focus: 10:00 left (paused, /tamatem resume)')

  expect((await run($, 'resume')).text).toBe('▶ Resumed the focus: 10:00 left.')
  expect((stored.timer as { running: unknown }).running).toEqual({ phase: 'focus', endsAt: NOW + 600_000, minutes: 25 })
  expect((await run($, 'resume')).text).toBe("The focus isn't paused.")
})

test('pause again resumes, and a paused block survives a restart', async ($, on) => {
  const stored: Record<string, unknown> = {
    timer: { next: 'focus', cycle: 0, running: { phase: 'short', endsAt: NOW - 1, minutes: 5, pausedLeftMs: 120_000 } },
  }
  const views = engine(on, stored)
  await start($)

  // The old end time has passed, but a paused block doesn't finish.
  expect(views.at(-1)).toMatchObject({ phase: 'short', leftMs: 120_000, isPaused: true })
  expect((await run($, 'pause')).text).toBe('▶ Resumed the short break: 02:00 left.')
})

test('pause with nothing running says so', async ($, on) => {
  engine(on, {})

  expect((await run($, 'pause')).text).toBe('No timer running.')
})

const dayOf = (ms: number) => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type Running = { running: Record<string, unknown> }

test('start names a task, with or without minutes, as typed', async ($, on) => {
  const stored: Record<string, unknown> = {}
  const views = engine(on, stored)

  expect((await run($, 'start Fix Login bug')).text).toBe('🧠 focus started: 25 min · Fix Login bug')
  expect((stored.timer as Running).running).toMatchObject({ minutes: 25, task: 'Fix Login bug' })
  expect(views.at(-1)).toMatchObject({ phase: 'focus', task: 'Fix Login bug' })

  expect((await run($, 'start 50 Write the README')).text).toBe('Stopped the focus. 🧠 focus started: 50 min · Write the README')
  expect((await run($, '')).text).toContain('focus on Write the README: 50:00 left')
  expect((await run($, 'start')).text).toBe('Stopped the focus. 🧠 focus started: 25 min.')
})

test('a task name loses control characters and is cut to 60', async ($, on) => {
  const stored: Record<string, unknown> = {}
  engine(on, stored)

  await run($, 'start red\u001b[31mtext')
  expect((stored.timer as Running).running.task).toBe('red [31mtext')

  await run($, `start ${'a'.repeat(80)}`)
  expect((stored.timer as Running).running.task).toBe(`${'a'.repeat(59)}…`)
})

test('a named block counts under its task, and today lists it', async ($, on) => {
  const today = dayOf(NOW)
  const stored: Record<string, unknown> = {
    timer: { next: 'focus', cycle: 0, running: { phase: 'focus', endsAt: NOW - 1, minutes: 25, task: 'Fix login' } },
    history: { days: { [today]: { blocks: 1, minutes: 25, tasks: { 'Fix login': { blocks: 1, minutes: 25 } } } } },
  }
  const toasts: string[] = []
  const views = engine(on, stored, toasts)
  await start($)

  expect(stored.history).toEqual({
    days: { [today]: { blocks: 2, minutes: 50, tasks: { 'Fix login': { blocks: 2, minutes: 50 } } } },
  })
  expect(toasts.at(-1)).toBe('🔔 Fix login done while you were away · /tamatem break for 5 min')
  expect(views.at(-1)).toMatchObject({ phase: 'done', task: 'Fix login', today: 2 })
  expect((await run($, 'stats')).text).toContain("🎯 Today's tasks\n  Fix login · 2 🍅 · 50 min")
})

test('days over a year old fold into all time, without their names', async ($, on) => {
  const stored: Record<string, unknown> = {
    timer: { next: 'focus', cycle: 0, running: { phase: 'focus', endsAt: NOW - 1, minutes: 25 } },
    history: {
      days: { '1999-01-01': { blocks: 3, minutes: 75, tasks: { Old: { blocks: 3, minutes: 75 } } } },
      earlier: { blocks: 1, minutes: 10 },
    },
  }
  engine(on, stored)
  await start($)

  expect(stored.history).toEqual({
    days: { [dayOf(NOW)]: { blocks: 1, minutes: 25 } },
    earlier: { blocks: 4, minutes: 85 },
  })
  expect((await run($, 'stats')).text).toContain('All time:   5 🍅 · 1h 50m focused')
})

test('skipped breaks stop at the last round, and the long break is due', async ($, on) => {
  const stored: Record<string, unknown> = {
    timer: { next: 'break', cycle: 4, running: { phase: 'focus', endsAt: NOW - 1, minutes: 25 } },
  }
  engine(on, stored)
  await start($)

  expect((stored.timer as { cycle: number }).cycle).toBe(4)
  expect((await run($, '')).text).toContain('Focus block done (4/4). /tamatem break for a long break.')
})

test('a count that cannot be saved still ends the block, and says so', async ($, on) => {
  const stored: Record<string, unknown> = {
    timer: { next: 'focus', cycle: 0, running: { phase: 'focus', endsAt: NOW - 1, minutes: 25 } },
  }
  const toasts: string[] = []
  engine(on, stored, toasts, 'history')
  await start($)

  expect(stored.timer).toMatchObject({ next: 'break', cycle: 1 })
  expect(toasts.at(-1)).toBe("🔔 Focus done while you were away · /tamatem break for 5 min · stats couldn't be saved")
})

test('a block that ended yesterday leaves the band clear', async ($, on) => {
  const views = engine(on, { timer: { next: 'break', cycle: 1, endedAt: NOW - 86_400_000 } })
  await start($)

  expect(views.at(-1)).toBeNull()
})

test('a break that ends shows the band until the next start', async ($, on) => {
  const stored: Record<string, unknown> = {
    timer: { next: 'break', cycle: 1, running: { phase: 'short', endsAt: NOW - 1, minutes: 5 } },
  }
  const toasts: string[] = []
  const views = engine(on, stored, toasts)
  await start($)

  expect(views.at(-1)).toEqual({ phase: 'over', cycle: 1, rounds: 4, today: 0 })
  expect(toasts.at(-1)).toBe('🔔 Break over while you were away · /tamatem start for round 2')
})

test('stop with nothing running clears what the band still shows', async ($, on) => {
  const stored: Record<string, unknown> = { timer: { next: 'break', cycle: 1, endedAt: NOW - 60_000 } }
  const views = engine(on, stored)

  expect((await run($, 'stop')).text).toBe('Cleared the band. /tamatem start when you are ready.')
  expect(views.at(-1)).toBeNull()
  expect(stored.timer).toEqual({ next: 'break', cycle: 1 })
  expect((await run($, 'stop')).text).toBe('No timer running.')
})

test('bare /tamatem stays short, and help lists every command', async ($, on) => {
  engine(on, {})
  const where = (await run($, '')).text

  expect(where).toContain('No timer running. /tamatem start [min] [task] to begin.')
  expect(where).toContain('/tamatem help for every command.')
  expect(where).not.toContain('/tamatem set reset')
  expect((await run($, 'help')).text).toContain('/tamatem set reset')
  expect((await run($, 'help')).text).toContain('● ◐ ○ count rounds')
})

test('a long task is cut in the toast', async ($, on) => {
  const task = 'fixing dsajsam pojsad apjsadmp jaspomdsa asdpmoa sd'
  const toasts: string[] = []
  engine(on, { timer: { next: 'focus', cycle: 0, running: { phase: 'focus', endsAt: NOW - 1, minutes: 25, task } } }, toasts)
  await start($)

  expect(toasts.at(-1)).toBe('🔔 fixing dsajsam pojsad apjsa… done while you were away · /tamatem break for 5 min')
})

test('history is stats by another name', async ($, on) => {
  engine(on, {})

  expect((await run($, 'history')).text).toBe((await run($, 'stats')).text)
})

test('a typo gets a suggestion, gibberish the full list', async ($, on) => {
  engine(on, {})

  expect((await run($, 'state')).text).toBe('Unknown: /tamatem state. Did you mean /tamatem stats?')
  expect((await run($, 'strat')).text).toBe('Unknown: /tamatem strat. Did you mean /tamatem start?')
  expect((await run($, 'puase')).text).toBe('Unknown: /tamatem puase. Did you mean /tamatem pause?')
  expect((await run($, 'stp')).text).toBe('Unknown: /tamatem stp. Did you mean /tamatem stop?')
  expect((await run($, 'stat')).text).toBe('Unknown: /tamatem stat. Did you mean /tamatem start or /tamatem stats?')
  expect((await run($, 'xyzzy')).text).toContain('Unknown: /tamatem xyzzy\n\n/tamatem start')
})

test('stats reset asks first, then clears every count', async ($, on) => {
  const today = dayOf(NOW)
  const stored: Record<string, unknown> = {
    timer: { next: 'break', cycle: 2, endedAt: NOW - 60_000 },
    history: { days: { [today]: { blocks: 2, minutes: 50, tasks: { 'Fix login': { blocks: 2, minutes: 50 } } } }, earlier: { blocks: 3, minutes: 75 } },
  }
  const views = engine(on, stored)

  expect((await run($, 'stats reset')).text).toBe(
    "This deletes all 5 🍅 (2h 5m focused) and today's tasks, for good. The timer and settings stay.\n" +
      '/tamatem stats reset confirm to go ahead.',
  )
  expect(stored.history).toMatchObject({ earlier: { blocks: 3 } })

  expect((await run($, 'history reset confirm')).text).toBe('Stats reset. A fresh start.')
  expect(stored.history).toBeUndefined()
  expect(stored.timer).toMatchObject({ cycle: 2 })
  expect(views.at(-1)).toMatchObject({ phase: 'done', today: 0 })
  expect((await run($, 'stats reset')).text).toBe('No stats to reset.')
})

test('starting over a running block says it stopped it', async ($, on) => {
  engine(on, { timer: { next: 'focus', cycle: 0, running: { phase: 'focus', endsAt: NOW + 600_000, minutes: 25 } } })

  expect((await run($, 'start 10 docs')).text).toBe('Stopped the focus. 🧠 focus started: 10 min · docs')
})
