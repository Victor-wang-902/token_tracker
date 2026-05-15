# Dashboard

The dashboard is a static GitHub Pages site in `docs/`.

Expected URL:

```text
https://victor-wang-902.github.io/token_tracker/
```

## Update Flow

Run this on each machine that has local Codex or Claude history:

```bash
cd token_tracker
git pull
npm run collect -- --device DEVICE_NAME
npm run dashboard
npm run report
git add data/devices/DEVICE_NAME.json docs/data/ledger.json
git commit -m "update DEVICE_NAME usage"
git push
```

Use stable device names such as `linux-workstation`, `scc-cluster`, or
`macbook`.

## Accounting

Codex uses the same displayed token definitions as `@ccusage/codex`, but the
collector streams large JSONL files so oversized sessions are counted.

```text
Input      = input_tokens - cached_input_tokens
Cache Read = cached_input_tokens
Output     = output_tokens
Reasoning  = reasoning_output_tokens capped at output_tokens
Total      = total_tokens
```

Claude usage is deduped globally by event id before aggregation.

## Privacy

Do not commit raw `~/.codex`, `~/.claude`, recovery logs, SQLite logs, prompts,
responses, or transcript content. The dashboard should only publish generated
stats files from `data/devices/` and `docs/data/ledger.json`.
