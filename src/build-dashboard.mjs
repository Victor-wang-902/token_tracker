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
      generated_at: parsed.generated_at || null,
      sources: parsed.sources || [],
      daily: parsed.daily || [],
      totals: parsed.totals || [],
    });
  }
  return devices;
}

function buildLedger(devices) {
  const daily = new Map();
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
  }

  for (const [key, set] of deviceSets.entries()) {
    daily.get(key).devices = set.size;
  }

  const dailyRows = Array.from(daily.values()).sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    return byDate || a.tool.localeCompare(b.tool);
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

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    device_count: devices.length,
    devices: devices.map((device) => ({
      device: device.device,
      generated_at: device.generated_at,
      sources: device.sources,
      totals: device.totals,
    })),
    daily: dailyRows,
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
