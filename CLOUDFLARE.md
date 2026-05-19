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

Deploy:

```powershell
wrangler deploy
```

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

If `RESEND_API_KEY` is not configured, the Worker returns a `mailto:` fallback that opens an email draft.

## Notes

The first full scan can take a few minutes because each Bursa company must be resolved to a Yahoo Finance symbol and checked for daily volume. Cloudflare request duration limits vary by plan; if the full scan times out, add a scheduled workflow or split scans into batches.
