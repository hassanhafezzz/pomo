export type PomoPhase = 'focus' | 'short' | 'long'

// What the band above the prompt draws: a block running, a focus block
// just done, or a break just over.
export type View =
  | { phase: PomoPhase; leftMs: number; totalMs: number; cycle: number; rounds: number; tip?: string; isPaused?: boolean; task?: string }
  | { phase: 'done'; cycle: number; rounds: number; tip?: string; breakMinutes: number; today: number; task?: string }
  | { phase: 'over'; cycle: number; rounds: number; today: number; task?: string }

declare module 'claude-code' {
  interface PluginState {
    tamatem: { view: Shaped<View | null> }
  }
}
