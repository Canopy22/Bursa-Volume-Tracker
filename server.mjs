import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5173);
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search";
const BURSA_UNIVERSE_URL =
  "https://huggingface.co/datasets/ThunderDrag/Malaysia-Stock-Symbols-and-Metadata/resolve/main/malaysia.csv";
const CACHE_DIR = path.join(__dirname, ".cache");
const UNIVERSE_CACHE_PATH = path.join(CACHE_DIR, "bursa-universe.json");
const SYMBOL_CACHE_PATH = path.join(CACHE_DIR, "yahoo-symbols.json");
const SCAN_CONCURRENCY = 12;

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/") {
      return sendFile(response, "index.html", "text/html; charset=utf-8");
    }

    if (request.method === "GET" && url.pathname === "/styles.css") {
      return sendFile(response, "styles.css", "text/css; charset=utf-8");
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      return sendFile(response, "app.js", "text/javascript; charset=utf-8");
    }

    if (request.method === "POST" && url.pathname === "/api/check") {
      const body = await readRequestJson(request);
      const threshold = parsePositiveNumber(body.threshold, 3);
      const universe = await loadBursaUniverse();
      const scanUniverse = body.limit ? universe.slice(0, Number(body.limit)) : universe;

      const checkedAt = new Date().toISOString();
      const symbolCache = await readJsonIfExists(SYMBOL_CACHE_PATH, {});
      const results = await mapWithConcurrency(scanUniverse, SCAN_CONCURRENCY, async (company) => {
        try {
          const result = await analyzeCompany(company, threshold, symbolCache);
          return result;
        } catch (error) {
          return {
            ticker: company.ticker,
            name: company.name,
            sector: company.sector,
            error: error.message
          };
        }
      });
      await writeJson(SYMBOL_CACHE_PATH, symbolCache);

      return sendJson(response, 200, {
        checkedAt,
        threshold,
        source: "All Bursa companies from the auto-loaded company universe",
        totalCompanies: universe.length,
        checkedCompanies: scanUniverse.length,
        results,
        alerts: results.filter((result) => result.isSpike)
      });
    }

    if (request.method === "POST" && url.pathname === "/api/send-alerts") {
      const body = await readRequestJson(request);
      const alerts = Array.isArray(body.alerts) ? body.alerts.filter((alert) => alert.isSpike) : [];
      if (alerts.length === 0) {
        return sendJson(response, 400, { error: "There are no spike alerts to email." });
      }

      const config = await loadConfig();
      const email = buildEmail(alerts, body.threshold ?? 3, config, body.to);
      await sendEmail(resolveSmtpConfig(config, body.smtp), email);
      return sendJson(response, 200, { sent: true, to: email.to, count: alerts.length });
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Bursa Volume Spike Tracker is running at http://127.0.0.1:${PORT}`);
});

async function sendFile(response, fileName, contentType) {
  const content = await fs.readFile(path.join(__dirname, fileName));
  response.writeHead(200, { "Content-Type": contentType });
  response.end(content);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeTickers(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[\s,;]+/);
  return [...new Set(list.map((ticker) => String(ticker).trim().toUpperCase()).filter(Boolean))];
}

function parsePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function analyzeCompany(company, threshold, symbolCache) {
  const yahooSymbol = await resolveYahooSymbol(company, symbolCache);
  const candles = await fetchDailyCandles(yahooSymbol);
  if (candles.length < 21) {
    throw new Error(`Need at least 21 trading days; received ${candles.length}.`);
  }

  const latest = candles.at(-1);
  const previous20 = candles.slice(-21, -1);
  const averageVolume = previous20.reduce((sum, candle) => sum + candle.volume, 0) / previous20.length;
  const multiple = averageVolume > 0 ? latest.volume / averageVolume : 0;

  return {
    ticker: company.ticker,
    name: company.name,
    sector: company.sector,
    yahooSymbol,
    tradingDate: latest.date,
    latestClose: latest.close,
    latestVolume: latest.volume,
    averageVolume,
    multiple,
    threshold,
    isSpike: multiple >= threshold
  };
}

