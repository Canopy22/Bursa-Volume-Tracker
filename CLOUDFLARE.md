# Cloudflare Worker Deployment

This project now includes a Cloudflare Worker version:

- `wrangler.toml`
- `cloudflare-worker.mjs`

The Worker scans the Bursa company universe and calculates volume spike alerts using the same rule:

```text
latest volume >= threshold x previous 20 trading-day average volume
```

## Deploy

Install Wrangler if you do not already have it:

```powershell
npm install -g wrangler
```

Login:

```powershell
wrangler login
```

Create the KV namespace used to store daily scan progress:

```powershell
wrangler kv namespace create SCAN_STATE
wrangler kv namespace create SCAN_STATE --preview
```

Copy the returned `id` and `preview_id` into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SCAN_STATE"
id = "your-production-kv-id"
preview_id = "your-preview-kv-id"
```

Deploy:

```powershell
wrangler deploy
```

## Daily 4 PM Scan

`wrangler.toml` includes a cron trigger:

```toml
[triggers]
crons = ["* 8-9 * * *"]
```

Cloudflare cron is in UTC. `08:00 UTC` is `4:00 PM` in Singapore.

The Worker runs every minute between `4:00 PM` and `5:59 PM` Singapore time because Cloudflare Workers have outbound request limits. Each tick scans a safe batch of companies, saves progress in KV, and sends the daily email once all Bursa companies have been scanned.

## Email Alerts

Cloudflare Workers cannot use normal SMTP sockets. For cloud email sending, this Worker uses the Resend HTTP API.

Set your API key as a Worker secret:

```powershell
wrangler secret put RESEND_API_KEY
```

Then edit `wrangler.toml`:

```toml
ALERT_FROM = "Bursa Alert <alerts@yourdomain.com>"
ALERT_TO = "your@email.com"
```

Your `ALERT_FROM` domain must be verified in Resend.

If `RESEND_API_KEY` is not configured, manual email sends return a `mailto:` fallback that opens an email draft. The scheduled daily scan requires `RESEND_API_KEY`, because there is no browser available to open a draft.

## Notes

The full scan is intentionally split into batches to avoid Cloudflare's per-invocation subrequest limit.
