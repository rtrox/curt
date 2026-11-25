# PRD: self-hosted URL shortener on Cloudflare Workers

Status: built and tested locally, not deployed · 2026-11-25

Project name: `curt`. License: MIT. Example domains below use `go.example`.

## 1. Summary

A private, multi-domain URL shortener that anyone can deploy to their own Cloudflare account. Redirects run in one small Worker; the dashboard and API run in a second. Links are fast and do not depend on the owner's own servers. Nothing in the code, defaults or README is specific to one deployment.

**Platform decision: Cloudflare Workers.** Redirect speed is the priority and expected volume fits the free plan.

## 2. Goals

1. Redirects that feel instant, from anywhere.
2. Links that work while the owner's servers or sign-in provider are down.
3. Creating a link takes one paste and one click, or one command, and the link works at once.
4. Access stats in the owner's existing Grafana.
5. $0/month at expected volume, with a path to much higher volume without a redesign.
6. A minimal, beautiful UI in light and dark.
7. Deployable by other people from the README with only their own configuration.

## 3. Non-goals for v1

Public sign-up, billing, link passwords, one-time links, a browser extension, bulk import, adding domains from the UI, and link-in-bio pages.

## 4. Users

| User | Needs |
|---|---|
| Admin | Everything a member can do, plus see and manage everyone's links |
| Member (trusted group) | Create and manage their own links, tags and API tokens |
| Visitor | Follow a link. Never signs in |

Sized for: a few signed-in users, 10,000 links, 10,000 clicks/day.

## 5. Functional requirements

### Redirects
- **R1** `https://<domain>/<slug>` redirects to the destination with a 302, so edits take effect and clicks stay countable.
- **R2** Several domains are supported. The same slug may exist on different domains with different destinations.
- **R3** Unknown, disabled and expired links return a styled 404 or 410 page.
- **R4** Each domain's bare URL redirects to a configurable page.
- **R5** A new link works as soon as it is created: if KV has no entry, the Worker looks in D1 before returning 404.
- **R6** Edits, disabling and deletion may take up to about 60 seconds, occasionally longer, where a location holds a cached copy.
- **R7** A failure to record a click never blocks or fails the redirect.

### Links
- **L1** Paste a URL and get a random six-character slug, drawn from 31 lowercase letters and digits that are hard to confuse (about 887 million combinations).
- **L2** Optional custom slug, unique within its domain, checked while typing. Slugs are case-insensitive: stored in lowercase and matched in any case.
- **L3** Choose a domain, with a remembered default.
- **L4** Edit destination, tags and expiry; disable; delete.
- **L5** Tags: add several per link, filter by tag.
- **L6** Optional expiry date.
- **L7** Search by slug, destination and tag.
- **L8** QR code for every link, downloadable as SVG and PNG.
- **L9** Only `http` and `https` destinations. Links pointing back at a configured short domain are rejected to prevent loops.
- **L10** `.well-known`, `robots.txt` and `favicon.ico` are reserved on every domain.

### Sign-in
- **A1** OIDC authorization code flow with PKCE (S256) and a public client. Pocket ID is the tested provider.
- **A2** Default, *browser exchange*: the browser swaps the code and posts the ID token to the Worker. The provider may be private, as long as the user's browser can reach it and it allows cross-origin token requests.
- **A3** Alternative, *server exchange*: the Worker swaps the code and fetches keys itself. Needs a publicly reachable provider. Selected by configuration.
- **A4** The Worker verifies signature, issuer, audience, expiry and a Worker-issued nonce, then issues its own HttpOnly, Secure, SameSite=Strict session cookie. In browser exchange it verifies against pinned public keys.
- **A5** Access is limited to an allowed group. A second group grants admin.
- **A6** Existing sessions and API tokens work when the provider is unreachable, until they expire.
- **A8** An admin can cut a person off: their sessions end, their API tokens are revoked and their admin status is cleared, at once. Their links keep working. To stop them signing in again, remove them in the provider first, then cut them off.
- **A7** In browser exchange, rotating the provider's signing key requires updating the pinned keys with a documented one-command step.

### API and CLI
- **P1** Versioned JSON API covering everything the UI can do with links and tags.
- **P2** Personal API tokens: created in the UI, shown once, stored hashed, named, revocable, optional expiry. A read-only metrics scope exists for Prometheus.
- **P3** Go CLI, single binary, for Linux and macOS: shorten, list, search, edit, delete, QR. Reads a URL from an argument or stdin and prints the short URL alone.

### Stats
- **S1** Record per click: time, domain, link, referrer domain, country, device type, bot flag.
- **S2** Visitor address is configurable: `off`, `hash` (default) or `full`. `hash` uses a salt that is rotated and discarded daily and gives unique visitors per day.
- **S3** Click detail is stored in Workers Analytics Engine, which keeps it for three months.
- **S4** Grafana reads that detail directly from the Analytics Engine SQL API with the Altinity ClickHouse plugin and a read-only account token. No collector or cluster component is needed.
- **S5** The Admin Worker exposes a token-protected `/metrics` endpoint in Prometheus format: clicks per domain and outcome, and clicks per link. Prometheus scrapes it outbound, and history older than three months lives there for as long as its retention is set.
- **S6** Per-link series are limited to a configurable number of the most-clicked links; domain totals are always complete. Referrer, country and device are never Prometheus labels.
- **S7** A Grafana dashboard ships in the repo: clicks over time, top links, referrers, countries, devices, bots versus people.
- **S8** The UI shows a click count and trend per link for up to the last three months, read from Analytics Engine and cached for five minutes.

