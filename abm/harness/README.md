# abm/harness/

The ABM's perception+decision+actuation mechanism — TypeScript/Node,
Playwright, runnable from the command line (not an interactive session).
See [`abm/experiments/guided-vs-unguided/definition.md`](../experiments/guided-vs-unguided/definition.md)
for what it's configured to do for the first experiment, and
[`contracts/abm-behavioral-events.contract.yaml`](../../contracts/abm-behavioral-events.contract.yaml)
for the event shape it produces.

## What's here vs. what's not

Everything in `src/` is generic — it works against any web application's
DOM/accessibility tree and has never seen a real target application's
code. It has exactly **two integration points**, both defined as the
`IntegrationModule` interface (`src/types.ts`):

- `authenticate(page, account)` — get to an authenticated session, on the
  journey's entry screen.
- `getJourneyState(page)` — determine `journey_stage`/`journey_completed`.

The **real, filled-in implementation of that module is never in this
repository.** `integration.example.js` is a template showing the shape;
copy it outside this repo (or to a gitignored local path) and point
`config.json`'s `integrationModulePath` at your copy. See the root
`AGENTS.md`'s confidentiality rule — this is exactly the boundary it
describes, made concrete as code.

## Running it

```bash
npm install
cp config.example.json config.local.json   # then edit config.local.json — gitignored, never commit it
npm run build
node dist/cli.js \
  --config config.local.json \
  --experiment guided-vs-unguided-v1 \
  --condition guided \
  --accounts accounts.local.json \
  --count 5 \
  --baseline
```

`accounts.local.json` (gitignored, never commit it): a JSON array of
`{ "identifier": "...", "sessionId": "..." }`, one per agent in the
population (baseline included if `--baseline` is passed) — provisioning
those accounts against a real target application is its own concern,
outside this package.

## Output

Events are appended as JSON Lines to `runs/<run-id>.jsonl`, matching the
contract. **Never commit anything under `runs/`** — it's real execution
data (real `screen`/`element` values from whatever application this was
pointed at), a different category from the design documents in this
repo. Already covered by `.gitignore`.

## Design notes

- **Sequential by default.** Every agent is independent (own account, own
  seeded RNG derived from `run_id`+`agent_id`, own output rows) —
  parallelism later is a concurrency-limit change in `cli.ts`, not a
  rearchitecture. See the epic's private planning notes for why
  sequential was chosen for the first pilot (rate-limit caution on the
  target STG environment).
- **No LLM judgment anywhere in `src/`.** `decision.ts` is an explicit,
  auditable formula (perceived salience × behavioral parameters →
  softmax) — see its comments for the exact mechanism and the open
  questions not yet settled by real data.
- **`explore`/`click`/`navigate`/`type` can all execute the same
  Playwright action** (a click or a fill) — they're labels for *why* the
  decision policy picked a target, not different physical mechanisms.
  See `decision.ts` / `actuation.ts`.
