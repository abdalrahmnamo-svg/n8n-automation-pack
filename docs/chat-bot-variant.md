# Optional variant: chat-bot trigger for Schedule Ingest

The shipped `workflows/schedule-ingest.json` starts from a **Webhook** node (Header Auth), so it
runs with nothing but this repo. In the original design a chat-bot account posted the weekly roster.
You can recreate that by replacing the Webhook node with a bot trigger in your own n8n instance.
This is **not** shipped as JSON, because bot tokens and chat ids are exactly what must not be exported.

## Flow

| Step | Channel |
| --- | --- |
| Submit roster | chat message from a phone (e.g. on Saturday) |
| Review the draft and fix names | admin UI backed by the records API |
| Publish | admin UI, one button |
| Confirm | bot reply |

The bot never publishes directly. It only creates a **draft** that a human reviews.

## Setup notes

1. Create a bot with your chat platform's bot-creation flow and keep the token in n8n's credential store only
   (never in a workflow file, never in git).
2. In n8n, delete the Webhook node, add the platform's trigger node, and connect it to `Parse roster`.
   The trigger's message text must end up in `rawText`; add a Set node mapping the message text to
   `{ "rawText": "<text>" }` if needed.
3. Optionally add a reply node after `Submit schedule draft` that confirms the draft in the same chat.
4. Re-export with care. Run `npm run check-workflows` on the export: it will (correctly) reject a
   vendor trigger node, credential ids, and pinned data. Keep such a variant out of `workflows/`.

## Roster text format the `Parse roster` node understands

```
Week 2026-06-07
Agent Alpha: Sun-Thu 09:00-16:00, Fri-Sat off
Agent Bravo: Sun-Wed 11:00-19:00, Thu 09:00-17:00, Fri-Sat off
```

- `Week YYYY-MM-DD` sets the week start (a Sunday).
- Day ranges expand into one dated row per day; `off` marks a day off.
- Times are 24h `HH:mm`. The mock API enforces a 09:00-20:00 team window.
- Anything the parser cannot read is returned in `unparsed` instead of being guessed.
