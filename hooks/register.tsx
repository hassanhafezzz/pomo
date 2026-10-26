import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode } from 'claude-code'

import type { View } from '../types'

type Engine = EngineInterface
type Phase = 'focus' | 'short' | 'long'

// Everything the timer needs lives in $.store, so it survives a reload and
// a restart: a running block resumes, one that ended while away is reported.
type Pomo = {
  // A paused block keeps the time it had left; endsAt is set again on resume.
  running?: { phase: Phase; endsAt: number; minutes?: number; tip?: string; pausedLeftMs?: number; task?: string }
  next: 'focus' | 'break'
  cycle: number // focus blocks done since the last long break, up to the rounds
  tip?: string // the idea the last focus toast gave for the coming break
  task?: string // what the focus block just done was for
  lastTask?: string // the last focus block's task, kept through breaks for /tamatem continue
  endedAt?: number // when the last block ended; the band shows it that day
}

// Completed focus blocks only, per local day (`YYYY-MM-DD`): a stopped
// block does not count. A named block also counts under its task, per day.
// Days over a year old fold into `earlier`, totals only and no names: only
// All time reads them.
type Day = { blocks: number; minutes: number }
type Dated = Day & { tasks?: Record<string, Day> }
type History = { days: Record<string, Dated>; earlier?: Day }

type Settings = Record<Phase, number> & { rounds: number; sound: boolean; toast: boolean }

const KEY = 'timer'
const HISTORY_KEY = 'history'
const SETTINGS_KEY = 'settings'
const CHIME = 'sounds/chime.wav'
const MAX_TASK = 60
const EMPTY: Pomo = { next: 'focus', cycle: 0 }
const DEFAULTS: Settings = { focus: 25, short: 5, long: 15, rounds: 4, sound: false, toast: true }
const LIMITS: Record<Phase | 'rounds', [number, number]> = {
  focus: [1, 180],
  short: [1, 60],
  long: [1, 120],
  rounds: [1, 12],
}
// 🧠 focus, ☕ a short break, 🛌 a long one, 🔔 a block ended, 🍅 one counted.
// None takes a variation selector, so each is two cells wherever it's drawn.
const ICON: Record<Phase, string> = { focus: '🧠', short: '☕', long: '🛌' }
const LABEL: Record<Phase, string> = {
  focus: 'focus',
  short: 'short break',
  long: 'long break',
}
const TIPS: Record<'short' | 'long', string[]> = {
  short: [
    'Stand up and stretch.',
    'Focus on something far off for 20 seconds.',
    'Grab some water.',
    'Grab some coffee.',
    'Grab some tea.',
    'Take a few slow breaths. In for 4, out for 6.',
    'Water a plant or clear your desk.',
    'Do a few push-ups or squats.',
    'Check your posture.',
    'Look out the window.',
  ],
  long: [
    "It's time for a short walk.",
    'Have a healthy snack.',
    'Say hi to a friend.',
    'Lie down for a bit.',
    'Do a few stretches or yoga poses.',
    'Listen to a favorite song.',
    'Meditate for a few minutes.',
    'Write down something you are grateful for.',
    'Tidy up your space.',
  ],
}

const HELP = [
  '/tamatem start [min] [task] start a focus block, named if you like',
  '/tamatem continue [min]     another focus block on the last task',
  '/tamatem break [min]        start a break (long after every round)',
  '/tamatem pause              pause the current block, again to resume',
  '/tamatem resume             carry on a paused block',
  '/tamatem stop               stop the current block, or clear the band',
  '/tamatem stats              focus blocks today, this week, month, year, all time (or history)',
  '/tamatem stats reset        delete every count, after a confirm',
  '/tamatem set [name] [n]     show or change focus, short, long, rounds',
  '/tamatem set reset          back to 25/5/15, 4 rounds',
  '/tamatem sound on|off       chime when a block ends',
  '/tamatem toast on|off       pop-up when a block ends',
  '/tamatem                    show where you are',
  '/tamatem help               this list',
  '',
  'In the band, ● ◐ ○ count rounds: ● a focus block done, ◐ the one running,',
  '○ one to come. When all are ●, the long break is due.',
].join('\n')

// What the band draws, rewritten every tick. Change the tag when View's
// fields change: it declines what an earlier version stored.
const view = atom({ plugin: 'tamatem', key: 'view' } as const, null, { shape: 'view-6' })

// A hot reload cancels the old timer with the old module; session.start
// runs again and starts a new one.
let ticker: { cancel: () => void } | undefined

