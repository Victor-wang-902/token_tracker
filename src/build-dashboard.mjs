#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE_KEYS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

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

function addUsage(target, source) {
  for (const key of USAGE_KEYS) {
    target[key] += Number(source?.[key]) || 0;
  }
}

async function readDeviceFiles(dataDir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dataDir, { withFileTypes: true });
  } catch {
    throw new Error(`No device data directory found: ${dataDir}`);
  }

  const devices = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dataDir, entry.name);
    const parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
    devices.push({
      file,
      device: parsed.device || entry.name.replace(/\.json$/i, ""),
      accounting: parsed.accounting || null,
      generated_at: parsed.generated_at || null,
      sources: parsed.sources || [],
      daily: parsed.daily || [],
      hourly: parsed.hourly || [],
      models: parsed.models || [],
      totals: parsed.totals || [],
      sessions: parsed.sessions || [],
    });
  }
  return devices;
}

function buildLedger(devices) {
  const daily = new Map();
  const hourly = new Map();
  const models = new Map();
  const sessions = [];
  const deviceSets = new Map();

  for (const device of devices) {
    for (const row of device.daily) {
      const key = `${row.date}\t${row.tool}`;
      if (!daily.has(key)) {
        daily.set(key, {
          date: row.date,
          tool: row.tool,
          ...zeroUsage(),
          events: 0,
          sessions: 0,
          devices: 0,
        });
      }
      const target = daily.get(key);
      addUsage(target, row);
      target.events += Number(row.events) || 0;
      target.sessions += Number(row.sessions) || 0;

      if (!deviceSets.has(key)) deviceSets.set(key, new Set());
      deviceSets.get(key).add(device.device);
    }

    for (const row of device.hourly) {
      const key = `${row.date}\t${row.hour}\t${row.tool}`;
      if (!hourly.has(key)) {
        hourly.set(key, {
          date: row.date,
          weekday: row.weekday,
          hour: row.hour,
          tool: row.tool,
          ...zeroUsage(),
          events: 0,
        });
      }
      const target = hourly.get(key);
      addUsage(target, row);
      target.events += Number(row.events) || 0;
    }

    for (const row of device.models) {
      const key = `${row.tool}\t${row.model || "unknown"}`;
      if (!models.has(key)) {
        models.set(key, {
          tool: row.tool,
          model: row.model || "unknown",
          ...zeroUsage(),
          events: 0,
        });
      }
      const target = models.get(key);
      addUsage(target, row);
      target.events += Number(row.events) || 0;
    }

    for (const row of device.sessions) {
      const days = row.days || [];
      const firstDay = days[0]?.date || (row.first_activity || "").slice(0, 10) || null;
      const lastDay = days[days.length - 1]?.date || (row.last_activity || "").slice(0, 10) || firstDay;
      sessions.push({
        device: device.device,
        tool: row.tool,
        session_hash: row.session_hash,
        model: row.model || "unknown",
        first_activity: row.first_activity || null,
        last_activity: row.last_activity || null,
        first_day: firstDay,
        last_day: lastDay,
        active_days: Number(row.active_days) || days.length || 0,
        file_size_bytes: Number(row.file_size_bytes) || 0,
        events: Number(row.events) || 0,
        component_total_tokens: Number(row.component_total_tokens) || 0,
        total: row.total || zeroUsage(),
      });
    }
  }

  for (const [key, set] of deviceSets.entries()) {
    daily.get(key).devices = set.size;
  }

  const dailyRows = Array.from(daily.values()).sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    return byDate || a.tool.localeCompare(b.tool);
  });
  const hourlyRows = Array.from(hourly.values()).sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    if (byDate) return byDate;
    return a.hour - b.hour || a.tool.localeCompare(b.tool);
  });
  const modelRows = Array.from(models.values()).sort((a, b) => {
    return b.total_tokens - a.total_tokens || a.tool.localeCompare(b.tool) || a.model.localeCompare(b.model);
  });

  const totalsByTool = new Map();
  for (const row of dailyRows) {
    if (!totalsByTool.has(row.tool)) {
      totalsByTool.set(row.tool, {
        tool: row.tool,
        ...zeroUsage(),
        events: 0,
        sessions: 0,
      });
    }
    const total = totalsByTool.get(row.tool);
    addUsage(total, row);
    total.events += Number(row.events) || 0;
    total.sessions += Number(row.sessions) || 0;
  }

  const totals = Array.from(totalsByTool.values()).sort((a, b) => a.tool.localeCompare(b.tool));
  const combined = {
    tool: "all",
    ...zeroUsage(),
    events: 0,
    sessions: 0,
  };
  for (const total of totals) {
    addUsage(combined, total);
    combined.events += Number(total.events) || 0;
    combined.sessions += Number(total.sessions) || 0;
  }

  const dates = Array.from(new Set(dailyRows.map((row) => row.date))).sort();

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    device_count: devices.length,
    devices: devices.map((device) => ({
      device: device.device,
      accounting: device.accounting,
      generated_at: device.generated_at,
      sources: device.sources.map((source) => ({
        tool: source.tool,
        files_scanned: source.files_scanned,
        sessions_with_usage: source.sessions_with_usage,
      })),
      totals: device.totals,
    })),
    date_range: {
      start: dates[0] || null,
      end: dates[dates.length - 1] || null,
      active_days: dates.length,
    },
    daily: dailyRows,
    hourly: hourlyRows,
    models: modelRows,
    sessions: sessions.sort((a, b) => {
      return (b.total?.total_tokens || 0) - (a.total?.total_tokens || 0)
        || a.tool.localeCompare(b.tool)
        || a.session_hash.localeCompare(b.session_hash);
    }),
    totals,
    combined,
  };
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(repoRoot, "data", "devices");
const outDir = path.join(repoRoot, "docs", "data");
const outFile = path.join(outDir, "ledger.json");

const devices = await readDeviceFiles(dataDir);
const ledger = buildLedger(devices);
await fs.promises.mkdir(outDir, { recursive: true });
await fs.promises.writeFile(outFile, `${JSON.stringify(ledger, null, 2)}\n`);

console.log(`wrote ${path.relative(repoRoot, outFile)}`);
console.log(`devices: ${ledger.device_count}`);
console.log(`total tokens: ${ledger.combined.total_tokens.toLocaleString("en-US")}`);
