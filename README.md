# AI Usage Ledger

Private, subscription-friendly bookkeeping for Codex and Claude Code usage.

This repo stores sanitized usage summaries only. It does not upload raw prompts,
responses, tool outputs, or full session logs.

## What It Tracks

- Codex session logs from `~/.codex/sessions/**/*.jsonl`
- Claude Code logs from `~/.claude/projects/**/*.jsonl`
- Daily totals by tool and device
- Session-level hashed IDs for deduping and auditing

The numbers are token usage estimates from local tool logs. They are not API
bills and they are not official subscription counters.

## Use On This Machine

```bash
cd /home/victor/ai-usage-ledger
npm run collect -- --device linux-workstation
npm run report
```

That writes:

```text
data/devices/linux-workstation.json
```

## Use On Another Machine

Clone the private GitHub repo there, then run:

```bash
cd ai-usage-ledger
node ./src/ai-usage-ledger.mjs collect \
  --device macbook \
  --codex "$HOME/.codex/sessions" \
  --claude "$HOME/.claude/projects"

git add data/devices/macbook.json
git commit -m "update macbook usage"
git push
```

Back on any machine:

```bash
git pull
npm run report
```

## Commands

```bash
npm run doctor
npm run collect -- --device linux-workstation
npm run collect -- --device macbook --codex "$HOME/.codex/sessions" --no-claude
npm run collect -- --device macbook --claude "$HOME/.claude/projects" --no-codex
npm run report
```

## GitHub Setup

If GitHub CLI is installed and authenticated, create a private repo however you
prefer. If not, create an empty private repo in the GitHub web UI named
`ai-usage-ledger`, then from this folder:

```bash
git init -b main
git add .
git commit -m "initial usage ledger"
git remote add origin git@github.com:YOUR_USER/ai-usage-ledger.git
git push -u origin main
```
