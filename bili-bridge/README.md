# Companion Bilibili sources

A Host-only adapter, not another companion or discovery implementation.

- bili-scroll owns recommendation/search, deduplication and reports.
- humanism owns original reading evidence and private journals.
- This adapter reads only `out/YYYY-MM-DD.md` under its configured `sourceDir`.
  It does not read cookies, config, logs, or call the mutating `/watched` endpoint.
- Only already-bound companion agents receive scoped reading/decision tools and a
  small source index. Reports are untrusted discovery notes, not a transcript or
  proof that the companion has watched anything.
- Eligible discoveries can supply a generic proactive topic. The core's existing
  quiet hours, cooldown, pause, unanswered limit and daily cap still apply.
  Existing bound QQ agents are preferred. The bridge never sends OneBot/Bilibili
  messages itself, and never spawns a second persona.
- `companion_bili_decide(action=share)` records **intent**, not confirmed delivery.
  The companion includes title/link in its ordinary reply, delivered by its normal
  channel. Recorded intents are not automatically resent after ambiguous failure.
- The companion may deep-read with humanism and choose a worthwhile journal or
  private inner-diary entry. Neither is mandatory. Outer diary stays window-based.

Default source: `$DSH_HOME/bili-duty`; adapter-only decision state:
`$DSH_HOME/companion-bili-bridge/decisions.json`. Optional row config fields:
`sourceDir`, `stateDir`, `pollMs` (minimum 5000). No credentials in row config.

Read-only health: `GET /companion-bili/status` (source coverage, warnings, scoped
agents and a bounded recent title/link index). No private diary content.

## Limits

This does not repair upstream discovery budget/schedule bugs. Installed scroll
2.3.0 has prompt-only round quotas and inconsistent report persistence; automatic
runs must stay paused until a tested hard-budget/scheduling fix is adopted. Manual
runs remain user initiated. A report-only item is never relabelled as full viewing.

## Tests

`node --test bili-bridge/test/*.test.js` from the workspace project directory.
The icon is original inline SVG, authored for this adapter; no external assets.
