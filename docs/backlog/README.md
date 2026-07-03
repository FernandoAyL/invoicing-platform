# Backlog

Planned work and the pipeline it moves through. Tasks are grouped into phases in
[`TODO.md`](./TODO.md) with an ID prefixed by phase (`0000x`, `1000x`, `2000x`,
`3000x`).

## Lanes

Each file is one lane of a dev → QA → review pipeline:

| File | Lane | Marker |
|------|------|--------|
| [`TODO.md`](./TODO.md) | Backlog + rework | `☐` |
| [`TOTEST.md`](./TOTEST.md) | Implemented, awaiting QA | `☐` |
| [`TOCODEREVIEW.md`](./TOCODEREVIEW.md) | Passed QA, awaiting code review | `☐` |
| [`DONE.md`](./DONE.md) | Reviewed and approved | `☑` |

```
TODO ──► TOTEST ──► TOCODEREVIEW ──► DONE
 ▲          │             │
 └──────────┴─────────────┘
    (QA / review reject)
```

A task keeps its ID as it moves. On a QA or review rejection it returns to
`TODO.md` with the findings attached as a sub-bullet.

## Who moves what

The lanes are driven by the agents in [`.claude/agents/`](../../.claude/agents/),
orchestrated by the **planner** (shared state in `.claude/agents/state.json`):

- **planner** — picks the next task, writes a plan, dispatches the workers, and
  owns every queue move except the first.
- **developer** — implements one task and moves it `TODO → TOTEST`.
- **qa** — verifies it end-to-end; the planner then moves it to `TOCODEREVIEW`
  (pass) or back to `TODO` (fail).
- **code-reviewer** — final sign-off; the planner moves it to `DONE` (approve)
  or back to `TODO` (reject).

Only the developer moves a bullet out of `TODO`; the planner owns all other
transitions. A bullet never lives in two lanes at once.
