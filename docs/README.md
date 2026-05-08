# Axon — Documentation

Deeper reading after the [front-page README](../README.md).

[CLAUDE.md](../CLAUDE.md) at the repo root remains the single source of truth for schema, model strings, and locked-in conventions. The pages here explain *why*; CLAUDE.md states *what*.

---

## Index

| Page | When to read it |
|---|---|
| [architecture.md](architecture.md) | First. Before anything else. The four layers + how a request actually flows through them. |
| [knowledge-graph.md](knowledge-graph.md) | When you're about to write a query, or when you want to understand the moat. |
| [skills.md](skills.md) | When you want to know what the brief / incident / pr / sprint package actually does. |
| [operations.md](operations.md) | When the gateway won't boot, env vars confuse you, or you need to know what's logged where. |
| [extending.md](extending.md) | When you want to add a fifth skill. |
| [decisions.md](decisions.md) | When you're tempted to question a choice that "looks weird" — most of them are documented. |

---

## How the docs relate to other files

```
README.md           Pitch + quick start + repo layout         (1-page front door)
demo/README.md      90-second arc + preflight + recording     (presenter playbook)
CLAUDE.md           Schema + conventions + locked choices     (project memory)
prompts.md          The 8 phase prompts that built this       (reproducibility receipt)
docs/*.md           Architecture + the "why" log              (this directory)
```

If you're a judge or new contributor: skim the README, then `architecture.md`, then `knowledge-graph.md`. Forty-five minutes.

If you're the presenter on demo day: skim the README, then `demo/README.md`. Twenty minutes plus the dry run.

If you're the maintainer six months from now: open `decisions.md` first, then whichever page matches the change you're about to make.
