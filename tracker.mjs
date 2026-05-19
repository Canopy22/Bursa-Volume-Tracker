import fs from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";

const DEFAULT_CONFIG_PATH = "config.json";
const FALLBACK_CONFIG_PATH = "config.example.json";
const DEFAULT_STATE_PATH = "alerts.json";
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

main().catch((error) => {
  console.error(`Tracker failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await loadDotEnv(".env");
  const config = await loadConfig(args.config ?? DEFAULT_CONFIG_PATH);
  const thresholdMultiplier = Number(args.threshold ?? process.env.THRESHOLD_MULTIPLIER ?? config.thresholdMultiplier ?? 3);
  const tickers = await loadTickers(args.tickers, config);

  if (!Number.isFinite(thresholdMultiplier) || thresholdMultiplier <= 0) {
    throw new Error("Threshold multiplier must be a positive number.");
  }

  if (tickers.length === 0) {
    throw new Error("No tickers configured. Add symbols to config.json or tickers.txt.");
  }

  const statePath = args.state ?? DEFAULT_STATE_PATH;
  const sentState = args.repeat ? {} : await readJsonIfExists(statePath, {});
  const results = [];

  for (const ticker of tickers) {
    try {
      const result = await analyzeTicker(ticker, thresholdMultiplier);
      results.push(result);
    } catch (error) {
      results.push({ ticker, error: error.message });
    }
  }

  const alerts = results.filter((result) => result.isSpike);
  const newAlerts = alerts.filter((alert) => !sentState[alertKey(alert)]);

  printSummary(results, thresholdMultiplier, args.dryRun);

  if (newAlerts.length === 0) {
    console.log("No new alerts to send.");
    return;
  }

  const email = buildEmail(newAlerts, thresholdMultiplier, config);
  if (args.dryRun) {
    console.log("\nDry run email preview:\n");
    console.log(email.text);
    return;
  }

  await sendEmail(resolveSmtpConfig(config), email);

  const nextState = { ...sentState };
  for (const alert of newAlerts) {
    nextState[alertKey(alert)] = {
      ticker: alert.ticker,
      tradingDate: alert.tradingDate,
      latestVolume: alert.latestVolume,
      averageVolume: alert.averageVolume,
      multiplier: alert.multiplier,
      alertedAt: new Date().toISOString()
    };
  }
  await fs.writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  console.log(`Sent ${newAlerts.length} alert email(s) to ${email.to}.`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--repeat") args.repeat = true;
    else if (arg === "--config") args.config = argv[++i];
    else if (arg === "--tickers") args.tickers = argv[++i];
    else if (arg === "--threshold") args.threshold = argv[++i];
    else if (arg === "--state") args.state = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node tracker.mjs [options]

Options:
  --config <file>     Config file path. Defaults to config.json.
  --tickers <file>    Text file with one ticker per line.
  --threshold <n>     Alert when latest volume is n times the 20-day average.
  --state <file>      Alert history file. Defaults to alerts.json.
  --dry-run           Print alerts without sending email or writing state.
  --repeat            Ignore alert history and send duplicate alerts.
`);
}

async function loadConfig(configPath) {
  const preferred = path.resolve(configPath);
  const fallback = path.resolve(FALLBACK_CONFIG_PATH);
  const filePath = await fileExists(preferred) ? preferred : fallback;
  return readJsonIfExists(filePath, {});
}

async function loadTickers(tickersPath, config) {
  if (tickersPath) {
    return parseTickerLines(await fs.readFile(tickersPath, "utf8"));
  }

  if (Array.isArray(config.tickers) && config.tickers.length > 0) {
    return normalizeTickers(config.tickers);
  }

  if (await fileExists("tickers.txt")) {
    return parseTickerLines(await fs.readFile("tickers.txt", "utf8"));
  }

  return [];
}

function parseTickerLines(text) {
  return normalizeTickers(
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean)
  );
}

function normalizeTickers(tickers) {
  return [...new Set(tickers.map((ticker) => String(ticker).trim().toUpperCase()).filter(Boolean))];
}

async function analyzeTicker(ticker, thresholdMultiplier) {
  const candles = await fetchDailyCandles(ticker);
  if (candles.length < 21) {
    throw new Error(`Need at least 21 trading days; received ${candles.length}.`);
  }

  const latest = candles.at(-1);
  const previous20 = candles.slice(-21, -1);
  const averageVolume = previous20.reduce((sum, candle) => sum + candle.volume, 0) / previous20.length;
  const multiplier = averageVolume > 0 ? latest.volume / averageVolume : 0;

  return {
    ticker,
    tradingDate: latest.date,
    latestClose: latest.close,
    latestVolume: latest.volume,
    averageVolume,
    multiplier,
    isSpike: multiplier >= thresholdMultiplier
  };
}

