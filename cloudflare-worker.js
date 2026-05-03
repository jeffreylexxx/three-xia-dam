const STATION_URL = "https://hbwater.wetruetech.com/water/portal/wx_station_info";
const STATION = { stationCode: "60106980", stationType: "RR" };

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
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 Three-Gorges-Monitor/1.0" }
  });
  if (!res.ok) throw new Error(`official fetch failed ${res.status}`);
  return res.text();
}

async function hydro(range) {
  const chunks = [];
  for (const [start, end] of splitWindows(rangeDays(range))) {
    const html = await fetchOfficial(buildOfficialUrl(start, end));
    chunks.push(...parseHydroHtml(html));
  }
  return normalizeRecords(chunks, range);
}

function cors(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      ...headers
    }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors("");
    try {
      if (url.pathname === "/api/hydro") {
        const range = url.searchParams.get("range") || "7d";
        const records = await hydro(range);
        return cors(JSON.stringify({ sourceMode: "Cloudflare Worker -> 湖北水文公开页面", range, records }), 200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
      }
      if (url.pathname === "/api/raw") {
        const target = url.searchParams.get("url");
        if (!target || !target.startsWith("https://hbwater.wetruetech.com/")) {
          return cors("Only the configured Hubei Water source is allowed.", 400);
        }
        const html = await fetchOfficial(target);
        return cors(html, 200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store"
        });
      }
      return cors("Three Gorges hydro proxy is running.", 200, { "content-type": "text/plain; charset=utf-8" });
    } catch (error) {
      return cors(error.stack || String(error), 500, { "content-type": "text/plain; charset=utf-8" });
    }
  }
};
