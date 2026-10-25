# Pomo

A Pomodoro timer for Claude Code. Start a focus block with `/pomo start`, keep working, and a subtle band above the prompt shows the time left and your rounds. When a block ends you get a small toast, a break idea, and a tomato for the day.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ 🧠 fix login bug   ████████████████████▌░░░░░░░░░░░░░░░░░░░░  12:30  ● ◐ ○ ○ │
╰──────────────────────────────────────────────────────────────────────────────╯
```

No colours and no blinking: it sits at the edge of your attention while the work has the focus.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pomo --marketplace hassanhafezzz/pomo
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). It's active straight away, with no restart.

From a shell:

```
claude plugin install pomo --marketplace hassanhafezzz/pomo
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `hassanhafezzz/pomo`, then **Add plugin**.

## What it looks like

A focus block, halfway through. The round dots show it's the second of four:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ 🧠 fix login bug   ████████████████████▌░░░░░░░░░░░░░░░░░░░░  12:30  ● ◐ ○ ○ │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Paused, with the clock frozen:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ⏸ fix login bug   ██████████████████████████▉░░░░░░░░░░░░░░░  09:00  ● ◐ ○ ○ │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The block is done. The band keeps the next step first, then the day's tomatoes and a break idea:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ 🔔 fix login bug done   ████████████████████████████████████  ● ● ○ ○        │
│ today 🍅🍅🍅  ·  /pomo break for 5 min  ·  Stand up and stretch.             │
╰──────────────────────────────────────────────────────────────────────────────╯
```

On a break, with the idea underneath:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ☕ short break  ██████████████▋░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  03:20  ● ● ○ ○ │
│ Stand up and stretch.                                                        │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The break is over, and the next round is waiting:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ 🔔 break over   ████████████████████████████████████████████  ● ● ○ ○        │
│ today 🍅🍅🍅  ·  /pomo start for round 3                                     │
╰──────────────────────────────────────────────────────────────────────────────╯
```

After the fourth round, the break is a long one:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ 🛌 long break   ██████████████▋░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  10:00  ● ● ● ● │
│ It's time for a short walk.                                                  │
╰──────────────────────────────────────────────────────────────────────────────╯
```

When a block ends, a short toast says what finished and what to do next:

```
🔔 fix login bug done · /pomo break for 5 min
```

### In the chat

```
/pomo start 25 fix login bug
🧠 focus started: 25 min · fix login bug

/pomo pause
⏸ Paused the focus with 09:00 left. /pomo resume to carry on.

/pomo strat
Unknown: /pomo strat. Did you mean /pomo start?

/pomo stats
📊 Focus
Today:        3 🍅 · 1h 15m focused
This week:   11 🍅 · 4h 35m focused
This month:  38 🍅 · 15h 50m focused
This year:  212 🍅 · 88h 20m focused
All time:   212 🍅 · 88h 20m focused

🎯 Today's tasks
  fix login bug · 2 🍅 · 50 min
  write the docs · 1 🍅 · 25 min
```

## Use it

```
/pomo start                    a 25-minute focus block
/pomo start fix login bug      the same, named for what you're doing
/pomo start 50 write the docs  50 minutes, named
/pomo break                    a break: short, or long after every 4th round
/pomo pause                    pause the block; again (or /pomo resume) to carry on
/pomo stop                     stop the block, or clear the band once it's done
/pomo                          where you are, and today's stats
```

A first word that's a number is the minutes; the rest names the task.

### The band

| You see | It means |
| --- | --- |
| `🧠 focus` or `🧠 <task>` | a focus block is running |
| `☕ short break`, `🛌 long break` | a break is running, with an idea for it underneath |
| `⏸` | the block is paused |
| `🔔 … done`, `🔔 break over` | a block just ended, with the next command to run |
| `● ◐ ○ ○` | rounds: ● a focus block done, ◐ the one running, ○ one to come. When all are ●, the long break is due |

The band shows in the terminal and in the desktop app. Claude Code doesn't offer that space in VS Code or on mobile, so there you'll get the toast and `/pomo`.

### Stats

```
/pomo stats                  today, this week, month, year and all time, plus today's tasks
/pomo stats reset            shows what would be deleted
/pomo stats reset confirm    deletes every count
```

`/pomo history` works the same as `/pomo stats`.

### Settings

```
/pomo set                    show the current lengths
/pomo set focus 30           focus 1-180 min, short 1-60, long 1-120, rounds 1-12
/pomo set reset              back to 25 / 5 / 15, 4 rounds
/pomo toast on|off           a pop-up when a block ends (on by default)
/pomo sound on|off           a soft chime when a block ends (off by default, macOS only)
/pomo help                   every command
```

## Your data

Everything stays on your machine, in pomo's own store under your Claude Code configuration folder: the running timer, your settings, and a count of focus blocks per day (with task names, if you give them). Days more than a year old are merged into an all-time total and their task names dropped, so the store stays small. pomo makes no network calls.

A block keeps running across restarts. One that ended while Claude Code was closed is counted and reported as "while you were away".

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```


## License

[MIT](LICENSE)