// Each read-then-write of the store waits for the one before it, so a tick
// can't save over a block a command has just started.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T,>(task: () => Promise<T>): Promise<T> => {
  const run = queue.then(task)
  queue = run.catch(() => {})

  return run
}

// The store is ours, but it can hold what an earlier version wrote, or be
// edited by hand: everything read from it is checked, and what fails falls
// back to a default.
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isPhase = (v: unknown): v is Phase => v === 'focus' || v === 'short' || v === 'long'

// A whole number from min to max, or undefined.
const within = (v: unknown, [min, max]: readonly [number, number]) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined

const isTip = (v: unknown): v is string =>
  typeof v === 'string' && (TIPS.short.includes(v) || TIPS.long.includes(v))

const MAX_CYCLE = LIMITS.rounds[1]

// A task name as typed, on one line, without control characters, and cut
// to MAX_TASK; undefined when nothing is left.
const toTask = (v: unknown) => {
  if (typeof v !== 'string') return undefined
  const clean = v.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return undefined

  return clean.length > MAX_TASK ? `${clean.slice(0, MAX_TASK - 1).trimEnd()}…` : clean
}

const load = async ($: Engine): Promise<Pomo> => {
  const raw = await $.store.get(KEY)
  if (!isObject(raw)) return EMPTY

  const pomo: Pomo = {
    next: raw.next === 'break' ? 'break' : 'focus',
    cycle: within(raw.cycle, [0, MAX_CYCLE]) ?? 0,
  }
  if (isTip(raw.tip)) pomo.tip = raw.tip
  const task = toTask(raw.task)
  if (task) pomo.task = task
  // A store from before lastTask still knows the block just done.
  const lastTask = toTask(raw.lastTask) ?? task
  if (lastTask) pomo.lastTask = lastTask
  if (typeof raw.endedAt === 'number' && Number.isFinite(raw.endedAt)) pomo.endedAt = raw.endedAt

  const r = raw.running
  if (isObject(r) && isPhase(r.phase) && typeof r.endsAt === 'number' && Number.isFinite(r.endsAt)) {
    pomo.running = { phase: r.phase, endsAt: r.endsAt }
    const minutes = within(r.minutes, LIMITS[r.phase])
    if (minutes !== undefined) pomo.running.minutes = minutes
    if (isTip(r.tip)) pomo.running.tip = r.tip
    const runningTask = toTask(r.task)
    if (runningTask) pomo.running.task = runningTask
    const left = r.pausedLeftMs
    if (typeof left === 'number' && left > 0 && left <= LIMITS[r.phase][1] * 60_000) {
      pomo.running.pausedLeftMs = left
    }
  }

  return pomo
}

const save = ($: Engine, pomo: Pomo) => $.store.set(KEY, pomo)