async function fetchDailyCandles(ticker) {
  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?range=3mo&interval=1d&events=history`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "bursa-volume-spike-tracker/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Market data request failed with HTTP ${response.status}.`);
  }

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

function printSummary(results, thresholdMultiplier, dryRun) {
  const mode = dryRun ? "dry run" : "live";
  console.log(`Bursa volume tracker (${mode})`);
  console.log(`Threshold: ${thresholdMultiplier}x prior 20-day average\n`);

  for (const result of results) {
    if (result.error) {
      console.log(`${result.ticker}: ERROR - ${result.error}`);
      continue;
    }

    const status = result.isSpike ? "ALERT" : "ok";
    console.log(
      `${result.ticker}: ${status} | ${result.tradingDate} | volume ${formatNumber(result.latestVolume)} | ` +
        `20d avg ${formatNumber(result.averageVolume)} | ${result.multiplier.toFixed(2)}x`
    );
  }
}

function buildEmail(alerts, thresholdMultiplier, config) {
  const to = process.env.ALERT_TO ?? config.recipientEmail ?? config.smtp?.to;
  if (!to) {
    throw new Error("Missing alert recipient. Set ALERT_TO or recipientEmail in config.json.");
  }

  const subject = `[Bursa Alert] ${alerts.length} volume spike${alerts.length === 1 ? "" : "s"} detected`;
  const lines = [
    `Bursa volume spike alert`,
    ``,
    `Rule: latest trading volume >= ${thresholdMultiplier}x the average of the previous 20 trading days.`,
    ``,
    ...alerts.map((alert) =>
      [
        `${alert.ticker}`,
        `Trading date: ${alert.tradingDate}`,
        `Latest close: ${formatMoney(alert.latestClose)}`,
        `Latest volume: ${formatNumber(alert.latestVolume)}`,
        `20-day average volume: ${formatNumber(alert.averageVolume)}`,
        `Spike multiple: ${alert.multiplier.toFixed(2)}x`
      ].join("\n")
    )
  ];

  return {
    to,
    subject,
    text: lines.join("\n\n")
  };
}

function resolveSmtpConfig(config) {
  const smtp = config.smtp ?? {};
  const resolved = {
    host: process.env.SMTP_HOST ?? smtp.host,
    port: Number(process.env.SMTP_PORT ?? smtp.port ?? 587),
    secure: parseBoolean(process.env.SMTP_SECURE ?? smtp.secure ?? false),
    user: process.env.SMTP_USER ?? smtp.user,
    pass: process.env.SMTP_PASS ?? smtp.pass,
    from: process.env.SMTP_FROM ?? smtp.from
  };

  for (const key of ["host", "port", "user", "pass", "from"]) {
    if (!resolved[key]) throw new Error(`Missing SMTP setting: ${key}.`);
  }

  return resolved;
}

async function sendEmail(smtp, email) {
  const client = await SmtpClient.connect(smtp);
  try {
    await client.expect(220);
    await client.command(`EHLO localhost`, 250);

    if (!smtp.secure) {
      await client.command("STARTTLS", 220);
      await client.upgradeToTls(smtp.host);
      await client.command(`EHLO localhost`, 250);
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
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`
  ];

  const escapedBody = email.text.replace(/^\./gm, "..");
  return `${headers.join("\r\n")}\r\n\r\n${escapedBody}\r\n.`;
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
      if (pending.expectedCodes.includes(code)) {
        pending.resolve(response.text);
      } else {
        pending.reject(new Error(`SMTP expected ${pending.expectedCodes.join("/")} but got: ${response.text.trim()}`));
      }
    }
  }

  rejectPending(error) {
    while (this.pending.length > 0) {
      this.pending.shift().reject(error);
    }
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
    if (/^\d{3} /.test(line)) {
      return { text: responseLines.join("\n"), length: consumed };
    }
  }

  return null;
}

function extractEmailAddress(value) {
  const match = String(value).match(/<([^>]+)>/);
  return match ? match[1] : String(value).trim();
}

function formatNumber(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatMoney(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function alertKey(alert) {
  return `${alert.ticker}:${alert.tradingDate}`;
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
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
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