### Interface
- **U1** One prominent paste box is the first control on the page.
- **U2** Light and dark, following the system by default with a manual override.
- **U3** Usable on a phone and by keyboard; WCAG AA contrast.
- **U4** Visual direction B from the design canvas, with plain wording and no wordplay.
- **U5** Site name and accent color are configuration.
- **U6** The dashboard and API live on their own configured host, for example `app.go.example`, with the API under `/api`.

### Reuse
- **X1** Domains, provider, groups, site name, metrics cap and visitor-address mode are configuration. No deployment's values are committed.
- **X2** Examples use reserved example domains. CI fails if a configured list of private names, held outside the repo, appears in it.
- **X3** The README takes a new user from an empty Cloudflare account to a working link.

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| Speed | Proposed target: p50 under 50 ms and p95 under 100 ms to first byte near a Cloudflare location, for recently used links. Measured before launch, then confirmed or revised |
| Cold links | First use of a link in a location may be slower; measured and reported separately |
| Availability | Redirects do not depend on the owner's servers, the sign-in provider or Grafana |
| Cost | $0/month on the free plan; $5/month on Workers Paid |
| Scale | Same design from 10k to millions of clicks/day; upgrading plan is the only change |
| Security | No secrets in the repo, hashed tokens, rate limits on API and sign-in, Origin checks, audit record for link changes |
| Delivery | GitHub Actions; Worker deployed from CI; CLI binaries on releases and a CLI image on GHCR |
| Recovery | Scheduled export of links, with a tested restore |

No Kubernetes component is planned. The Kubernetes requirement applied to a self-hosted app, and this design has none.

## 7. Data storage choice

D1 is the source of truth. Workers KV holds the copy used for redirects, because D1 latency depends on distance to a database instance. KV advertises under 5 ms for hot reads. At 50M redirects/month the estimated cost is $38.40 with KV versus $18.40 with D1, excluding Analytics Engine.

## 8. Cost

| Volume | Monthly cost |
|---|---|
| Up to 100k requests/day | $0 |
| Up to about 10M redirects/month | $5 |
| 50M redirects/month | About $38, plus $10 if Analytics Engine billing starts |

Assumes about 2 ms CPU per redirect. On the free plan, exceeding 100,000 requests in a day makes requests fail until midnight UTC. The limit is shared by every Worker on the account, and API calls count too. The shipped Grafana dashboard includes an alert at 70% of the daily limit. Moving to Workers Paid removes the daily cap.

## 9. Success criteria

- Redirect targets in section 6 met in a measured test from at least three regions.
- A new link works on first request, including when its slug was requested before it existed.
- Redirects keep working with the owner's servers and sign-in provider switched off.
- Sign-in works with Pocket ID unreachable from the internet, or the fallback is in use.
- A click appears in Grafana within five minutes.
- After a one-hour scrape outage within a month, Prometheus totals still match Analytics Engine.
- A second person can deploy from the README alone.

## 10. Risks

| Risk | Response |
|---|---|
| Browser exchange behaves differently on the installed Pocket ID version than in its main-branch source | Test against the real instance before building on it. Fallback: make Pocket ID public and use server exchange |
| Chrome may ask permission when a public page calls a private address | Test first. Same fallback |
| `groups` may be missing from the ID token | Test first. Fallback: restrict by group in the provider and list admins by subject ID |
| `INTERNAL_APP_URL` changes the token endpoint in Pocket ID's discovery document | Configure the endpoint explicitly |
| Free-plan cap hit by a spike or bots | Alert at 70%, rate-limit rule, documented upgrade |
| Random-slug scanning causes a D1 read per miss | One indexed row per miss; covered by the rate-limit rule |
| Free plan gives 10 ms CPU per request | Aggregate in the Analytics Engine query and cap the number of per-link series |
| Counters reset each UTC month, so an outage across that boundary loses clicks since the last scrape | Documented; detail is still in Analytics Engine |
| Prometheus retention is too short for long history | State the required retention in the README; its default is 15 days |
| Analytics Engine samples at high volume | Weight counts by sample interval; state that per-link counts become estimates |
| Analytics Engine is not billed today | Priced into section 8 |

## 11. Decisions and open questions

Decided:

1. Public repository, MIT license.
2. All short domains on Cloudflare DNS in one account for the first deployment.
3. Members see only their own links; admins see all.
4. Slugs are case-insensitive.
5. History older than three months is Prometheus click counts per link, not individual clicks.
6. The dashboard is on a subdomain, which isolates its cookies.
7. The project is named `curt`.

## 12. Delivery plan

1. **Spike:** Pocket ID sign-in and redirect latency. Stop and revisit this document if either fails.
2. **Core:** redirects, data model, API, sign-in.
3. **Surfaces:** dashboard and CLI, in parallel once the API contract is fixed.
4. **Stats:** metrics endpoint, dashboard trends and Grafana dashboard, in parallel with surfaces.
5. **Launch:** export and restore, alerts, latency test, README walk-through, security review.