// Each setting on its own, so one bad value doesn't reset the rest.
const loadSettings = async ($: Engine): Promise<Settings> => {
  const raw = await $.store.get(SETTINGS_KEY)
  const s = isObject(raw) ? raw : {}

  return {
    focus: within(s.focus, LIMITS.focus) ?? DEFAULTS.focus,
    short: within(s.short, LIMITS.short) ?? DEFAULTS.short,
    long: within(s.long, LIMITS.long) ?? DEFAULTS.long,
    rounds: within(s.rounds, LIMITS.rounds) ?? DEFAULTS.rounds,
    sound: typeof s.sound === 'boolean' ? s.sound : DEFAULTS.sound,
    toast: typeof s.toast === 'boolean' ? s.toast : DEFAULTS.toast,
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

const dayOf = (ms: number) => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

// A day's count, if it could be real: no more minutes than its blocks allow.
const toDay = (v: unknown): Day | undefined => {
  if (!isObject(v)) return undefined
  const blocks = within(v.blocks, [0, Number.MAX_SAFE_INTEGER])
  const { minutes } = v
  if (blocks === undefined || typeof minutes !== 'number' || !(minutes >= 0)) return undefined
  if (minutes > blocks * LIMITS.focus[1]) return undefined

  return { blocks, minutes }
}

// A day's count and, when it has them, its tasks' counts.
const toDated = (v: unknown): Dated | undefined => {
  const day = toDay(v)
  if (!day || !isObject(v) || !isObject(v.tasks)) return day

  const tasks: Record<string, Day> = {}
  for (const [name, one] of Object.entries(v.tasks)) {
    const task = toTask(name)
    const counted = toDay(one)
    if (task === name && counted) tasks[name] = counted
  }

  return Object.keys(tasks).length > 0 ? { ...day, tasks } : day
}

const loadHistory = async ($: Engine): Promise<History> => {
  const raw = await $.store.get(HISTORY_KEY)
  if (isObject(raw)) {
    const history: History = { days: {} }
    for (const [day, one] of Object.entries(isObject(raw.days) ? raw.days : {})) {
      const checked = toDated(one)
      if (checked && DAY.test(day)) history.days[day] = checked
    }
    const earlier = toDay(raw.earlier)
    if (earlier) history.earlier = earlier

    return history
  }

  return { days: {} }
}

const add = (a: Day | undefined, minutes: number): Day => ({
  blocks: (a?.blocks ?? 0) + 1,
  minutes: (a?.minutes ?? 0) + minutes,
})

// Moves days from before `from` into `earlier`, dropping their names, so
// the history stays about a year long however long it's used.
const fold = (history: History, from: string): History => {
  const days: Record<string, Dated> = {}
  const earlier = { blocks: history.earlier?.blocks ?? 0, minutes: history.earlier?.minutes ?? 0 }
  for (const [day, one] of Object.entries(history.days)) {
    if (day >= from) {
      days[day] = one
    } else {
      earlier.blocks += one.blocks
      earlier.minutes += one.minutes
    }
  }

  return earlier.blocks > 0 || history.earlier ? { days, earlier } : { days }
}

// Counts one finished focus block; resolves how many today now holds.
const countBlock = async ($: Engine, minutes: number, endedAt: number, task?: string) => {
  const history = await loadHistory($)
  const day = dayOf(endedAt)
  const was = history.days[day]
  const now: Dated = { ...add(was, minutes) }
  const tasks = task ? { ...was?.tasks, [task]: add(was?.tasks?.[task], minutes) } : was?.tasks
  if (tasks) now.tasks = tasks

  const ended = new Date(endedAt)
  const yearAgo = dayOf(new Date(ended.getFullYear() - 1, ended.getMonth(), ended.getDate()).getTime())
  await $.store.set(HISTORY_KEY, fold({ ...history, days: { ...history.days, [day]: now } }, yearAgo))

  return now.blocks
}

const sumSince = (history: History, from: string) => {
  const sum = { blocks: 0, minutes: 0 }
  for (const [day, one] of Object.entries(history.days)) {
    if (day < from) continue
    sum.blocks += one.blocks
    sum.minutes += one.minutes
  }

  return sum
}

const hours = (total: number) => {
  const minutes = Math.round(total)

  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const statsText = (history: History, now: number) => {
  const d = new Date(now)
  const y = d.getFullYear()
  const m = d.getMonth()
  const monday = new Date(y, m, d.getDate() - ((d.getDay() + 6) % 7))
  const all = sumSince(history, '')
  const rows: [string, Day][] = [
    ['Today', sumSince(history, dayOf(now))],
    ['This week', sumSince(history, dayOf(monday.getTime()))],
    ['This month', sumSince(history, `${y}-${pad(m + 1)}-01`)],
    ['This year', sumSince(history, `${y}-01-01`)],
    [
      'All time',
      {
        blocks: all.blocks + (history.earlier?.blocks ?? 0),
        minutes: all.minutes + (history.earlier?.minutes ?? 0),
      },
    ],
  ]

  // Counts right-aligned, so the column reads at a glance.
  const width = Math.max(...rows.map(([, one]) => String(one.blocks).length))
  const lines = rows.map(
    ([name, one]) => `${`${name}:`.padEnd(12)}${String(one.blocks).padStart(width)} 🍅 · ${hours(one.minutes)} focused`,
  )

  // Today's named blocks, the most time first.
  const tasks = Object.entries(history.days[dayOf(now)]?.tasks ?? {}).sort(([, a], [, b]) => b.minutes - a.minutes)
  if (tasks.length > 0) {
    lines.push('', "🎯 Today's tasks")
    for (const [task, one] of tasks) lines.push(`  ${task} · ${one.blocks} 🍅 · ${hours(one.minutes)}`)
  }

  return ['📊 Focus', ...lines].join('\n')
}

// A break idea, never the one given last time.
const pickTip = (kind: 'short' | 'long', last?: string) => {
  const choices = TIPS[kind].filter(tip => tip !== last)

  return choices[Math.floor(Math.random() * choices.length)] ?? TIPS[kind][0]!
}

const settingsText = (s: Settings) =>
  [
    `focus ${s.focus} min · short ${s.short} min · long ${s.long} min`,
    `long break after ${s.rounds} rounds · sound ${s.sound ? 'on' : 'off'} · toast ${s.toast ? 'on' : 'off'}`,
  ].join('\n')

const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')

  return `${mm}:${ss}`
}

// ● a round done, ◐ the one running, ○ one to come.
const dots = (done: number, rounds: number, isRunning: boolean) =>
  Array.from({ length: rounds }, (_, i) =>
    i < done ? '●' : i === done && isRunning ? '◐' : '○',
  ).join(' ')

const round = (pomo: Pomo, rounds: number) =>
  `${Math.min(pomo.cycle + 1, rounds)}/${rounds}`

// Today's blocks, a tomato each, counted past eight.
const tomatoes = (n: number) => (n <= 8 ? '🍅'.repeat(n) : `🍅 × ${n}`)

// Brings the band up to date with the stored timer.
const paint = async ($: Engine, pomo: Pomo, settings: Settings, now: number) => {
  const { rounds } = settings
  let shown: View | null = null

  if (pomo.running) {
    const { phase, endsAt, minutes = settings[phase], tip, pausedLeftMs, task } = pomo.running
    const isPaused = pausedLeftMs !== undefined
    const leftMs = isPaused ? pausedLeftMs : Math.max(0, endsAt - now)
    shown = { phase, leftMs, totalMs: minutes * 60_000, cycle: pomo.cycle, rounds, tip }
    if (isPaused) shown.isPaused = true
    if (task) shown.task = task
  } else if (pomo.endedAt !== undefined) {
    // What just ended and what comes next, kept until the next block or a
    // /tamatem stop, and only the day it happened: tomorrow it's stale.
    const day = dayOf(await $.clock.now())
    if (dayOf(pomo.endedAt) === day) {
      const today = sumSince(await loadHistory($), day).blocks
      const cycle = Math.min(pomo.cycle, rounds)
      if (pomo.next === 'break') {
        const kind = cycle >= rounds ? 'long' : 'short'
        shown = { phase: 'done', cycle, rounds, tip: pomo.tip, breakMinutes: settings[kind], today }
        if (pomo.task) shown.task = pomo.task
      } else {
        shown = { phase: 'over', cycle, rounds, today }
        if (pomo.lastTask) shown.task = pomo.lastTask
      }
    }
  }

  await update($, view, () => shown)
  // A state write redraws only a band that has read the view; one that hasn't
  // drawn since the mod loaded never subscribed, so ask for the redraw.
  $.ui.invalidate('ui.render')
}

// The band's label: an icon and the task, or the phase. A task shows up to
// MAX_LABEL characters; /tamatem has it in full.
const MAX_LABEL = 28
const shorten = (text: string) =>
  text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1).trimEnd()}…` : text

const bandLabel = (icon: string, text: string, done = '') => {
  const label = `${icon} ${shorten(text)}${done}`

  // The icon takes two cells; the column never narrows past the phase names.
  return { label, width: Math.max(14, label.length + 1) }
}

// The band's inner width, less the border, padding, gaps, label, clock and
// round dots; steady through a block, so the bar never jumps.
const barWidth = (columns: number, rounds: number, labelWidth: number) =>
  Math.max(6, Math.min(48, columns - 4 - 6 - labelWidth - 5 - (rounds * 2 - 1)))

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// The band's bar, `width` cells wide and filled in eighths: [filled, empty].
const smoothBar = (progress: number, width: number) => {
  const cells = Math.max(0, Math.min(1, progress)) * width
  const full = Math.floor(cells)
  const part = full < width ? (EIGHTHS[Math.floor((cells - full) * 8)] ?? '') : ''

  return ['█'.repeat(full) + part, '░'.repeat(width - full - (part ? 1 : 0))] as const
}

const finish = async ($: Engine, pomo: Pomo, isAway: boolean) => {
  if (!pomo.running) return

  const settings = await loadSettings($)
  const { phase, endsAt, minutes = settings[phase], task } = pomo.running
  // Skipped breaks stop at the last round: the long break is due.
  const cycle = phase === 'focus' ? Math.min(pomo.cycle + 1, settings.rounds) : phase === 'long' ? 0 : pomo.cycle
  const kind = cycle >= settings.rounds ? 'long' : 'short'
  const done: Pomo =
    phase === 'focus'
      ? { next: 'break', cycle, tip: pickTip(kind, pomo.running.tip ?? pomo.tip) }
      : { next: 'focus', cycle }
  if (phase === 'focus' && task) done.task = task
  const lastTask = phase === 'focus' ? task : pomo.lastTask
  if (lastTask) done.lastTask = lastTask
  done.endedAt = endsAt
  // Saved before the count, so the block ends even if the count can't be saved.
  await save($, done)

  const away = isAway ? ' while you were away' : ''
  const next = Math.min(cycle + 1, settings.rounds)
  let message = lastTask
    ? `🔔 Break over${away} · /tamatem continue on ${shorten(lastTask)} for round ${next}`
    : `🔔 Break over${away} · /tamatem start for round ${next}`
  if (phase === 'focus') {
    const isCounted = await countBlock($, minutes, endsAt, task).then(
      () => true,
      () => false,
    )
    // What ended and the next step; the band has the rest.
    message = `🔔 ${task ? shorten(task) : 'Focus'} done${away} · /tamatem break for ${settings[kind]} min`
    if (!isCounted) message += " · stats couldn't be saved"
  }
  if (settings.toast) $.ui.toast(message, { timeoutMs: 8000 })
  await paint($, done, settings, endsAt)
  // No chime for a block that ended while Claude was closed: it's stale.
  if (settings.sound && !isAway) {
    $.audio.play({ asset: CHIME }).catch(() => {})
  }
}

const tick = async ($: Engine) => {
  const [pomo, settings] = await Promise.all([load($), loadSettings($)])
  if (!pomo.running || pomo.running.pausedLeftMs !== undefined) {
    ticker?.cancel()
    ticker = undefined
    await paint($, pomo, settings, await $.clock.now())

    return
  }

  const now = await $.clock.now()
  if (pomo.running.endsAt <= now) {
    ticker?.cancel()
    ticker = undefined
    await finish($, pomo, false)

    return
  }

  await paint($, pomo, settings, now)
}

// Resolves once the first tick has painted, so the band shows at once.
// Called from inside the queue; later ticks join it. A tick that fails
// leaves the timer as it was, and the next one tries again.
const startTicking = ($: Engine) => {
  ticker?.cancel()
  ticker = $.clock.every(1000, () => {
    serial(() => tick($)).catch(() => {})
  })

  return tick($)
}

const begin = async ($: Engine, phase: Phase, minutes: number, task?: string) => {
  const pomo = await load($)
  // A block already running ends uncounted; say so, so it's no surprise.
  const ended = pomo.running ? `Stopped the ${LABEL[pomo.running.phase]}. ` : ''
  const endsAt = (await $.clock.now()) + minutes * 60_000
  // A break keeps the idea the focus toast gave, or gets one of its own.
  const tip =
    phase === 'focus'
      ? undefined
      : pomo.tip && TIPS[phase].includes(pomo.tip)
        ? pomo.tip
        : pickTip(phase, pomo.tip)
  const running: Pomo['running'] = { phase, endsAt, minutes, tip }
  if (task) running.task = task
  const started: Pomo = { next: pomo.next, cycle: pomo.cycle, running }
  // A focus block becomes the last task, named or not; a break keeps it.
  const lastTask = phase === 'focus' ? task : pomo.lastTask
  if (lastTask) started.lastTask = lastTask
  await save($, started)
  await startTicking($)

  return phase === 'focus'
    ? `${ended}🧠 focus started: ${minutes} min${task ? ` · ${task}` : '.'}`
    : `${ended}${ICON[phase]} ${LABEL[phase]} started: ${minutes} min. ${tip}`
}

const pause = async ($: Engine) => {
  const [pomo, settings] = await Promise.all([load($), loadSettings($)])
  if (!pomo.running) return 'No timer running.'
  if (pomo.running.pausedLeftMs !== undefined) return resume($)

  const now = await $.clock.now()
  const left = pomo.running.endsAt - now
  // Nothing left to keep: the next tick would have finished it.
  if (left <= 0) return `The ${LABEL[pomo.running.phase]} is just ending.`

  const paused: Pomo = { ...pomo, running: { ...pomo.running, pausedLeftMs: left } }
  await save($, paused)
  ticker?.cancel()
  ticker = undefined
  await paint($, paused, settings, now)

  return `⏸ Paused the ${LABEL[pomo.running.phase]} with ${clock(left)} left. /tamatem resume to carry on.`
}

const resume = async ($: Engine) => {
  const pomo = await load($)
  const left = pomo.running?.pausedLeftMs
  if (!pomo.running || left === undefined) {
    return pomo.running ? `The ${LABEL[pomo.running.phase]} isn't paused.` : 'No timer running.'
  }

  const { pausedLeftMs: _, ...running } = pomo.running
  await save($, { ...pomo, running: { ...running, endsAt: (await $.clock.now()) + left } })
  await startTicking($)

  return `▶ Resumed the ${LABEL[running.phase]}: ${clock(left)} left.`
}

