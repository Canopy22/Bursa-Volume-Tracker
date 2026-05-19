# Bursa Volume Spike Tracker

This tracker checks Bursa Malaysia stocks for unusual volume. It automatically loads the Bursa company universe, compares each latest trading day's volume with the average volume of the previous 20 trading days, and creates an alert when the latest volume is at least `3x` the average.

The web dashboard runs at:

```powershell
http://127.0.0.1:5173
```

No manual watchlist is required.

## Setup

1. Copy `config.example.json` to `config.json`.
2. Add your SMTP details and alert recipient email.

You can also copy `.env.example` to `.env` and put the email settings there. Environment variables override `config.json`.

## Run

```powershell
node tracker.mjs --dry-run
```

Dry-run mode prints alerts without sending email or updating the alert history.

If the Windows `node` app alias is blocked, use the bundled Codex runtime:

```powershell
& 'C:\Users\gwofe\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' tracker.mjs --dry-run
```

To send real email alerts:

```powershell
node tracker.mjs
```

## Options

```powershell
node tracker.mjs --config config.json --tickers tickers.txt --threshold 3 --repeat
```

- `--config`: path to JSON config file. Defaults to `config.json`, then falls back to `config.example.json`.
- `--tickers`: optional text file with one ticker per line.
- `--threshold`: override the multiplier. `3` means latest volume must be at least 3 times the prior 20-day average.
- `--dry-run`: do not send email and do not write alert history.
- `--repeat`: send an alert even if the same ticker/date was already alerted before.

## Alert History

Sent alerts are recorded in `alerts.json` so the same stock is not emailed repeatedly for the same trading date.

## Scheduling

Use Windows Task Scheduler to run this after the Bursa market closes. A simple schedule is one run per weekday evening.

## Data Sources

- Company universe: `https://huggingface.co/datasets/ThunderDrag/Malaysia-Stock-Symbols-and-Metadata`
- Daily price and volume data: Yahoo Finance chart endpoints