async function fetchDailyCandles(ticker) {
  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?range=3mo&interval=1d&events=history`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "bursa-volume-spike-tracker/1.0"
    }
  });
  if (!response.ok) throw new Error(`Market data request failed with HTTP ${response.status}.`);

  const body = await response.json();
  const result = body.chart?.result?.[0];
  const error = body.chart?.error;
  if (error) throw new Error(error.description ?? "Yahoo Finance returned an error.");
  if (!result?.timestamp || !result.indicators?.quote?.[0]) {
    throw new Error("Yahoo Finance returned an unexpected response.");
  }

  const quote = result.indicators.quote[0];
  const closes = result.indicators.adjclose?.[0]?.adjclose ?? quote.close;
  return result.timestamp
    .map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      volume: Number(quote.volume?.[index]),
      close: Number(closes?.[index])
    }))
    .filter((candle) => Number.isFinite(candle.volume) && candle.volume > 0)
    .filter((candle) => Number.isFinite(candle.close));
}

async function resolveYahooSymbol(company, symbolCache) {
  if (symbolCache[company.ticker]) return symbolCache[company.ticker];

  const directSymbol = `${company.ticker}.KL`;
  if (await hasChartData(directSymbol)) {
    symbolCache[company.ticker] = directSymbol;
    return directSymbol;
  }

  const searchUrl = `${YAHOO_SEARCH_URL}?q=${encodeURIComponent(company.ticker)}&quotesCount=10&newsCount=0`;
  const response = await fetch(searchUrl, {
    headers: { "User-Agent": "bursa-volume-spike-tracker/1.0" }
  });
  if (!response.ok) throw new Error(`Symbol search failed with HTTP ${response.status}.`);

  const body = await response.json();
  const match = body.quotes?.find((quote) => quote.exchange === "KLS" && String(quote.symbol ?? "").endsWith(".KL"));
  if (!match?.symbol) throw new Error("Could not resolve Yahoo Finance symbol.");

  symbolCache[company.ticker] = match.symbol;
  return match.symbol;
}

async function hasChartData(symbol) {
  try {
    const response = await fetch(`${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?range=5d&interval=1d`, {
      headers: { "User-Agent": "bursa-volume-spike-tracker/1.0" }
    });
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body.chart?.result?.[0]?.timestamp?.length);
  } catch {
    return false;
  }
}

async function loadBursaUniverse() {
  try {
    const response = await fetch(BURSA_UNIVERSE_URL, {
      headers: { "User-Agent": "bursa-volume-spike-tracker/1.0" }
    });
    if (!response.ok) throw new Error(`Company universe request failed with HTTP ${response.status}.`);
    const csv = await response.text();
    const universe = parseCompanyCsv(csv);
    if (universe.length === 0) throw new Error("Company universe was empty.");
    await writeJson(UNIVERSE_CACHE_PATH, universe);
    return universe;
  } catch (error) {
    const cached = await readJsonIfExists(UNIVERSE_CACHE_PATH, null);
    if (cached) return cached;
    throw error;
  }
}

function parseCompanyCsv(csv) {
  const rows = parseCsv(csv);
  const header = rows.shift()?.map((column) => column.trim().toLowerCase()) ?? [];
  const nameIndex = header.indexOf("name");
  const tickerIndex = header.indexOf("ticker");
  const sectorIndex = header.indexOf("sector");

  return rows
    .map((row) => ({
      name: row[nameIndex]?.trim(),
      ticker: row[tickerIndex]?.trim().toUpperCase(),
      sector: row[sectorIndex]?.trim()
    }))
    .filter((company) => company.name && company.ticker);
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function loadConfig() {
  await loadDotEnv(path.join(__dirname, ".env"));
  const configPath = path.join(__dirname, "config.json");
  const fallbackPath = path.join(__dirname, "config.example.json");
  const fallback = await readJsonIfExists(fallbackPath, {});
  return readJsonIfExists(configPath, fallback);
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function loadDotEnv(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index === -1) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function buildEmail(alerts, threshold, config, requestedTo) {
  const to = requestedTo || process.env.ALERT_TO || config.recipientEmail || config.smtp?.to;
  if (!to) throw new Error("Missing alert recipient. Set ALERT_TO or recipientEmail in config.json.");

  return {
    to,
    subject: `[Bursa Alert] ${alerts.length} volume spike${alerts.length === 1 ? "" : "s"} detected`,
    text: [
      "Bursa volume spike alert",
      "",
      `Rule: latest trading volume >= ${threshold}x the average of the previous 20 trading days.`,
      "",
      ...alerts.map((alert) =>
        [
          `${alert.ticker}`,
          `Trading date: ${alert.tradingDate}`,
          `Latest close: ${formatMoney(alert.latestClose)}`,
          `Latest volume: ${formatNumber(alert.latestVolume)}`,
          `20-day average volume: ${formatNumber(alert.averageVolume)}`,
          `Spike multiple: ${Number(alert.multiple).toFixed(2)}x`
        ].join("\n")
      )
    ].join("\n\n")
  };
}

function resolveSmtpConfig(config, requestedSmtp = {}) {
  const smtp = config.smtp ?? {};
  const resolved = {
    host: requestedSmtp.host || process.env.SMTP_HOST || smtp.host,
    port: Number(requestedSmtp.port || process.env.SMTP_PORT || smtp.port || 587),
    secure: parseBoolean(requestedSmtp.secure ?? process.env.SMTP_SECURE ?? smtp.secure ?? false),
    user: requestedSmtp.user || process.env.SMTP_USER || smtp.user,
    pass: requestedSmtp.pass || process.env.SMTP_PASS || smtp.pass,
    from: requestedSmtp.from || process.env.SMTP_FROM || smtp.from
  };
  if (resolved.host === "smtp.example.com") {
    throw new Error("SMTP is still using smtp.example.com. Enter your real SMTP host, username, password, and from email.");
  }
  for (const key of ["host", "port", "user", "pass", "from"]) {
    if (!resolved[key]) throw new Error(`Missing SMTP setting: ${key}.`);
  }
  return resolved;
}

async function sendEmail(smtp, email) {
  const client = await SmtpClient.connect(smtp);
  try {
    await client.expect(220);
    await client.command("EHLO localhost", 250);
    if (!smtp.secure) {
      await client.command("STARTTLS", 220);
      await client.upgradeToTls(smtp.host);
      await client.command("EHLO localhost", 250);
    }
    await client.command("AUTH LOGIN", 334);
    await client.command(Buffer.from(smtp.user).toString("base64"), 334);
    await client.command(Buffer.from(smtp.pass).toString("base64"), 235);
    await client.command(`MAIL FROM:<${extractEmailAddress(smtp.from)}>`, 250);
    await client.command(`RCPT TO:<${extractEmailAddress(email.to)}>`, [250, 251]);
    await client.command("DATA", 354);
    await client.writeData(formatMimeMessage(smtp.from, email));
    await client.command("QUIT", 221);
  } finally {
    client.close();
  }
}

function formatMimeMessage(from, email) {
  const headers = [
    `From: ${from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit"
  ];
  return `${headers.join("\r\n")}\r\n\r\n${email.text.replace(/^\./gm, "..")}\r\n.`;
}

class SmtpClient {
  static connect(smtp) {
    const socket = smtp.secure
      ? tls.connect({ host: smtp.host, port: smtp.port, servername: smtp.host })
      : net.connect({ host: smtp.host, port: smtp.port });
    return new SmtpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.pending = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("error", (error) => this.rejectPending(error));
  }

  command(command, expected) {
    this.socket.write(`${command}\r\n`);
    return this.expect(expected);
  }

  writeData(data) {
    this.socket.write(`${data}\r\n`);
    return this.expect(250);
  }

  expect(expected) {
    const expectedCodes = Array.isArray(expected) ? expected.map(String) : [String(expected)];
    return new Promise((resolve, reject) => {
      this.pending.push({ expectedCodes, resolve, reject });
      this.flush();
    });
  }

  upgradeToTls(host) {
    this.socket.removeAllListeners("data");
    this.socket = tls.connect({ socket: this.socket, servername: host });
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.handleData(chunk));
    this.socket.on("error", (error) => this.rejectPending(error));
    return new Promise((resolve, reject) => {
      this.socket.once("secureConnect", resolve);
      this.socket.once("error", reject);
    });
  }

  close() {
    this.socket.end();
  }

  handleData(chunk) {
    this.buffer += chunk;
    this.flush();
  }

  flush() {
    while (this.pending.length > 0) {
      const response = readCompleteSmtpResponse(this.buffer);
      if (!response) return;
      this.buffer = this.buffer.slice(response.length);
      const pending = this.pending.shift();
      const code = response.text.slice(0, 3);
      if (pending.expectedCodes.includes(code)) pending.resolve(response.text);
      else pending.reject(new Error(`SMTP expected ${pending.expectedCodes.join("/")} but got: ${response.text.trim()}`));
    }
  }

  rejectPending(error) {
    while (this.pending.length > 0) this.pending.shift().reject(error);
  }
}

function readCompleteSmtpResponse(buffer) {
  const lines = buffer.split(/\r\n/);
  if (lines.length < 2) return null;
  let consumed = 0;
  const responseLines = [];
  for (const line of lines) {
    consumed += line.length + 2;
    if (!line) continue;
    responseLines.push(line);
    if (/^\d{3} /.test(line)) return { text: responseLines.join("\n"), length: consumed };
  }
  return null;
}

function extractEmailAddress(value) {
  const match = String(value).match(/<([^>]+)>/);
  return match ? match[1] : String(value).trim();
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function formatNumber(value) {
  return Math.round(Number(value)).toLocaleString("en-US");
}

function formatMoney(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(3) : "n/a";
}