// Another focus block on the last task. A focus already running is left
// alone, and a paused one resumes: either way the work carries on.
const carryOn = async ($: Engine, minutes: number) => {
  const pomo = await load($)
  const running = pomo.running
  if (running?.phase === 'focus') {
    if (running.pausedLeftMs !== undefined) return resume($)
    const left = running.endsAt - (await $.clock.now())

    return `Already on ${running.task ?? 'a focus block'}: ${clock(left)} left.`
  }
  if (!pomo.lastTask) return 'No task to continue. /tamatem start [min] [task] to name one.'

  return begin($, 'focus', minutes, pomo.lastTask)
}

// Why the minutes asked for won't do, or undefined when they will.
const badMinutes = (verb: string, arg: string, phase: Phase, fallback: number) => {
  const [min, max] = LIMITS[phase]
  const n = Number(arg)
  if (Number.isInteger(n) && n >= min && n <= max) return undefined

  return `A ${LABEL[phase]} takes whole minutes from ${min} to ${max}, e.g. /tamatem ${verb} ${fallback}`
}

const VERBS = ['start', 'continue', 'break', 'pause', 'resume', 'stop', 'stats', 'history', 'set', 'sound', 'toast', 'status', 'help']

// Edits between two words: insert, delete or change a letter, or swap two
// side by side, so "strat" is one edit from start.
const distance = (a: string, b: string) => {
  let before: number[] = []
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        next[j] = Math.min(next[j]!, before[j - 2]! + 1)
      }
    }
    before = row
    row = next
  }

  return row[b.length]!
}

