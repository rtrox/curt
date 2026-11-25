# Grafana and Prometheus

> **Not verified against live services.** The dashboard, its queries, the scrape config and the alert rules were written from documentation. Check each panel against your own data before relying on it.

| File | What it is |
|---|---|
| `curt-dashboard.json` | Dashboard, refreshes every 5 minutes |
| `prometheus-scrape.example.yml` | Scrape job, every 2 minutes, token read from a file |
| `prometheus-rules.example.yml` | Alert at 70% of 100,000 requests a day, and a sampling notice |

Grafana reads click detail straight from Workers Analytics Engine. Prometheus scrapes `/metrics` and keeps the long history. Nothing else needs to run.

## Set up

### 1. Click detail in Grafana

1. In Cloudflare, create an API token with only **Account Analytics: Read** for your account. Make a separate one for Grafana; do not reuse the Worker's `AE_TOKEN`.
2. In Grafana, install **Altinity plugin for ClickHouse** (`vertamedia-clickhouse-datasource`).
3. Add a data source of that type:
   - URL: `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql`
   - All authentication switches off
   - Custom header `Authorization` with value `Bearer <token>`

The dataset must be named `curt_clicks`. It does not exist until the first click is recorded; until then these panels show errors and `/metrics` answers 503.

### 2. Long history in Prometheus

1. In curt, sign in as an admin, create an API token with the `metrics:read` scope (only admins can, because metrics list every link) and save it in a file only Prometheus can read.
2. Copy the job from `prometheus-scrape.example.yml`, with your admin host as the target.
3. **Raise retention.** Prometheus deletes data after 15 days by default. For five years of history, start it with `--storage.tsdb.retention.time=5y`.
4. Load `prometheus-rules.example.yml` as a rule file and route the alerts.

`/metrics` shows every domain and the most-clicked links of all users. Treat the token accordingly.

### 3. Dashboard

Import `curt-dashboard.json`, then pick the two data sources from the menus at the top.

## Limits

- **Detail goes back three months.** Analytics Engine deletes older points. Panels that use it stay empty before that. Older history is click counts per domain and link, with no referrer, country or device.
- **10,000 Analytics Engine queries a day** on the free plan. Each scrape uses two, so a 2-minute interval uses 1,440. The dashboard has eight Analytics Engine panels, so one open copy at 5-minute refresh uses up to 2,304. Do not refresh every minute: one open copy would use 11,520.
- **100,000 requests a day** on the free plan, shared by every Worker on the account, until midnight UTC. The panel and the alert see only recorded redirects, so the real number is higher. The panel counts from midnight UTC; the alert looks at the last 24 hours.

## Reading the numbers

- **Counters reset each UTC month.** Always use `increase()` or `rate()`, never the raw value. A missed scrape within a month loses nothing. An outage across the start of a month loses the clicks after the last scrape of the old month; detail is still in Analytics Engine.
- **Sampling.** At high volume Analytics Engine samples, and `curt_metrics_sampled` becomes 1. Values are then estimates and can fall between scrapes, which looks like a reset and makes `increase()` too high. Check that gauge before trusting a report.
- **Bots.** `bot="1"` marks known bots. Filter with `bot="0"` for people. Do not filter when comparing with request limits.
- **Outcomes.** `curt_clicks_total` counts every request by `outcome`. `curt_link_clicks_total` counts successful redirects only.
- **Per-link series are capped** by `METRICS_MAX_LINKS`, default 1,000, most clicked first. `curt_links_omitted` says how many were left out. Domain totals are always complete. A link's first sample of the month may already be above zero, and `increase()` does not see clicks before the first sample of a new series.
- `curt_links` is refreshed at most every 15 minutes.

## Example queries

```promql
# Clicks by people per domain, last 30 days
sum by (domain) (increase(curt_clicks_total{outcome="ok",bot="0"}[30d]))

# Ten most clicked links, last year
topk(10, sum by (domain, slug) (increase(curt_link_clicks_total{bot="0"}[1y])))
```
