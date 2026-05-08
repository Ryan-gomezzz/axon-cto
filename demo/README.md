# Axon — Demo Kit

Tooling for the 90-second live demo. None of these files are part of a workspace package; they reuse `@axon/kg`, `@axon/shared`, and `@axon/incident` directly via the workspace links at the repo root.

All commands assume `cwd = repo root`.

---

## What's in here

| File | Purpose |
|---|---|
| [`fire-webhook.ts`](./fire-webhook.ts) | Stages a synthetic auth-service incident; fires it on keypress; tails the gateway log to print the actual time-to-first-Telegram. |
| [`stopwatch.html`](./stopwatch.html) | Standalone single-file stopwatch. Open in any browser, click to start/stop, `r` to reset. |
| [`kg-viz/index.html`](./kg-viz/index.html) | D3 force-directed graph of the live KG. Loads from `GET /demo/kg-snapshot` on the gateway. |
| [`add-skill.ts`](./add-skill.ts) | The "extensibility flex": `pnpm exec tsx demo/add-skill.ts standup` posts a KG-derived standup to Telegram in seconds. |

---

## The 90-second arc

```
  0:00  Brief                Morning brief is ALREADY on Telegram.
                             Run it manually before the demo:
                             pnpm exec tsx packages/brief/src/cli/run-now.ts

  0:05  Stopwatch            Click stopwatch.html → 00:00 starts.
                             "60-second SLA. Watch the clock."

  0:10  Fire webhook         Terminal: pnpm exec tsx demo/fire-webhook.ts
                             Press any key.

  0:30  Telegram alert       Alert lands in Telegram.
                             "Synthesized: causal chain + 3rd-incident pattern + open ADR."
                             Stopwatch < 60s.

  0:45  Rollback             Tap the [Rollback] button.
                             Bot replies with the issue URL.
                             Recovery monitor activates in the gateway log.

  1:00  Skill flex           Terminal: pnpm exec tsx demo/add-skill.ts standup
                             Standup lands in <5s.
                             "Adding a skill against the KG is trivial."

  1:15  KG viz               Open demo/kg-viz/index.html in a browser.
                             Drag a node. Narrate the moat:
                             "Typed nodes. Typed edges. Every alert grounds in this graph."

  1:30  Land                 "That's Axon. Five skills, one moat. Thanks."
```

---

## Pre-flight checklist (15 min before demo)

Do all of these on the demo laptop, in order. Don't trust mental cache; re-check.

- [ ] **Power & network** — laptop plugged in, on a known-good network. Tether ready as fallback.
- [ ] **Tokens & secrets** — `.env` at repo root contains real values for:
  - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (use the **demo** bot, not the dev bot)
  - `LLM_API_KEY` for Together.ai with credit available
  - `GITHUB_TOKEN` with `repo` scope on the staging org
  - `SENTRY_WEBHOOK_SECRET` (any value — the fire-webhook script uses the same one)
  - `LOG_FILE=./data/gateway.log` (so fire-webhook can read first-token timing)
- [ ] **KG seeded** — `pnpm seed` returns "52 nodes, 65 edges".
- [ ] **Gateway running** — in a terminal you'll keep visible:
  - `pnpm dev`
  - watch for `gateway listening` on the port in `.env` (default 3000; we use 3030 in this checkout because something else holds 3000)
  - watch for all three crons registered: `morning-brief`, `pr-digest`, `sprint-risk`
- [ ] **Pre-fired morning brief** — run `pnpm exec tsx packages/brief/src/cli/run-now.ts` once now so the brief is at the top of the Telegram chat at demo start. Verify the bullet list mentions auth-service.
- [ ] **Telegram open** — phone or second monitor showing the demo bot's chat. Notifications **on**.
- [ ] **Stopwatch open** — `demo/stopwatch.html` opened in a fresh browser tab, fullscreen, dimmed adjacent monitors so it's the only thing the audience sees.
- [ ] **kg-viz tab pre-loaded** — open `demo/kg-viz/index.html?src=http://localhost:3030/demo/kg-snapshot` once, confirm the graph renders, then leave the tab there. (Pre-loading avoids the "loading…" frame mid-demo.)
- [ ] **fire-webhook ready** — terminal pre-staged with `pnpm exec tsx demo/fire-webhook.ts`, **but not run yet**. The script will block on a keypress.
- [ ] **add-skill terminal** — second terminal pre-staged with `pnpm exec tsx demo/add-skill.ts standup`, not run yet.
- [ ] **Fallback video** — `demo/axon-demo.mp4` exists, plays end-to-end with sound, opens in <2s. If live demo collapses, the moderator cuts to the recording without missing the beat.
- [ ] **Dry run done** — full arc executed once in the last 30 minutes, finishing < 90s, with stopwatch < 60s on the alert.

---

## Recording the demo video

Spec calls for `demo/axon-demo.mp4` as the safety net if the live demo dies on stage.

How to record (do this once you have the live arc working end-to-end):

1. Capture screen + mic with **OBS** (or QuickTime on macOS, `xdg-screensaver`/Win+G on others).
2. Record at 1080p, 30 fps, system audio + mic.
3. Lay out two scenes: **Scene A** = stopwatch + Telegram side-by-side; **Scene B** = kg-viz fullscreen for the close.
4. Run the full arc from §"The 90-second arc". **Don't pause to explain — talk through it as you go.**
5. Stop capture. Watch back. If anything feels weak, re-record from §0:00.
6. Record **two takes**, keep the better one. Trim to <100s. Save as `demo/axon-demo.mp4` (H.264, AAC).
7. `git lfs track '*.mp4'` if the repo doesn't already; commit so the file ships with the deck.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `fire-webhook` exits "SENTRY_WEBHOOK_SECRET is required" | `.env` not loaded | Run from repo root, ensure `.env` exists. |
| Webhook returns `401 Unauthorized` | `SENTRY_WEBHOOK_SECRET` mismatch | Confirm the same value sits in both `.env` and the running gateway's process env (restart gateway after .env edits). |
| `fire-webhook` tail times out | gateway not writing to `LOG_FILE` | Set `LOG_FILE=./data/gateway.log` in `.env`, **restart the gateway**, retry. |
| Telegram alert never appears | bot token / chat id wrong | Send a test via `pnpm exec tsx demo/add-skill.ts standup`. If that fails, fix tokens before running fire-webhook. |
| kg-viz shows "load failed" | gateway port mismatch | Open `demo/kg-viz/index.html?src=http://localhost:<your-port>/demo/kg-snapshot`. |
| Alert lands but Rollback button does nothing | bot polling not started or no callback handler | Check gateway log for `polling_error`; confirm bot is set up for polling, not webhook mode. |

---

## What the demo proves (subtext)

1. **Proactive** — Axon pushed the brief at 8 AM IST without being asked.
2. **Synthesized** — the incident alert names a deploy SHA, an open ADR, and a recurring count, all in one paragraph. No raw signals.
3. **Autonomous** — silence between events; only escalates on threshold breaches.
4. **Moat** — the kg-viz at the close isn't decoration. It's the same typed graph every alert read from. That's why a generic LLM agent can't produce these sentences.
