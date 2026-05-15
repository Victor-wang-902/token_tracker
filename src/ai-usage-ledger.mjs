#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";

const USAGE_KEYS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

const DEFAULT_TIMEZONE = process.env.TZ || "America/New_York";
const ACCOUNTING = {
  codex: "ccusage-codex-compatible-streaming-v1",
  claude: "claude-code-global-event-dedupe-v1",
};

function usage() {
  console.log(`usage:
  ai-usage-ledger doctor
  ai-usage-ledger collect [--device NAME] [--codex PATH] [--claude PATH] [--out data/devices] [--sessions]
  ai-usage-ledger report [--data data/devices]

examples:
  ai-usage-ledger collect --device linux-workstation
  ai-usage-ledger collect --device macbook --codex "$HOME/.codex/sessions" --claude "$HOME/.claude/projects"
  ai-usage-ledger report`);
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      result._.push(arg);
      continue;
    }
    if (arg.startsWith("--no-")) {
      result[arg.slice(5)] = false;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      result[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function zeroUsage() {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

function componentTotal(source) {
  return USAGE_KEYS.reduce((sum, key) => sum + (Number(source?.[key]) || 0), 0);
}

function addUsage(target, source) {
  for (const key of USAGE_KEYS) {
    target[key] += Number(source?.[key]) || 0;
  }
}

function subtractUsage(current, previous) {
  if (!previous) return current;
  if ((current.total_tokens || 0) < (previous.total_tokens || 0)) return current;
  const delta = zeroUsage();
  for (const key of USAGE_KEYS) {
    delta[key] = Math.max((current[key] || 0) - (previous[key] || 0), 0);
  }
  return delta;
}

function normalizeCodexUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = Number(raw.input_tokens) || 0;
  const cacheRead = Number(raw.cached_input_tokens ?? raw.cache_read_input_tokens) || 0;
  const output = Number(raw.output_tokens) || 0;
  const reasoning = Number(raw.reasoning_output_tokens) || 0;
  const total = Number(raw.total_tokens) || input + output;
  return {
    input_tokens: input,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  };
}

function normalizeCodexRawUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = Number(raw.input_tokens) || 0;
  const cacheRead = Number(raw.cached_input_tokens ?? raw.cache_read_input_tokens) || 0;
  const output = Number(raw.output_tokens) || 0;
  const reasoning = Number(raw.reasoning_output_tokens) || 0;
  const total = Number(raw.total_tokens) || input + output;
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  };
}

function subtractCodexRawUsage(current, previous) {
  return {
    input_tokens: Math.max(current.input_tokens - (previous?.input_tokens || 0), 0),
    cached_input_tokens: Math.max(current.cached_input_tokens - (previous?.cached_input_tokens || 0), 0),
    output_tokens: Math.max(current.output_tokens - (previous?.output_tokens || 0), 0),
    reasoning_output_tokens: Math.max(current.reasoning_output_tokens - (previous?.reasoning_output_tokens || 0), 0),
    total_tokens: Math.max(current.total_tokens - (previous?.total_tokens || 0), 0),
  };
}

function convertCodexRawUsage(raw) {
  const cacheRead = Math.min(raw.cached_input_tokens || 0, raw.input_tokens || 0);
  return {
    input_tokens: Math.max((raw.input_tokens || 0) - cacheRead, 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
    output_tokens: raw.output_tokens || 0,
    reasoning_output_tokens: Math.max(0, Math.min(raw.reasoning_output_tokens || 0, raw.output_tokens || 0)),
    total_tokens: raw.total_tokens || (raw.input_tokens || 0) + (raw.output_tokens || 0),
  };
}

function normalizeClaudeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = Number(raw.input_tokens) || 0;
  const cacheCreation = Number(raw.cache_creation_input_tokens) || 0;
  const cacheRead = Number(raw.cache_read_input_tokens) || 0;
  const output = Number(raw.output_tokens) || 0;
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + cacheCreation + cacheRead + output,
  };
}

