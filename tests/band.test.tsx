import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'tamatem',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// The band reads a shaped value: seed it under the tag the mod writes.
const holding = (value: unknown) => () => ({
  value: { value: { shape: 'view-6', value }, version: 1 },
})

// The engine beneath, drawing nothing of its own there.
type On = Parameters<Parameters<typeof test>[1]>[1]

const nothingBelow = (on: On) =>
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text)

test('a focus block halfway draws the label, the clock and the rounds', async ($, on) => {
  on('state.get', holding({ phase: 'focus', leftMs: 750_000, totalMs: 1_500_000, cycle: 1, rounds: 4 }))
  nothingBelow(on)
  const ui = await $.ui.mount(BAND)
  const drawn = await texts(ui)

  expect(drawn).toContain('🧠 focus')
  expect(drawn).toContain('12:30')
  expect(drawn).toContain('● ◐ ○ ○')
  await ui.unmount()
})

test('a break draws its idea under the bar', async ($, on) => {
  on('state.get', holding({ phase: 'short', leftMs: 62_000, totalMs: 300_000, cycle: 2, rounds: 4, tip: 'Grab some water.' }))
  nothingBelow(on)
  const ui = await $.ui.mount(BAND)
  const drawn = await texts(ui)

  expect(drawn).toContain('☕ short break')
  expect(drawn).toContain('Grab some water.')
  await ui.unmount()
})

test('a finished block shows today\'s tomatoes and the next break idea', async ($, on) => {
  on('state.get', holding({ phase: 'done', cycle: 4, rounds: 4, tip: "It's time for a short walk.", breakMinutes: 15, today: 3 }))
  nothingBelow(on)
  const ui = await $.ui.mount(BAND)
  const drawn = await texts(ui)

  expect(drawn).toContain('● ● ● ●')
  expect(drawn).toContain('🔔 focus done')
  expect(drawn).toContain('🍅🍅🍅')
  expect(drawn).toContain('/tamatem break')
  expect(drawn.some(t => t?.includes("for 15 min  ·  It's time for a short walk."))).toBe(true)
  await ui.unmount()
})

test('nothing running leaves the band to the engine', async ($, on) => {
  on('state.get', holding(null))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const ui = await $.ui.mount(BAND)

  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a band drawn beneath stacks under the running block', async ($, on) => {
  on('state.get', holding({ phase: 'focus', leftMs: 750_000, totalMs: 1_500_000, cycle: 1, rounds: 4 }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>below</Text>
  })
  const ui = await $.ui.mount(BAND)
  const drawn = await texts(ui)

  expect(drawn).toContain('🧠 focus')
  expect(drawn).toContain('below')
  await ui.unmount()
})

test('a paused block says so in place of its icon', async ($, on) => {
  on('state.get', holding({ phase: 'focus', leftMs: 750_000, totalMs: 1_500_000, cycle: 1, rounds: 4, isPaused: true }))
  nothingBelow(on)
  const ui = await $.ui.mount(BAND)
  const drawn = await texts(ui)

  expect(drawn).toContain('⏸ focus')
  expect(drawn).toContain('12:30')
  await ui.unmount()
})

test('a named focus puts its task in the label', async ($, on) => {
  on('state.get', holding({ phase: 'focus', leftMs: 750_000, totalMs: 1_500_000, cycle: 1, rounds: 4, task: 'Fix login bug' }))
  nothingBelow(on)
  const ui = await $.ui.mount(BAND)
  const drawn = await texts(ui)

  expect(drawn).toContain('🧠 Fix login bug')
  await ui.unmount()
})

test('a long task is cut in the label', async ($, on) => {
  const task = 'Rewrite the onboarding flow for the new billing page'
  on('state.get', holding({ phase: 'focus', leftMs: 750_000, totalMs: 1_500_000, cycle: 1, rounds: 4, task }))
  nothingBelow(on)
  const ui = await $.ui.mount(BAND)

  expect(await texts(ui)).toContain('🧠 Rewrite the onboarding flow…')
  await ui.unmount()
})

test('a finished break says so and points to the next round', async ($, on) => {
  on('state.get', holding({ phase: 'over', cycle: 2, rounds: 4, today: 2 }))
  nothingBelow(on)
  const ui = await $.ui.mount(BAND)
  const drawn = await texts(ui)

  expect(drawn).toContain('🔔 break over')
  expect(drawn).toContain('/tamatem start')
  expect(drawn).toContain(' for round 3')
  await ui.unmount()
})

test('a finished break points to continue when there is a last task', async ($, on) => {
  on('state.get', holding({ phase: 'over', cycle: 2, rounds: 4, today: 2, task: 'Fix login' }))
  nothingBelow(on)
  const ui = await $.ui.mount(BAND)
  const drawn = await texts(ui)

  expect(drawn).toContain('/tamatem continue')
  expect(drawn).toContain(' on Fix login for round 3')
  await ui.unmount()
})

test('a long break has its own icon', async ($, on) => {
  on('state.get', holding({ phase: 'long', leftMs: 600_000, totalMs: 900_000, cycle: 4, rounds: 4 }))
  nothingBelow(on)
  const ui = await $.ui.mount(BAND)

  expect(await texts(ui)).toContain('🛌 long break')
  await ui.unmount()
})
