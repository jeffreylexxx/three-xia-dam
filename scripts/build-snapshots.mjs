import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const execFileAsync = promisify(execFile);

// The upstream server's HTTPS endpoint requires unsafe TLS renegotiation, which
// OpenSSL 3 correctly rejects on GitHub's Ubuntu runners. Its public HTTP
// endpoint serves the same read-only water table without redirecting to HTTPS.
const STATION_URL = "http://hbwater.wetruetech.com/water/portal/wx_station_info";
const STATION = { stationCode: "60106980", stationType: "RR" };
const SOURCE_MODE = "GitHub Actions 每日快照 → 湖北水文公开页面";
const FOUR_YEARS_IN_DAYS = 366 * 4;
const OVERLAP_DAYS = 2;
const RANGES = [
  ["7d", 7],
  ["30d", 31],
  ["1y", 366],
  ["4y", FOUR_YEARS_IN_DAYS]
];

function pad(n) {
  return String(n).padStart(2, "0");
}

function localHourString(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function splitWindows(start, end) {
  const windows = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const next = new Date(Math.min(addDays(cursor, 30).getTime(), end.getTime()));
    windows.push([new Date(cursor), next]);
    cursor = next;
  }
  return windows;
}

function fullHistoryWindow() {
  const end = new Date();
  end.setMinutes(59, 59, 0);
  return [addDays(end, -FOUR_YEARS_IN_DAYS), end];
}

function buildOfficialUrl(start, end) {
  const params = new URLSearchParams({
    startTm: localHourString(start),
    endTm: localHourString(end),
    stationCode: STATION.stationCode,
    stationType: STATION.stationType
  });
  return `${STATION_URL}?${params.toString()}`;
}

function decodeHtml(value) {
  return String(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanNumber(value) {
  const text = decodeHtml(value).replace(/,/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function parseDateHour(text) {
  const m = String(text).match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4]);
}

function parseHydroHtml(html) {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] || "";
  const rows = [];
  for (const tr of tbody.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...tr[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 5) continue;
    const timeText = decodeHtml(cells[0]);
    if (!/^\d{4}-\d{2}-\d{2}/.test(timeText)) continue;
    const time = parseDateHour(timeText);
    if (!time) continue;
    rows.push({
      time: localHourString(time),
      ts: time.getTime(),
      level: cleanNumber(cells[1]),
      storage: cleanNumber(cells[2]),
      inflow: cleanNumber(cells[3]),
      outflow: cleanNumber(cells[4])
    });
  }
  return rows;
}

function normalizeRecords(records, days) {
  const cutoff = addDays(new Date(), -days).getTime();
  const map = new Map();
  for (const row of records) {
    if (!row.ts || row.ts < cutoff) continue;
    map.set(row.time, row);
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

async function fetchOfficial(url) {
  const { stdout } = await execFileAsync("curl", [
    "-L",
    "--silent",
    "--show-error",
    "--fail-with-body",
    "--retry",
    "5",
    "--retry-delay",
    "5",
    "--retry-all-errors",
    "--connect-timeout",
    "20",
    "--max-time",
    "90",
    "-A",
    "Mozilla/5.0 Three-Gorges-Monitor/1.0",
    url
  ], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function readExistingRecords() {
  try {
    const text = await fs.readFile(path.join(dataDir, "hydro-4y.json"), "utf8");
    const payload = JSON.parse(text);
    return Array.isArray(payload.records) ? payload.records : [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Existing snapshot could not be read: ${error.message}`);
    }
    return [];
  }
}

function fetchStart(existingRecords, historyStart) {
  const latest = existingRecords.reduce(
    (max, row) => Number.isFinite(row.ts) ? Math.max(max, row.ts) : max,
    0
  );
  if (!latest) return historyStart;
  return new Date(Math.max(
    historyStart.getTime(),
    addDays(new Date(latest), -OVERLAP_DAYS).getTime()
  ));
}

async function fetchUpdatedRecords(existingRecords) {
  const [historyStart, end] = fullHistoryWindow();
  const start = fetchStart(existingRecords, historyStart);
  const windows = splitWindows(start, end);
  const chunks = [];
  console.log(`Fetching ${windows.length} window(s), ${localHourString(start)} -> ${localHourString(end)}`);
  for (let i = 0; i < windows.length; i += 1) {
    const [windowStart, windowEnd] = windows[i];
    const html = await fetchOfficial(buildOfficialUrl(windowStart, windowEnd));
    const records = parseHydroHtml(html);
    console.log(`Window ${i + 1}/${windows.length}: ${records.length} records`);
    chunks.push(...records);
  }
  if (chunks.length === 0) {
    throw new Error("湖北水文页面返回成功，但没有解析到任何水文记录；保留旧快照并停止提交。");
  }
  return normalizeRecords([...existingRecords, ...chunks], FOUR_YEARS_IN_DAYS);
}

async function writeJson(file, payload) {
  await fs.writeFile(path.join(dataDir, file), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

await fs.mkdir(dataDir, { recursive: true });
const generatedAt = new Date().toISOString();
const existingRecords = await readExistingRecords();
console.log(`Existing snapshot: ${existingRecords.length} records`);
const allRecords = await fetchUpdatedRecords(existingRecords);

for (const [range, days] of RANGES) {
  const records = normalizeRecords(allRecords, days);
  await writeJson(`hydro-${range}.json`, {
    generatedAt,
    sourceMode: SOURCE_MODE,
    range,
    station: STATION,
    records
  });
  console.log(`${range}: ${records.length} records`);
}

await writeJson("manifest.json", {
  generatedAt,
  sourceMode: SOURCE_MODE,
  ranges: Object.fromEntries(RANGES.map(([range]) => [range, `data/hydro-${range}.json`]))
});
