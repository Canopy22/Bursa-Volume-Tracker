const thresholdInput = document.querySelector("#threshold");
const emailInput = document.querySelector("#email");
const smtpHostInput = document.querySelector("#smtpHost");
const smtpPortInput = document.querySelector("#smtpPort");
const smtpUserInput = document.querySelector("#smtpUser");
const smtpPassInput = document.querySelector("#smtpPass");
const smtpFromInput = document.querySelector("#smtpFrom");
const smtpSecureInput = document.querySelector("#smtpSecure");
const checkButton = document.querySelector("#checkButton");
const emailButton = document.querySelector("#emailButton");
const statusEl = document.querySelector("#status");
const universeCount = document.querySelector("#universeCount");
const checkedCount = document.querySelector("#checkedCount");
const alertCount = document.querySelector("#alertCount");
const lastChecked = document.querySelector("#lastChecked");
const resultsList = document.querySelector("#resultsList");

let currentAlerts = [];
let currentThreshold = 3;

emailInput.value = localStorage.getItem("bursa-alert-email") ?? "";
emailInput.addEventListener("input", () => {
  localStorage.setItem("bursa-alert-email", emailInput.value.trim());
});
restoreSmtpSettings();
for (const input of [smtpHostInput, smtpPortInput, smtpUserInput, smtpFromInput, smtpSecureInput]) {
  input.addEventListener("input", saveSmtpSettings);
}
checkButton.addEventListener("click", checkVolumeSpikes);
emailButton.addEventListener("click", sendCurrentAlerts);

async function checkVolumeSpikes() {
  setBusy(true, "Scanning all Bursa-listed companies. First run may take a few minutes...");
  currentAlerts = [];
  emailButton.disabled = true;

  try {
    const response = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threshold: thresholdInput.value
      })
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Check failed.");

    currentAlerts = payload.alerts;
    currentThreshold = payload.threshold;
    renderResults(payload);
    statusEl.classList.remove("error");
    statusEl.textContent = payload.alerts.length
      ? `${payload.alerts.length} alert${payload.alerts.length === 1 ? "" : "s"} found from ${payload.checkedCompanies} Bursa companies.`
      : `No volume spikes found across ${payload.checkedCompanies} Bursa companies.`;
    emailButton.disabled = payload.alerts.length === 0;
  } catch (error) {
    statusEl.classList.add("error");
    statusEl.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function sendCurrentAlerts() {
  if (currentAlerts.length === 0) return;
  const smtp = getSmtpSettings();
  if (!smtp.host || smtp.host === "smtp.example.com" || !smtp.user || !smtp.pass || !smtp.from) {
    openEmailDraft();
    return;
  }

  setBusy(true, "Sending alert email...");

  try {
    const response = await fetch("/api/send-alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threshold: currentThreshold,
        to: emailInput.value.trim(),
        smtp,
        alerts: currentAlerts
      })
    });

    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Email failed.");

    statusEl.classList.remove("error");
    statusEl.textContent = `Sent ${payload.count} alert${payload.count === 1 ? "" : "s"} to ${payload.to}.`;
  } catch (error) {
    statusEl.classList.add("error");
    statusEl.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

function openEmailDraft() {
  const to = emailInput.value.trim();
  if (!to) {
    statusEl.classList.add("error");
    statusEl.textContent = "Enter an alert email address first.";
    return;
  }

  const subject = `[Bursa Alert] ${currentAlerts.length} volume spike${currentAlerts.length === 1 ? "" : "s"} detected`;
  const body = [
    "Bursa volume spike alert",
    "",
    `Rule: latest trading volume >= ${currentThreshold}x the average of the previous 20 trading days.`,
    "",
    ...currentAlerts.map((alert) =>
      [
        `${alert.ticker} - ${alert.name ?? ""}`.trim(),
        `Scan date: ${formatDateTime(new Date().toISOString())}`,
        `Market date: ${alert.tradingDate}`,
        `Latest volume: ${formatNumber(alert.latestVolume)}`,
        `20-day average volume: ${formatNumber(alert.averageVolume)}`,
        `Spike multiple: ${Number(alert.multiple).toFixed(2)}x`
      ].join("\n")
    )
  ].join("\n\n");

  window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  statusEl.classList.remove("error");
  statusEl.textContent = "SMTP is not configured, so I opened an email draft instead.";
}

function renderResults(payload) {
  checkedCount.textContent = String(payload.results.length);
  alertCount.textContent = String(payload.alerts.length);
  universeCount.textContent = `${payload.totalCompanies} companies loaded`;
  lastChecked.textContent = new Date(payload.checkedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });

  resultsList.classList.remove("empty");
  resultsList.textContent = "";

  if (payload.alerts.length === 0) {
    resultsList.classList.add("empty");
    resultsList.textContent = `No stocks reached ${payload.threshold}x the previous 20-day average.`;
    return;
  }

  for (const result of payload.alerts) {
    const row = document.createElement("article");
    row.className = `stock-row${result.isSpike ? " alert" : ""}`;

    if (result.error) {
      row.innerHTML = `
        <div class="ticker">${escapeHtml(result.ticker)}</div>
        <div class="row-error">${escapeHtml(result.name ?? "")}<br>${escapeHtml(result.error)}</div>
        <div class="badge">Error</div>
      `;
      resultsList.append(row);
      continue;
    }

    row.innerHTML = `
      <div>
        <div class="ticker">${escapeHtml(result.ticker)}</div>
        <div class="company-name">${escapeHtml(result.name)}</div>
        <div class="metric"><small>Scan date</small><strong>${formatDateTime(payload.checkedAt)}</strong></div>
      </div>
      <div class="meta">
        <div class="metric"><small>Latest volume</small><strong>${formatNumber(result.latestVolume)}</strong></div>
        <div class="metric"><small>20d avg volume</small><strong>${formatNumber(result.averageVolume)}</strong></div>
        <div class="metric"><small>Multiple</small><strong>${Number(result.multiple).toFixed(2)}x</strong></div>
        <div class="metric"><small>Market date</small><strong>${escapeHtml(result.tradingDate)}</strong></div>
      </div>
      <div class="badge">${result.isSpike ? "Alert" : "OK"}</div>
    `;
    resultsList.append(row);
  }
}

function setBusy(isBusy, message) {
  checkButton.disabled = isBusy;
  if (isBusy) {
    emailButton.disabled = true;
    statusEl.classList.remove("error");
    statusEl.textContent = message;
  } else {
    emailButton.disabled = currentAlerts.length === 0;
  }
}

function formatNumber(value) {
  return Math.round(Number(value)).toLocaleString("en-US");
}

function formatDateTime(value) {
  return new Date(value).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function getSmtpSettings() {
  return {
    host: smtpHostInput.value.trim(),
    port: smtpPortInput.value.trim(),
    user: smtpUserInput.value.trim(),
    pass: smtpPassInput.value,
    from: smtpFromInput.value.trim(),
    secure: smtpSecureInput.checked
  };
}

function restoreSmtpSettings() {
  const saved = JSON.parse(localStorage.getItem("bursa-smtp-settings") ?? "{}");
  smtpHostInput.value = saved.host ?? "";
  smtpPortInput.value = saved.port ?? "587";
  smtpUserInput.value = saved.user ?? "";
  smtpFromInput.value = saved.from ?? "";
  smtpSecureInput.checked = Boolean(saved.secure);
}

function saveSmtpSettings() {
  const { pass, ...safeSettings } = getSmtpSettings();
  localStorage.setItem("bursa-smtp-settings", JSON.stringify(safeSettings));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
