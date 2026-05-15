# AI Usage Ledger

Subscription-friendly bookkeeping for Codex and Claude Code usage.

This repo stores sanitized usage summaries only. It does not upload raw prompts,
responses, tool outputs, or full session logs.

## What It Tracks

- Codex session logs from `~/.codex/sessions/**/*.jsonl`
- Claude Code logs from `~/.claude/projects/**/*.jsonl`
- Daily totals by tool and device
- Session-level hashed IDs, dates, file sizes, event counts, and token totals

The numbers are token usage estimates from local tool logs. They are not API
bills and they are not official subscription counters.

## Accounting Rules

Codex is counted with the same token definitions as `@ccusage/codex`, but this
collector streams large session files instead of loading them whole.

For Codex:

```text
Input      = input_tokens - cached_input_tokens
Cache Read = cached_input_tokens
Output     = output_tokens
Reasoning  = reasoning_output_tokens, capped at output_tokens
Total      = total_tokens
```

Claude uses Claude Code usage fields:

```text
Input        = input_tokens
Cache Create = cache_creation_input_tokens
Cache Read   = cache_read_input_tokens
Output       = output_tokens
Total        = input + cache create + cache read + output
```

Claude assistant events are deduped globally by `uuid` or `requestId` because
the same usage event can appear in both project and subagent JSONL files.

Current generated device files include this accounting marker:

```json
{
  "codex": "ccusage-codex-compatible-streaming-v1",
  "claude": "claude-code-global-event-dedupe-v1"
}
```

If a device file does not have that marker, regenerate it with the latest
collector before trusting cross-device totals.

Do not add recovery logs such as `~/.codex/log/codex-tui.log`, SQLite logs, or
raw session files to this repo. They can contain recoverable conversation
material. This repo should only receive generated JSON stats in `data/devices/`
and `docs/data/ledger.json`.

## Use On This Machine

```bash
cd /home/victor/ai-usage-ledger
npm run collect -- --device linux-workstation
npm run dashboard
npm run report
```

That writes:

```text
data/devices/linux-workstation.json
```

## Use On Another Machine

Pull the latest parser first, then regenerate that machine's device file:

```bash
git clone https://github.com/Victor-wang-902/token_tracker.git
cd token_tracker
npm run collect -- --device DEVICE_NAME
npm run dashboard
npm run report

git add data/devices/DEVICE_NAME.json docs/data/ledger.json
git commit -m "update DEVICE_NAME usage"
git push
```

If the repo already exists on that machine:

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
`macbook`. The dashboard combines every JSON file in `data/devices/`.

## Commands

```bash
npm run doctor
npm run collect -- --device linux-workstation
npm run collect -- --device macbook --codex "$HOME/.codex/sessions" --no-claude
npm run collect -- --device macbook --claude "$HOME/.claude/projects" --no-codex
npm run dashboard
npm run report
```

## Dashboard

The simplest hosted dashboard is GitHub Pages from the `docs/` directory.

After collecting usage:

```bash
npm run dashboard
git add data/devices docs/data/ledger.json
git commit -m "update usage dashboard"
git push
```

Then enable GitHub Pages for the repository:

```text
Settings -> Pages -> Deploy from branch -> main -> /docs
```

The dashboard will be available at:

```text
https://victor-wang-902.github.io/token_tracker/
```

## GitHub Setup

The public GitHub Pages dashboard is generated from `docs/`. Keep raw logs out
of Git. Only generated stats should be pushed.
