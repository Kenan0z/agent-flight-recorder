# Contributing

Bug reports and pull requests are welcome. Agent log formats change often, so a report that says "this record type broke" is useful even without a fix. **Please never paste a real transcript into an issue.** Describe the record's shape or anonymize it first.

## Setup

```bash
npm install
npm test
npm run demo
```

## How it fits together

```
agent logs -> parser -> Session (list of TraceEvents) -> analyze -> Analysis
                                                                     |-> web UI (server.ts)
                                                                     |-> HTML export (export.ts)
                                                                     '-> terminal report (report.ts)
```

| Path | Purpose |
| --- | --- |
| `src/parsers/` | One parser per agent, each turning logs into `TraceEvent`s |
| `src/analyze.ts` | Totals and the finding detectors |
| `src/pricing.ts` | Model price table |
| `src/redact.ts` | Secret and identity masking |
| `web/` | The UI: plain HTML, CSS and JavaScript with no build step |
| `scripts/make-demo.mjs` | Generates the invented demo sessions in `fixtures/demo` |

## Add an agent

1. Add `src/parsers/<agent>.ts` that returns a `Session`. `parsers/codex.ts` is a short example.
2. Register it in `src/discover.ts`, for both the log location and format detection.
3. Add a test with a small hand-written sample. Do not commit real transcripts.

Parsers must tolerate unknown record types and malformed lines, because agents add new ones without notice and a running agent may be mid-write. Attach `usage` once per API response, never once per log record.

## Add a detector

Add a function in `src/analyze.ts` that returns `Finding[]`, and call it from `analyze()`. Every finding must point at real events through `eventIds`. Write its title, detail and `advice` for someone who is not an expert: say what happened and what to do, without terms like "token" or "cache hit". Add a test showing it fires, and keep the "stay quiet on a clean session" test passing. A false alarm costs more trust than a missed finding helps, so prefer precise rules, and only set `wastedUsd` when the spend can really be attributed.

## Ground rules

- No runtime dependencies. This tool reads private transcripts, so its supply chain stays empty.
- No network calls, ever.
- The UI renders transcript text with `textContent` and never `innerHTML`.
