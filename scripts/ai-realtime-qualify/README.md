# AI realtime qualification

A local harness that runs the real `apps/ai-gateway` Worker code (`src/worker-main.ts`, bundled with esbuild) in
workerd, with a fake Core and always-success ratelimit bindings, against the real orq realtime service. It exercises
the `GET /v1/realtime?model=xai/grok-voice-3.0` route end to end.

## Run

```sh
node scripts/ai-realtime-qualify/run.mjs            # one text turn, then a clean close (exit 0 when ok)
node scripts/ai-realtime-qualify/run.mjs --abrupt   # client drops the TCP socket after session.created
```

Requirements:

- `ORQ_API_KEY` must be set in the untracked `.env.local` of the checkout the harness runs in (override the file with
  `AI_RT_ENV_FILE`, for example from a clone). The harness reads that
  one line inside its own process and passes it to the gateway as an in-memory binding. It never logs, writes or
  passes the value on a command line.
- Each run makes real orq calls (one realtime upgrade, one short session, and the gateway's cost query), so it costs a
  few cents.
- Scratch output goes to `AI_RT_DIR`, default a directory under the system temp folder.
  Each run writes `gateway.mjs` (the bundle) and `core-calls.jsonl` (every fake Core call, one JSON line each) into a
  timestamped subdirectory.

The harness prints one JSON evidence object on stdout: event types in order (names only), whether binary frames were
seen, close codes, the trace id (a hex string, not a secret), the settled cost in nano-USD with `costRecorded` (true
when it is above zero), the settle input's model and usage keys, the number of settle and release calls, and elapsed
milliseconds. The cost is the one the gateway's own settle path obtained from orq telemetry; the harness queries
nothing itself. Worker logs go to stderr. Message contents and keys are never printed.

## What it proves

- The upgrade is answered 101 with the gateway's own checks (Bearer key, one `model` parameter, admission).
- Messages pass both ways: `session.created` arrives from orq, and a text turn produces `response.done`.
- Closing from the client closes the session with a sendable code, and one settlement runs.
- An abrupt TCP close after `session.created` still settles exactly once and releases nothing.

## What it does not prove

- The idle timer (60 s) and the session limit (5 min) are not triggered.
- The refusal path (orq failure before an upgrade) is not exercised.
- Telemetry-based cost is checked by `costRecorded`: the gateway sends its own W3C `traceparent` on the upgrade, orq
  records the session under that trace id, and the settle path polls telemetry after the session closed (5 attempts,
  2 s apart). A run with `costRecorded: false` means no cost was recorded inside that window.

## Harness notes

- Miniflare comes from the wrangler version that apps/ai-gateway uses (4.145.0), because the gateway's
  compatibility date needs a newer workerd than the root miniflare.
- The platform package is resolved through its `source` export condition, so no `dist` build is needed.
- Module paths are given as basenames. Absolute module paths under the scratch directory make workerd fail to start.