// The commands a mistyped one was probably meant to be: one edit away for a
// short word, two for a longer one, the closest only. None for gibberish.
const closest = (typed: string) => {
  const allowed = typed.length <= 4 ? 1 : 2
  const near = VERBS.map(verb => ({ verb, d: distance(typed, verb) })).filter(({ d }) => d <= allowed)
  const best = Math.min(...near.map(({ d }) => d))

  return near.filter(({ d }) => d === best).map(({ verb }) => `/tamatem ${verb}`)
}

// Deleting every count can't be undone, so the first ask only says what
// would go; the same command with `confirm` does it.
const resetStats = async ($: Engine, settings: Settings, isConfirmed: boolean) => {
  const history = await loadHistory($)
  const now = await $.clock.now()
  const all = sumSince(history, '')
  const blocks = all.blocks + (history.earlier?.blocks ?? 0)
  const minutes = all.minutes + (history.earlier?.minutes ?? 0)
  if (blocks === 0) return 'No stats to reset.'

  if (!isConfirmed) {
    return (
      `This deletes all ${blocks} 🍅 (${hours(minutes)} focused) and today's tasks, for good. ` +
      'The timer and settings stay.\n/tamatem stats reset confirm to go ahead.'
    )
  }

  await $.store.delete(HISTORY_KEY)
  await paint($, await load($), settings, now)

  return 'Stats reset. A fresh start.'
}