function makeDayFormatter(timezone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function makeDateTimeFormatter(timezone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
}

function dayKey(timestamp, formatter) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function timeParts(timestamp, formatter) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour: Number.isFinite(hour) ? hour : 0,
  };
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function slug(value) {
  return String(value || "device")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "device";
}

async function exists(target) {
  try {
    await fs.promises.access(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function* walkJsonl(root) {
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonl(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield fullPath;
    }
  }
}

function addDaily(daily, date, tool, usageDelta, events = 0, sessions = 0) {
  const key = `${date}\t${tool}`;
  if (!daily.has(key)) {
    daily.set(key, {
      date,
      tool,
      ...zeroUsage(),
      events: 0,
      sessions: 0,
      devices: 0,
    });
  }
  const row = daily.get(key);
  addUsage(row, usageDelta);
  row.events += events;
  row.sessions += sessions;
}

function addHourly(hourly, timestamp, tool, usageDelta, formatter, events = 0) {
  const parts = timeParts(timestamp, formatter);
  if (!parts) return;
  mergeHourly(hourly, {
    ...parts,
    tool,
    ...usageDelta,
    events,
  });
}

function mergeHourly(hourly, source) {
  const key = `${source.date}\t${source.hour}\t${source.tool}`;
  if (!hourly.has(key)) {
    hourly.set(key, {
      date: source.date,
      weekday: source.weekday,
      hour: source.hour,
      tool: source.tool,
      ...zeroUsage(),
      events: 0,
    });
  }
  const row = hourly.get(key);
  addUsage(row, source);
  row.events += Number(source.events) || 0;
}

function addModel(models, tool, model, usageDelta, events = 0) {
  const safeModel = model || "unknown";
  const key = `${tool}\t${safeModel}`;
  if (!models.has(key)) {
    models.set(key, {
      tool,
      model: safeModel,
      ...zeroUsage(),
      events: 0,
    });
  }
  const row = models.get(key);
  addUsage(row, usageDelta);
  row.events += events;
}

function sortedDailyRows(daily) {
  return Array.from(daily.values()).sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    return byDate || a.tool.localeCompare(b.tool);
  });
}

function buildTotalFromDaily(rows) {
  const totals = new Map();
  for (const row of rows) {
    if (!totals.has(row.tool)) {
      totals.set(row.tool, {
        tool: row.tool,
        ...zeroUsage(),
        events: 0,
        sessions: 0,
      });
    }
    const total = totals.get(row.tool);
    addUsage(total, row);
    total.events += row.events || 0;
    total.sessions += row.sessions || 0;
  }
  return Array.from(totals.values()).sort((a, b) => a.tool.localeCompare(b.tool));
}

function sortedHourlyRows(hourly) {
  return Array.from(hourly.values()).sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    if (byDate) return byDate;
    return a.hour - b.hour || a.tool.localeCompare(b.tool);
  });
}

function sortedModelRows(models) {
  return Array.from(models.values()).sort((a, b) => {
    return b.total_tokens - a.total_tokens || a.tool.localeCompare(b.tool) || a.model.localeCompare(b.model);
  });
}

async function readJsonlLines(file, onLine) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line) await onLine(line);
  }
}

