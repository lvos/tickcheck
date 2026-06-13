# Machu Picchu Ticket Checker

This repository runs a GitHub Actions checker for the official Tu Boleto Machu Picchu page:

https://tuboleto.cultura.pe/llaqta_machupicchu

The checker uses Playwright with Chromium to select the ticket form controls, choose July 30, and inspect enabled entry-time options for:

- Route 3A, any time
- Route 2A, any time
- Route 2B, any time
- Route 3B, only before 10:00 AM
- Route 3D, only before 10:00 AM

## GitHub Secrets

Configure these repository secrets:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `ALERT_TO`

Do not commit SMTP credentials or other secrets to the repository.

## Running

The workflow is designed to be triggered manually from GitHub Actions or by an external scheduler such as the Cloudflare Worker scheduler.
Cloudflare should call the workflow dispatch API every 15 minutes:

```yaml
*/15 * * * *
```

The GitHub workflow intentionally keeps only `workflow_dispatch` enabled so Cloudflare is the scheduler and GitHub Actions is the runner. You can also run it manually from the GitHub Actions tab with **Run workflow**.

For local testing:

```bash
npm install
npx playwright install chromium
npm run check
```

Set `TARGET_YEAR=2026` locally if you want to force a specific July 30 travel year. Without `TARGET_YEAR`, the script uses July 30 in the current year, or next year if July 30 has already passed.

Useful timeout knobs:

- `PAGE_TIMEOUT_MS`, default `120000`
- `FORM_READY_TIMEOUT_MS`, default `300000`
- `ACTION_TIMEOUT_MS`, default `30000`
- `PAGE_LOAD_ATTEMPTS`, default `3`
- `PAGE_LOAD_RETRY_DELAY_MS`, default `10000`

## Email Behavior

- Sends one availability email only when one or more matching route/time options are found after selecting the target route and date. The subject includes the matching shorthand routes and times, for example `Machu Picchu (3A [7:00], 2B [11:00, 12:00]) tickets available for 2026-07-30`.
- Sends no email when the checker completes successfully and no matching availability is found.
- In GitHub Actions, checker failures are not emailed immediately. The workflow sends one failure-streak email only when the current failed run makes 3 consecutive failed workflow attempts. The subject is `Machu Picchu checker: past 3 workflow attempts failed`.
- When run outside GitHub Actions, `check.js` still sends an immediate failure email by default. Set `SEND_FAILURE_EMAIL_IMMEDIATELY=false` to suppress that.

Each workflow run uploads debug screenshots matching `debug-*.png`; the workflow currently retains them for 7 days.