const describe = async ($: Engine) => {
  const [pomo, settings] = await Promise.all([load($), loadSettings($)])
  const now = await $.clock.now()
  const stats = statsText(await loadHistory($), now)
  if (pomo.running) {
    const { endsAt, pausedLeftMs, task } = pomo.running
    const left = pausedLeftMs ?? endsAt - now
    const paused = pausedLeftMs === undefined ? '' : ' (paused, /tamatem resume)'
    const onTask = task ? ` on ${task}` : ''

    return `${LABEL[pomo.running.phase]}${onTask}: ${clock(left)} left${paused} · round ${round(pomo, settings.rounds)}\n\n${stats}`
  }

  const done = Math.min(pomo.cycle, settings.rounds)
  const kind = done >= settings.rounds ? 'long' : 'short'
  const where =
    pomo.next === 'break'
      ? `Focus block done${pomo.task ? `: ${pomo.task}` : ''} (${done}/${settings.rounds}). /tamatem break for a ${kind} break.`
      : pomo.lastTask
        ? `No timer running. /tamatem continue on ${pomo.lastTask}, or /tamatem start [min] [task].`
        : 'No timer running. /tamatem start [min] [task] to begin.'

  return `${where}\n\n${stats}\n\n/tamatem help for every command.`
}

const set = async ($: Engine, name = '', value = '') => {
  const settings = await loadSettings($)
  if (name === '') return `${settingsText(settings)}\n\nChange one: /tamatem set focus 30`

  if (name === 'reset') {
    // The alerts are their own switches; a reset of the durations keeps them.
    const reset = { ...DEFAULTS, sound: settings.sound, toast: settings.toast }
    await $.store.set(SETTINGS_KEY, reset)

    return `Back to the defaults.\n${settingsText(reset)}`
  }

  if (!(name === 'focus' || name === 'short' || name === 'long' || name === 'rounds')) {
    return `Unknown setting "${name}". Choose focus, short, long or rounds.`
  }

  const [min, max] = LIMITS[name]
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    return `${name} takes a whole number from ${min} to ${max}, e.g. /tamatem set ${name} ${settings[name]}`
  }

  const changed = { ...settings, [name]: n }
  await $.store.set(SETTINGS_KEY, changed)
  const unit = name === 'rounds' ? '' : ' min'

  return `${name} set to ${n}${unit}. A block already running keeps its length.\n${settingsText(changed)}`
}

