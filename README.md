# GA4 Merchandise Store — Analytics Dashboard

A statistical dashboard built from a Google Analytics 4 (BigQuery export) event
sample: 100,000 events, 42,610 users, Nov 1 2020 – Jan 31 2021.

## Files

| File            | Purpose                                                                |
|------------------|------------------------------------------------------------------------|
| `build_data.py`  | Python. Cleans the raw CSV, computes descriptive statistics (frequency, central tendency, dispersion, position), and writes `data.json` + `stats_report.md`. |
| `data.json`      | Generated. Compact integer-coded event table + lookups the dashboard reads at runtime. |
| `stats_report.md`| Generated. Human-readable descriptive statistics report (whole dataset). |
| `index.html`     | Dashboard shell: sidebar nav, date-range controls, panel containers.  |
| `styles.css`     | Layout & component styling (imports `theme.css`).                     |
| `theme.css`      | Color tokens, taken from your uploaded design system.                  |
| `app.js`         | Loads `data.json`, filters by date range, renders every chart/table with Chart.js. |
| `source_data.csv`| Your original uploaded file (kept for reference / re-running the build). |

## Run it

Because the dashboard fetches `data.json`, it needs to be served over HTTP
(opening `index.html` directly as a `file://` URL will be blocked by the
browser's CORS rules). From this folder:

```bash
python3 -m http.server 8000
```

Then open **http://localhost:8000** in your browser.

## Regenerating the data

If you get an updated CSV, drop it in as `source_data.csv` (same column
schema) and re-run:

```bash
python3 build_data.py
```

This rewrites `data.json` and `stats_report.md`.

## Notes on the data

- There is no page-URL / landing-page field in this export, so "Landing
  Pages" and "Top Pages" panels were left out per your request — everything
  else in the original sidebar list is included.
- `operating_system` includes a `"Web"` value — this is how GA4 reports
  desktop-web sessions in this export; it's not a bug.
- Only 133 of the 100,000 events are `purchase` events, so eCommerce
  statistics (mean order value, percentiles, etc.) are based on that
  smaller n — shown as `n (orders)` on the eCommerce panel.
- The accent color in your uploaded CSS (`--accent: #2d397`) was an invalid
  5-digit hex code, so I substituted a teal derived from your chart palette
  (`oklch(0.65 0.14 200)`) to keep the same navy/slate/teal feel. Swap
  `--accent` in `theme.css` if you had a specific color in mind.