async function collectCodex(root, timezone) {
  const formatter = makeDayFormatter(timezone);
  const timeFormatter = makeDateTimeFormatter(timezone);
  const daily = new Map();
  const hourly = new Map();
  const modelTotals = new Map();
  const sessions = [];
  let filesScanned = 0;

  for await (const file of walkJsonl(root)) {
    filesScanned += 1;
    const relative = path.relative(root, file).split(path.sep).join("/");
    const stat = await fs.promises.stat(file);
    const sessionDaily = new Map();
    const sessionTotal = zeroUsage();
    const models = new Set();
    let previousTotal = null;
    let currentModel = null;
    let firstActivity = null;
    let lastActivity = null;
    let events = 0;

    await readJsonlLines(file, async (line) => {
      if (!line.includes('"token_count"') && !line.includes('"turn_context"')) return;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (entry.type === "turn_context") {
        const model = entry?.payload?.model || entry?.payload?.info?.model || entry?.payload?.info?.model_name;
        if (model) currentModel = String(model);
        return;
      }
      if (entry.type !== "event_msg" || entry?.payload?.type !== "token_count") return;
      const timestamp = entry.timestamp;
      const info = entry?.payload?.info || {};
      const lastUsage = normalizeCodexRawUsage(info.last_token_usage);
      const totalUsage = normalizeCodexRawUsage(info.total_token_usage);
      let rawDelta = lastUsage;
      if (!rawDelta && totalUsage) rawDelta = subtractCodexRawUsage(totalUsage, previousTotal);
      if (totalUsage) previousTotal = totalUsage;
      if (!timestamp || !rawDelta) return;
      const delta = convertCodexRawUsage(rawDelta);

      const model =
        info.model ||
        info.model_name ||
        info.metadata?.model ||
        entry?.payload?.model ||
        currentModel ||
        "gpt-5";
      if (model) models.add(String(model));

      if ((delta.total_tokens || 0) === 0) return;

      const date = dayKey(timestamp, formatter);
      if (!date) return;
      events += 1;
      firstActivity ||= timestamp;
      lastActivity = timestamp;
      addUsage(sessionTotal, delta);
      addDaily(sessionDaily, date, "codex", delta, 1, 0);
      addHourly(hourly, timestamp, "codex", delta, timeFormatter, 1);
      addModel(modelTotals, "codex", String(model), delta, 1);
    });

    if ((sessionTotal.total_tokens || 0) === 0) continue;

    for (const row of sessionDaily.values()) {
      addDaily(daily, row.date, "codex", row, row.events, 1);
    }

    sessions.push({
      tool: "codex",
      session_hash: hash(`codex:${relative}`),
      model: models.size === 0 ? "unknown" : models.size === 1 ? Array.from(models)[0] : "mixed",
      first_activity: firstActivity,
      last_activity: lastActivity,
      file_size_bytes: stat.size,
      events,
      active_days: sessionDaily.size,
      component_total_tokens: componentTotal(sessionTotal),
      total: sessionTotal,
      days: sortedDailyRows(sessionDaily).map(({ devices, ...row }) => row),
    });
  }

  return {
    source: {
      tool: "codex",
      files_scanned: filesScanned,
      sessions_with_usage: sessions.length,
    },
    daily,
    hourly,
    models: modelTotals,
    sessions,
  };
}

async function collectClaude(root, timezone) {
  const formatter = makeDayFormatter(timezone);
  const timeFormatter = makeDateTimeFormatter(timezone);
  const daily = new Map();
  const hourly = new Map();
  const modelTotals = new Map();
  const sessions = [];
  const seenEvents = new Set();
  let filesScanned = 0;

  for await (const file of walkJsonl(root)) {
    filesScanned += 1;
    const relative = path.relative(root, file).split(path.sep).join("/");
    const stat = await fs.promises.stat(file);
    const sessionDaily = new Map();
    const sessionTotal = zeroUsage();
    const models = new Set();
    let firstActivity = null;
    let lastActivity = null;
    let events = 0;

    await readJsonlLines(file, async (line) => {
      if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) return;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      if (entry.type !== "assistant") return;
      const usage = normalizeClaudeUsage(entry?.message?.usage);
      if (!usage || (usage.total_tokens || 0) === 0) return;
      const timestamp = entry.timestamp;
      const date = dayKey(timestamp, formatter);
      if (!date) return;

      const eventId = entry.uuid || entry.requestId;
      if (eventId) {
        const dedupeKey = `claude:${eventId}`;
        if (seenEvents.has(dedupeKey)) return;
        seenEvents.add(dedupeKey);
      }

      const model = entry?.message?.model;
      if (model) models.add(String(model));

      events += 1;
      firstActivity ||= timestamp;
      lastActivity = timestamp;
      addUsage(sessionTotal, usage);
      addDaily(sessionDaily, date, "claude", usage, 1, 0);
      addHourly(hourly, timestamp, "claude", usage, timeFormatter, 1);
      addModel(modelTotals, "claude", String(model || "unknown"), usage, 1);
    });

    if ((sessionTotal.total_tokens || 0) === 0) continue;

    for (const row of sessionDaily.values()) {
      addDaily(daily, row.date, "claude", row, row.events, 1);
    }

    sessions.push({
      tool: "claude",
      session_hash: hash(`claude:${relative}`),
      model: models.size === 0 ? "unknown" : models.size === 1 ? Array.from(models)[0] : "mixed",
      first_activity: firstActivity,
      last_activity: lastActivity,
      file_size_bytes: stat.size,
      events,
      active_days: sessionDaily.size,
      component_total_tokens: componentTotal(sessionTotal),
      total: sessionTotal,
      days: sortedDailyRows(sessionDaily).map(({ devices, ...row }) => row),
    });
  }

  return {
    source: {
      tool: "claude",
      files_scanned: filesScanned,
      sessions_with_usage: sessions.length,
    },
    daily,
    hourly,
    models: modelTotals,
    sessions,
  };
}

