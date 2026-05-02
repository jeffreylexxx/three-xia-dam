import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const STATION_URL = "https://hbwater.wetruetech.com/water/portal/wx_station_info";
const STATION = { stationCode: "60106980", stationType: "RR" };
const execFileAsync = promisify(execFile);

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

function rangeDays(range) {
  return range === "7d" ? 7 : range === "30d" ? 31 : 366;
}

function splitWindows(days) {
  const end = new Date();
  end.setMinutes(59, 59, 0);
  const start = addDays(end, -days);
  const windows = [];
  let cursor = start;
  while (cursor < end) {
    const next = new Date(Math.min(addDays(cursor, 30).getTime(), end.getTime()));
    windows.push([new Date(cursor), next]);
    cursor = next;
  }
  return windows;
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

function normalizeRecords(records, range) {
  const cutoff = addDays(new Date(), -rangeDays(range)).getTime();
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
    "--max-time",
    "45",
    "-A",
    "Mozilla/5.0 Three-Gorges-Monitor/1.0",
    url
  ], { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function hydro(range) {
  const chunks = [];
  for (const [start, end] of splitWindows(rangeDays(range))) {
    const html = await fetchOfficial(buildOfficialUrl(start, end));
    chunks.push(...parseHydroHtml(html));
  }
  return normalizeRecords(chunks, range);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": "*",
    ...headers
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/api/hydro") {
      const range = url.searchParams.get("range") || "7d";
      const records = await hydro(range);
      send(res, 200, JSON.stringify({ sourceMode: "本地代理 -> 湖北水文公开页面", range, records }), {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      return;
    }
    if (url.pathname === "/api/raw") {
      const target = url.searchParams.get("url");
      if (!target || !target.startsWith("https://hbwater.wetruetech.com/")) {
        send(res, 400, "Only the configured Hubei Water source is allowed.");
        return;
      }
      const html = await fetchOfficial(target);
      send(res, 200, html, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      return;
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const resolved = path.resolve(__dirname, file);
    if (!resolved.startsWith(__dirname)) {
      send(res, 403, "Forbidden");
      return;
    }
    const content = await fs.readFile(resolved);
    const type = file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
    send(res, 200, content, { "content-type": type });
  } catch (error) {
    send(res, 500, error.stack || String(error), { "content-type": "text/plain; charset=utf-8" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Three Gorges dashboard: http://127.0.0.1:${PORT}`);
});
