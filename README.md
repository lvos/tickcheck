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

The workflow runs every 15 minutes via GitHub Actions cron:

```yaml
*/15 * * * *
```

You can also run it manually from the GitHub Actions tab with **Run workflow**.

For local testing:

```bash
npm install
npx playwright install chromium
npm run check
```

Set `TARGET_YEAR=2026` locally if you want to force a specific July 30 travel year. Without `TARGET_YEAR`, the script uses July 30 in the current year, or next year if July 30 has already passed.

## Email Behavior

- Sends one availability email only when one or more matching route/time options are found after selecting the target route and date. The subject includes the matching shorthand routes and times, for example `Machu Picchu (3A [7:00], 2B [11:00, 12:00]) tickets available for 2026-07-30`.
- Sends no email when the checker completes successfully and no matching availability is found.
- Sends one failure email if the checker fails, the site blocks or redirects the browser, the form structure changes, or the script cannot complete the check. The failure subject includes all monitored shorthand routes.

Each workflow run uploads debug screenshots matching `debug-*.png`.