async function collectCommand(options) {
  const device = options.device || os.hostname();
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const includeSessions = Boolean(options.sessions);
  const outDir = path.resolve(options.out || "data/devices");
  const codexRoot = options.codex === false ? null : path.resolve(String(options.codex || path.join(os.homedir(), ".codex", "sessions")));
  const claudeRoot = options.claude === false ? null : path.resolve(String(options.claude || path.join(os.homedir(), ".claude", "projects")));

  const sources = [];
  const allDaily = new Map();
  const allHourly = new Map();
  const allModels = new Map();
  const sessions = [];

  if (codexRoot && await exists(codexRoot)) {
    const codex = await collectCodex(codexRoot, timezone);
    sources.push(codex.source);
    for (const row of codex.daily.values()) addDaily(allDaily, row.date, row.tool, row, row.events, row.sessions);
    for (const row of codex.hourly.values()) mergeHourly(allHourly, row);
    for (const row of codex.models.values()) addModel(allModels, row.tool, row.model, row, row.events);
    sessions.push(...codex.sessions);
  }

  if (claudeRoot && await exists(claudeRoot)) {
    const claude = await collectClaude(claudeRoot, timezone);
    sources.push(claude.source);
    for (const row of claude.daily.values()) addDaily(allDaily, row.date, row.tool, row, row.events, row.sessions);
    for (const row of claude.hourly.values()) mergeHourly(allHourly, row);
    for (const row of claude.models.values()) addModel(allModels, row.tool, row.model, row, row.events);
    sessions.push(...claude.sessions);
  }

  const daily = sortedDailyRows(allDaily).map(({ devices, ...row }) => row);
  const hourly = sortedHourlyRows(allHourly);
  const models = sortedModelRows(allModels);
  const totals = buildTotalFromDaily(daily);
  const output = {
    schema_version: 1,
    accounting: ACCOUNTING,
    generated_at: new Date().toISOString(),
    device,
    timezone,
    sources,
    daily,
    hourly,
    models,
    totals,
    sessions: includeSessions
      ? sessions.sort((a, b) => {
          const left = `${a.tool}:${a.first_activity || ""}:${a.session_hash}`;
          const right = `${b.tool}:${b.first_activity || ""}:${b.session_hash}`;
          return left.localeCompare(right);
        })
      : [],
  };

  await fs.promises.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${slug(device)}.json`);
  await fs.promises.writeFile(outFile, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
  printRows(daily, totals, { includeDevices: false });
}

async function reportCommand(options) {
  const dataDir = path.resolve(options.data || "data/devices");
  let entries;
  try {
    entries = await fs.promises.readdir(dataDir, { withFileTypes: true });
  } catch {
    console.error(`no data directory found: ${dataDir}`);
    process.exit(1);
  }

  const daily = new Map();
  const devicesByRow = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dataDir, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
    } catch (error) {
      console.error(`skipping unreadable json: ${file}: ${error.message}`);
      continue;
    }
    const device = parsed.device || entry.name.replace(/\.json$/i, "");
    for (const row of parsed.daily || []) {
      addDaily(daily, row.date, row.tool, row, row.events || 0, row.sessions || 0);
      const key = `${row.date}\t${row.tool}`;
      if (!devicesByRow.has(key)) devicesByRow.set(key, new Set());
      devicesByRow.get(key).add(device);
    }
  }

  for (const [key, devices] of devicesByRow.entries()) {
    if (daily.has(key)) daily.get(key).devices = devices.size;
  }

  const rows = sortedDailyRows(daily);
  const totals = buildTotalFromDaily(rows);
  printRows(rows, totals, { includeDevices: true });
}

async function doctorCommand(options) {
  const codexRoot = path.resolve(String(options.codex || path.join(os.homedir(), ".codex", "sessions")));
  const claudeRoot = path.resolve(String(options.claude || path.join(os.homedir(), ".claude", "projects")));
  const checks = [
    ["codex", codexRoot],
    ["claude", claudeRoot],
  ];
  for (const [tool, target] of checks) {
    let count = 0;
    if (await exists(target)) {
      for await (const _file of walkJsonl(target)) count += 1;
      console.log(`${tool}: found ${count} jsonl files`);
    } else {
      console.log(`${tool}: not found at ${target}`);
    }
  }
}

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(Number(n) || 0);
}

function printRows(rows, totals, { includeDevices }) {
  const header = [
    "Date",
    "Tool",
    "Input",
    "CacheCreate",
    "CacheRead",
    "Output",
    "Reasoning",
    "Total",
    "Sessions",
    "Events",
  ];
  if (includeDevices) header.push("Devices");

  const table = [header];
  for (const row of rows) {
    const values = [
      row.date,
      row.tool,
      fmt(row.input_tokens),
      fmt(row.cache_creation_input_tokens),
      fmt(row.cache_read_input_tokens),
      fmt(row.output_tokens),
      fmt(row.reasoning_output_tokens),
      fmt(row.total_tokens),
      fmt(row.sessions),
      fmt(row.events),
    ];
    if (includeDevices) values.push(fmt(row.devices));
    table.push(values);
  }

  for (const total of totals) {
    const values = [
      "TOTAL",
      total.tool,
      fmt(total.input_tokens),
      fmt(total.cache_creation_input_tokens),
      fmt(total.cache_read_input_tokens),
      fmt(total.output_tokens),
      fmt(total.reasoning_output_tokens),
      fmt(total.total_tokens),
      fmt(total.sessions),
      fmt(total.events),
    ];
    if (includeDevices) values.push("");
    table.push(values);
  }

  const combined = zeroUsage();
  let sessions = 0;
  let events = 0;
  for (const total of totals) {
    addUsage(combined, total);
    sessions += total.sessions || 0;
    events += total.events || 0;
  }
  const both = [
    "TOTAL",
    "all",
    fmt(combined.input_tokens),
    fmt(combined.cache_creation_input_tokens),
    fmt(combined.cache_read_input_tokens),
    fmt(combined.output_tokens),
    fmt(combined.reasoning_output_tokens),
    fmt(combined.total_tokens),
    fmt(sessions),
    fmt(events),
  ];
  if (includeDevices) both.push("");
  table.push(both);

  const widths = table[0].map((_, col) => Math.max(...table.map((row) => String(row[col]).length)));
  for (const row of table) {
    console.log(row.map((cell, col) => String(cell).padStart(widths[col])).join("  "));
  }
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "help";

try {
  if (command === "collect") {
    await collectCommand(args);
  } else if (command === "report") {
    await reportCommand(args);
  } else if (command === "doctor") {
    await doctorCommand(args);
  } else {
    usage();
    process.exit(command === "help" || command === "--help" ? 0 : 2);
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
