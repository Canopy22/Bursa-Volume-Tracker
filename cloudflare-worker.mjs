const DEFAULT_CONCURRENCY = 8;
const DEFAULT_BATCH_SIZE = 12;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(renderHome(env));
      }

      if (request.method === "POST" && url.pathname === "/api/check") {
        const body = await request.json().catch(() => ({}));
        const threshold = parsePositiveNumber(body.threshold, env.THRESHOLD_MULTIPLIER ?? 3);
        const offset = Math.max(0, Number(body.offset ?? 0));
        const requestedBatchSize = Number(body.batchSize ?? body.limit ?? DEFAULT_BATCH_SIZE);
        const batchSize = Math.min(Math.max(1, requestedBatchSize), DEFAULT_BATCH_SIZE);
        return jsonResponse(await scanBatch(env, threshold, offset, batchSize));
      }

      if (request.method === "POST" && url.pathname === "/api/send-alerts") {
        const body = await request.json().catch(() => ({}));
        const alerts = Array.isArray(body.alerts) ? body.alerts.filter((alert) => alert.isSpike) : [];
        if (alerts.length === 0) return jsonResponse({ error: "There are no spike alerts to email." }, 400);

        const to = body.to || env.ALERT_TO;
        if (!to) return jsonResponse({ error: "Missing alert recipient email." }, 400);

        const email = buildEmail(alerts, body.threshold ?? env.THRESHOLD_MULTIPLIER ?? 3, to, env);
        if (!env.RESEND_API_KEY) {
          return jsonResponse({
            sent: false,
            fallback: "mailto",
            mailtoUrl: buildMailtoUrl(email),
            error: "RESEND_API_KEY is not configured. Use the mailtoUrl fallback or add the Worker secret."
          }, 400);
        }

        await sendViaResend(email, env);
        return jsonResponse({ sent: true, to, count: alerts.length });
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledScanBatch(env, controller.scheduledTime));
  }
};