const toast = async ($: Engine, value = '') => {
  const settings = await loadSettings($)
  if (value !== 'on' && value !== 'off') {
    return `Toast is ${settings.toast ? 'on' : 'off'}. /tamatem toast on|off to change it.`
  }

  await $.store.set(SETTINGS_KEY, { ...settings, toast: value === 'on' })

  return value === 'on'
    ? 'Toast on: a pop-up says when a block ends.'
    : 'Toast off. The band still shows when a block ends.'
}

const sound = async ($: Engine, value = '') => {
  const settings = await loadSettings($)
  if (value !== 'on' && value !== 'off') {
    return `Sound is ${settings.sound ? 'on' : 'off'}. /tamatem sound on|off to change it.`
  }

  await $.store.set(SETTINGS_KEY, { ...settings, sound: value === 'on' })
  if (value === 'off') return 'Sound off.'

  // Play it now, so the person hears what they turned on.
  const played = await $.audio.play({ asset: CHIME }).then(
    () => true,
    () => false,
  )

  return played
    ? 'Sound on: this chime plays when a block ends.'
    : "Sound on, but the chime couldn't play here (sound needs macOS)."
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tamatem',
      description: 'Pomodoro timer: start, continue, break, pause, resume, stop, stats, set, sound, toast, help',
      argumentHint: '[start [min] [task]|continue [min]|break|pause|resume|stop|stats|set|sound|toast|help]',
      immediate: true,
    })

    await serial(async () => {
      const [pomo, settings] = await Promise.all([load($), loadSettings($)])
      const now = await $.clock.now()
      if (pomo.running && pomo.running.pausedLeftMs === undefined) {
        if (pomo.running.endsAt <= now) await finish($, pomo, true)
        else await startTicking($)
      } else {
        await paint($, pomo, settings, now)
      }
    })

    return next(e)
  })

  on('command.run', { command: 'tamatem' }, ($, e) =>
    serial(async () => {
      // Lower case for the words pomo reads; a task name keeps what was typed.
      const words = e.args.trim().split(/\s+/).filter(Boolean)
      const [verb = '', arg, value] = words.map(w => w.toLowerCase())

      if (verb === 'start') {
        const settings = await loadSettings($)
        // A first word that reads as a number is the minutes; the rest names the task.
        const hasMinutes = arg !== undefined && !Number.isNaN(Number(arg))
        const why = hasMinutes ? badMinutes(verb, arg, 'focus', settings.focus) : undefined
        if (why) return { text: why }
        const task = toTask(words.slice(hasMinutes ? 2 : 1).join(' '))

        return { text: await begin($, 'focus', hasMinutes ? Number(arg) : settings.focus, task) }
      }

      if (verb === 'continue') {
        const settings = await loadSettings($)
        const why = arg === undefined ? undefined : badMinutes(verb, arg, 'focus', settings.focus)
        if (why) return { text: why }

        return { text: await carryOn($, arg === undefined ? settings.focus : Number(arg)) }
      }

      if (verb === 'break') {
        const [pomo, settings] = await Promise.all([load($), loadSettings($)])
        const phase = pomo.cycle >= settings.rounds ? 'long' : 'short'
        const why = arg === undefined ? undefined : badMinutes(verb, arg, phase, settings[phase])
        if (why) return { text: why }

        return { text: await begin($, phase, arg === undefined ? settings[phase] : Number(arg)) }
      }

      if (verb === 'pause') return { text: await pause($) }

      if (verb === 'resume') return { text: await resume($) }

      if (verb === 'stop') {
        const [pomo, settings] = await Promise.all([load($), loadSettings($)])
        if (!pomo.running) {
          if (pomo.endedAt === undefined) return { text: 'No timer running.' }
          // Nothing to stop, but the band still shows the last block: clear it.
          const { endedAt: _, ...cleared } = pomo
          await save($, cleared)
          await paint($, cleared, settings, 0)

          return { text: 'Cleared the band. /tamatem start when you are ready.' }
        }
        const stopped: Pomo = { next: pomo.next, cycle: pomo.cycle, tip: pomo.tip }
        if (pomo.lastTask) stopped.lastTask = pomo.lastTask
        await save($, stopped)
        ticker?.cancel()
        ticker = undefined
        await paint($, stopped, settings, 0)

        return { text: `Stopped the ${LABEL[pomo.running.phase]}.` }
      }

      if (verb === 'stats' || verb === 'history') {
        if (arg === 'reset') return { text: await resetStats($, await loadSettings($), value === 'confirm') }

        return { text: statsText(await loadHistory($), await $.clock.now()) }
      }

      if (verb === 'set') return { text: await set($, arg, value) }

      if (verb === 'sound') return { text: await sound($, arg) }

      if (verb === 'toast') return { text: await toast($, arg) }

      if (verb === '' || verb === 'status') return { text: await describe($) }

      if (verb === 'help') return { text: HELP }

      const guesses = closest(verb)
      if (guesses.length > 0) {
        return { text: `Unknown: /tamatem ${verb}. Did you mean ${guesses.join(' or ')}?` }
      }

      return { text: `Unknown: /tamatem ${verb}\n\n${HELP}` }
    }),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, view)
    if (!shown || e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    // Pass the band on, so what another mod or the engine draws there stacks
    // under pomo's instead of being hidden while a block runs.
    const below = await next(e)

    // Quiet on purpose: a subtle frame and no colour, so it sits at the edge
    // of attention while the work has the focus. The time left and what to
    // do next read at normal weight; the rest is dim.
    const frame = (rows: RenderNode) => (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="subtle" paddingX={1}>
          {rows}
        </Box>
        {below}
      </Box>
    )

    // A block just ended: the bar stays full in the block's own geometry, and
    // the next step comes before the idea, so a narrow band cuts the idea.
    if (shown.phase === 'done' || shown.phase === 'over') {
      const isDone = shown.phase === 'done'
      const { label, width } = isDone
        ? bandLabel('🔔', shown.task ?? 'focus', ' done')
        : bandLabel('🔔', 'break over')
      const [filled] = smoothBar(1, barWidth(e.props.bodyColumns, shown.rounds, width))
      const round = Math.min(shown.cycle + 1, shown.rounds)

      return frame(
        <Box flexDirection="column">
          <Box gap={2}>
            <Box width={width}>
              <Text>{label}</Text>
            </Box>
            <Text dimColor>{filled}</Text>
            <Text dimColor>{dots(shown.cycle, shown.rounds, false)}</Text>
          </Box>
          <Text wrap="truncate-end">
            <Text dimColor>today </Text>
            <Text>{shown.today > 0 ? tomatoes(shown.today) : '–'}</Text>
            <Text dimColor>{'  ·  '}</Text>
            <Text>{isDone ? '/tamatem break' : shown.task ? '/tamatem continue' : '/tamatem start'}</Text>
            <Text dimColor>
              {isDone
                ? ` for ${shown.breakMinutes} min${shown.tip ? `  ·  ${shown.tip}` : ''}`
                : `${shown.task ? ` on ${shorten(shown.task)}` : ''} for round ${round}`}
            </Text>
          </Text>
        </Box>,
      )
    }

    const isFocus = shown.phase === 'focus'
    const progress = 1 - shown.leftMs / shown.totalMs
    const icon = shown.isPaused ? '⏸' : ICON[shown.phase]
    const { label, width } = bandLabel(icon, (isFocus && shown.task) || LABEL[shown.phase])
    const [filled, empty] = smoothBar(progress, barWidth(e.props.bodyColumns, shown.rounds, width))

    return frame(
      <Box flexDirection="column">
        <Box gap={2}>
          <Box width={width}>
            <Text>{label}</Text>
          </Box>
          <Text>
            <Text>{filled}</Text>
            <Text dimColor>{empty}</Text>
          </Text>
          <Text dimColor={shown.isPaused}>{clock(shown.leftMs)}</Text>
          <Text dimColor>{dots(shown.cycle, shown.rounds, isFocus)}</Text>
        </Box>
        {!isFocus && shown.tip && (
          <Text dimColor wrap="truncate-end">
            {shown.tip}
          </Text>
        )}
      </Box>,
    )
  })
}