async function runScheduledScanBatch(env, scheduledTime) {
  if (!env.SCAN_STATE) throw new Error("Missing SCAN_STATE KV binding.");
  if (!env.ALERT_TO) throw new Error("Missing ALERT_TO.");
  if (!env.RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY secret.");

  const dateKey = singaporeDateKey(scheduledTime);
  const stateKey = `daily-scan:${dateKey}`;
  const threshold = parsePositiveNumber(env.THRESHOLD_MULTIPLIER, 3);
  const existing = await env.SCAN_STATE.get(stateKey, "json");
  const state = existing ?? {
    dateKey,
    offset: 0,
    totalCompanies: 0,
    checkedCompanies: 0,
    alerts: [],
    startedAt: new Date(scheduledTime).toISOString(),
    sent: false
  };

  if (state.sent) return;

  const batch = await scanBatch(env, threshold, state.offset, DEFAULT_BATCH_SIZE);
  state.totalCompanies = batch.totalCompanies;
  state.checkedCompanies += batch.checkedCompanies;
  state.offset = batch.nextOffset;
  state.alerts.push(...batch.alerts);
  state.lastCheckedAt = batch.checkedAt;

  if (batch.done) {
    await env.SCAN_STATE.put(stateKey, JSON.stringify(state), { expirationTtl: 60 * 60 * 24 * 14 });
    const email = buildScheduledEmail(state.alerts, threshold, env.ALERT_TO, env, state);
    await sendViaResend(email, env);
    state.sent = true;
    state.sentAt = new Date().toISOString();
  }

  await env.SCAN_STATE.put(stateKey, JSON.stringify(state), { expirationTtl: 60 * 60 * 24 * 14 });
}

async function scanBatch(env, threshold, offset, batchSize) {
  const universe = await loadBursaUniverse(env);
  const scanUniverse = universe.slice(offset, offset + batchSize);
  const symbolCache = {};
  const checkedAt = new Date().toISOString();
  const results = await mapWithConcurrency(scanUniverse, DEFAULT_CONCURRENCY, async (company) => {
    try {
      return await analyzeCompany(company, threshold, symbolCache, env);
    } catch (error) {
      return {
        ticker: company.ticker,
        name: company.name,
        sector: company.sector,
        error: error.message
      };
    }
  });

  return {
    checkedAt,
    threshold,
    source: "All Bursa companies from the auto-loaded company universe",
    totalCompanies: universe.length,
    checkedCompanies: scanUniverse.length,
    offset,
    nextOffset: offset + scanUniverse.length,
    done: offset + scanUniverse.length >= universe.length,
    results,
    alerts: results.filter((result) => result.isSpike)
  };
}

async function analyzeCompany(company, threshold, symbolCache, env) {
  const yahooSymbol = await resolveYahooSymbol(company, symbolCache, env);
  const candles = await fetchDailyCandles(yahooSymbol, env);
  if (candles.length < 21) throw new Error(`Need at least 21 trading days; received ${candles.length}.`);

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

async function resolveYahooSymbol(company, symbolCache, env) {
  if (symbolCache[company.ticker]) return symbolCache[company.ticker];

  const directSymbol = `${company.ticker}.KL`;
  if (await hasChartData(directSymbol, env)) {
    symbolCache[company.ticker] = directSymbol;
    return directSymbol;
  }

  const searchUrl = `${env.YAHOO_SEARCH_URL}?q=${encodeURIComponent(company.ticker)}&quotesCount=10&newsCount=0`;
  const response = await fetch(searchUrl, { headers: userAgentHeaders() });
  if (!response.ok) throw new Error(`Symbol search failed with HTTP ${response.status}.`);

  const body = await response.json();
  const match = body.quotes?.find((quote) => quote.exchange === "KLS" && String(quote.symbol ?? "").endsWith(".KL"));
  if (!match?.symbol) throw new Error("Could not resolve Yahoo Finance symbol.");

  symbolCache[company.ticker] = match.symbol;
  return match.symbol;
}

async function hasChartData(symbol, env) {
  try {
    const response = await fetch(`${env.YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?range=5d&interval=1d`, {
      headers: userAgentHeaders()
    });
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body.chart?.result?.[0]?.timestamp?.length);
  } catch {
    return false;
  }
}

async function fetchDailyCandles(symbol, env) {
  const response = await fetch(`${env.YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?range=3mo&interval=1d&events=history`, {
    headers: userAgentHeaders()
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

async function loadBursaUniverse(env) {
  const response = await fetch(env.BURSA_UNIVERSE_URL, { headers: userAgentHeaders() });
  if (!response.ok) throw new Error(`Company universe request failed with HTTP ${response.status}.`);

  const csv = await response.text();
  const universe = parseCompanyCsv(csv);
  if (universe.length === 0) throw new Error("Company universe was empty.");
  return universe;
}

function buildEmail(alerts, threshold, to, env) {
  return {
    from: env.ALERT_FROM,
    to,
    subject: `[Bursa Alert] ${alerts.length} volume spike${alerts.length === 1 ? "" : "s"} detected`,
    text: [
      "Bursa volume spike alert",
      "",
      `Rule: latest trading volume >= ${threshold}x the average of the previous 20 trading days.`,
      "",
      ...alerts.map((alert) =>
        [
          `${alert.ticker} - ${alert.name ?? ""}`.trim(),
          `Market date: ${alert.tradingDate}`,
          `Latest volume: ${formatNumber(alert.latestVolume)}`,
          `20-day average volume: ${formatNumber(alert.averageVolume)}`,
          `Spike multiple: ${Number(alert.multiple).toFixed(2)}x`
        ].join("\n")
      )
    ].join("\n\n")
  };
}

function buildScheduledEmail(alerts, threshold, to, env, state) {
  return {
    from: env.ALERT_FROM,
    to,
    subject: `[Bursa Daily Alert] ${alerts.length} volume spike${alerts.length === 1 ? "" : "s"} on ${state.dateKey}`,
    text: [
      `Daily Bursa volume spike scan for ${state.dateKey}`,
      "",
      `Rule: latest trading volume >= ${threshold}x the average of the previous 20 trading days.`,
      `Companies checked: ${state.checkedCompanies} of ${state.totalCompanies}`,
      `Scan started: ${state.startedAt}`,
      `Scan completed: ${state.lastCheckedAt}`,
      "",
      alerts.length ? "Alerts:" : "No volume spike alerts found.",
      "",
      ...alerts.map((alert, index) =>
        [
          `${index + 1}. ${alert.ticker} - ${alert.name ?? ""}`.trim(),
          `Market date: ${alert.tradingDate}`,
          `Latest volume: ${formatNumber(alert.latestVolume)}`,
          `20-day average volume: ${formatNumber(alert.averageVolume)}`,
          `Spike multiple: ${Number(alert.multiple).toFixed(2)}x`
        ].join("\n")
      )
    ].join("\n")
  };
}

async function sendViaResend(email, env) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: email.from,
      to: [email.to],
      subject: email.subject,
      text: email.text
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend email failed with HTTP ${response.status}: ${errorText}`);
  }
}

function renderHome(env) {
  const threshold = Number(env.THRESHOLD_MULTIPLIER ?? 3);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bursa Volume Spike Tracker</title>
  <style>
    body{margin:0;font-family:Inter,system-ui,sans-serif;background:#f4f6f4;color:#1d2420}
    main{max-width:980px;margin:0 auto;padding:28px}
    section,article{background:#fff;border:1px solid #dce4dc;border-radius:8px;box-shadow:0 18px 45px rgba(28,49,41,.08)}
    section{padding:22px}
    h1{margin:0;font-size:clamp(2rem,4vw,3.5rem);line-height:1}
    p{color:#5f6d66}
    label{display:block;margin-top:14px;font-weight:800}
    input{width:100%;height:44px;margin-top:7px;border:1px solid #cfdad0;border-radius:8px;padding:0 12px;font:inherit}
    button{min-height:44px;margin-top:18px;border:0;border-radius:8px;padding:0 16px;background:#23745a;color:#fff;font-weight:900;cursor:pointer}
    button.secondary{background:#26342f}
    button:disabled{background:#a7b2ad;cursor:not-allowed}
    .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}
    article{padding:16px}
    article strong{display:block;font-size:1.6rem}
    #results{display:grid;gap:10px;margin-top:14px}
    .row{display:grid;grid-template-columns:120px 1fr 90px;gap:12px;align-items:center;padding:14px;border:1px solid #e1e8e1;border-radius:8px;background:#fff8eb}
    small{display:block;color:#718078}
    .err{color:#a73535}
    @media(max-width:760px){.grid,.row{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Bursa Volume Spike Tracker</h1>
      <p>Scans all Bursa-listed companies in cloud-safe batches and shows only stocks where latest volume is at least the threshold times the prior 20 trading-day average.</p>
      <label>Threshold <input id="threshold" type="number" min="1" step="0.5" value="${threshold}"></label>
      <label>Alert email <input id="email" type="email" placeholder="${env.ALERT_TO ?? "you@example.com"}"></label>
      <button id="scan">Scan All Bursa Stocks</button>
      <button id="send" class="secondary" disabled>Email Current Alerts</button>
      <p id="status">Ready.</p>
    </section>
    <div class="grid">
      <article><strong id="checked">0</strong><small>Companies checked</small></article>
      <article><strong id="alerts">0</strong><small>Spike alerts</small></article>
      <article><strong id="time">Not yet</strong><small>Last checked</small></article>
    </div>
    <section>
      <h2>Alerts</h2>
      <div id="results">Run a scan to see alerts.</div>
    </section>
  </main>
  <script>
    const scanBtn = document.querySelector("#scan");
    const sendBtn = document.querySelector("#send");
    const statusEl = document.querySelector("#status");
    const resultsEl = document.querySelector("#results");
    const emailEl = document.querySelector("#email");
    let currentAlerts = [];
    let currentThreshold = ${threshold};
    scanBtn.onclick = async () => {
      scanBtn.disabled = true; sendBtn.disabled = true; statusEl.textContent = "Scanning all Bursa companies. This can take a few minutes...";
      currentAlerts = []; currentThreshold = Number(document.querySelector("#threshold").value || ${threshold});
      let offset = 0; let total = 0; let checked = 0; let checkedAt = new Date().toISOString();
      resultsEl.innerHTML = "Scanning...";
      while (true) {
        const res = await fetch("/api/check", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({threshold:currentThreshold, offset, batchSize:12})});
        const data = await res.json();
        if (!res.ok) { statusEl.innerHTML = '<span class="err">' + escapeHtml(data.error) + '</span>'; scanBtn.disabled = false; return; }
        total = data.totalCompanies; checked += data.checkedCompanies; checkedAt = data.checkedAt;
        currentAlerts.push(...data.alerts);
        document.querySelector("#checked").textContent = checked + " / " + total;
        document.querySelector("#alerts").textContent = currentAlerts.length;
        document.querySelector("#time").textContent = new Date(checkedAt).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
        statusEl.textContent = "Scanned " + checked + " of " + total + " companies. Alerts found: " + currentAlerts.length + ".";
        resultsEl.innerHTML = currentAlerts.length ? currentAlerts.map(renderRow).join("") : "No spike alerts yet.";
        if (data.done) break;
        offset = data.nextOffset;
      }
      scanBtn.disabled = false;
      statusEl.textContent = currentAlerts.length ? currentAlerts.length + " alerts found across " + total + " companies." : "No stocks reached the threshold across " + total + " companies.";
      sendBtn.disabled = currentAlerts.length === 0;
    };
    sendBtn.onclick = async () => {
      const to = emailEl.value.trim();
      if (!to) { statusEl.innerHTML = '<span class="err">Enter an alert email first.</span>'; return; }
      const res = await fetch("/api/send-alerts", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({to, threshold:currentThreshold, alerts:currentAlerts})});
      const data = await res.json();
      if (data.mailtoUrl) { window.location.href = data.mailtoUrl; statusEl.textContent = "Email provider is not configured, so an email draft was opened."; return; }
      statusEl.innerHTML = res.ok ? "Email sent to " + escapeHtml(to) + "." : '<span class="err">' + escapeHtml(data.error) + '</span>';
    };
    function renderRow(a){return '<div class="row"><strong>'+escapeHtml(a.ticker)+'</strong><div>'+escapeHtml(a.name||"")+'<br><small>Market date '+escapeHtml(a.tradingDate)+' | latest '+num(a.latestVolume)+' | 20d avg '+num(a.averageVolume)+'</small></div><strong>'+Number(a.multiple).toFixed(2)+'x</strong></div>'}
    function num(v){return Math.round(Number(v)).toLocaleString("en-US")}
    function escapeHtml(v){return String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;")}
  </script>
</body>
</html>`;
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

function buildMailtoUrl(email) {
  return `mailto:${encodeURIComponent(email.to)}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.text)}`;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

function parsePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Number(fallback);
}

function singaporeDateKey(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

function formatNumber(value) {
  return Math.round(Number(value)).toLocaleString("en-US");
}

function userAgentHeaders() {
  return { "User-Agent": "bursa-volume-spike-tracker-worker/1.0" };
}
