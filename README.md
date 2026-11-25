# curt

A private, multi-domain URL shortener for your own Cloudflare account. Redirects run on Cloudflare Workers, sign-in uses your OIDC provider, and click stats go to your Grafana.

- Fast redirects that don't depend on your own servers
- Several short domains, custom or random slugs, tags, expiry, QR codes
- Dashboard in light and dark, JSON API, and a `curt` command
- Prometheus `/metrics` and a Grafana dashboard
- Free up to 100,000 requests a day, then $5 a month for up to about 10 million redirects

**Status:** new. Tested locally; not yet proven on a live deployment.

## How it works

| Part | What it does |
|---|---|
| `workers/redirect` | Answers on your short domains. Reads Workers KV, falls back to D1, records the click |
| `workers/admin` | Dashboard, API, sign-in, `/metrics`, hourly maintenance |
| `web` | The dashboard |
| `cli` | The `curt` command |
| `grafana` | Dashboard, alert and scrape examples |

More in [the architecture](docs/ARCHITECTURE.md) and [the requirements](docs/PRD.md).

## Try it locally

Needs Node.js 22.12 or newer.

```bash
npm ci
```

```bash
npm run dev
```

Open http://localhost:8790. A stub provider lets you sign in as an admin, a member or an outsider. Short links answer on http://127.0.0.1:8791. Nothing leaves your machine.

## Deploy

You need a Cloudflare account with your short domains on it, and an OIDC provider. The configuration files in `workers/*/wrangler.jsonc` hold example values: keep your own in an untracked copy named `*.local.jsonc` and pass it with `-c`.

1. **Create storage.** A D1 database named `curt` and a KV namespace, from the dashboard, Wrangler, or OpenTofu. Put their IDs in both configurations.
2. **Register an OIDC client.** Public client, PKCE, callback `https://<ADMIN_HOST>/auth/callback`. Restrict it to your group in the provider as well.
3. **Set the variables** below.
4. **Set secrets** on the admin Worker: `COOKIE_KEY` (at least 32 random characters) and `AE_TOKEN` (an API token with Account Analytics read and nothing else).
5. **Build** the dashboard with `npm run build`.
6. **Apply migrations**, then deploy both Workers.
7. **Attach domains.** Each short domain to the redirect Worker, the dashboard host to the admin Worker.
8. **Add a rate-limit rule** covering 404s on the short domains, and `/auth/*` and `/api/*` on the dashboard host.

Let one tool own each resource. If OpenTofu manages custom domains, leave them out of the Wrangler configuration.

### Variables

| Name | Worker | Meaning |
|---|---|---|
| `DOMAINS` | both | JSON list of `{"host","root"}`. `root` is where the bare domain redirects |
| `VISITOR_MODE` | redirect | `hash` (default), `off`, or `full` to store addresses |
| `ADMIN_HOST`, `SITE_NAME`, `ACCENT` | admin | Dashboard host, its title, an optional hex colour |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | admin | The issuer must match the provider's exactly |
| `OIDC_AUTHORIZATION_ENDPOINT`, `OIDC_TOKEN_ENDPOINT` | admin | From the provider's discovery document |
| `OIDC_EXCHANGE` | admin | `browser` or `server`, see below |
| `OIDC_JWKS` | admin | Pinned public keys, for `browser` |
| `ALLOWED_GROUP`, `ADMIN_GROUP` | admin | Group names. An empty `ALLOWED_GROUP` trusts the provider's own restriction |
| `ADMIN_SUBJECTS` | admin | Optional subject IDs that are admins, for providers that send no groups |
| `METRICS_MAX_LINKS` | admin | Per-link series in `/metrics` |
| `ACCOUNT_ID` | admin | Your Cloudflare account ID |

### Private or public provider?

- **`browser`**: your browser swaps the sign-in code, so the provider can stay on a private network. It must allow cross-origin token requests. The Worker checks tokens against pinned keys:

  ```bash
  node workers/admin/scripts/pin-jwks.mjs https://id.example
  ```

  Put the output in `OIDC_JWKS`, and repeat after rotating the provider's keys. Browsers may ask for permission when a public page contacts a private address.
- **`server`**: the Worker swaps the code and fetches keys. The provider must be publicly reachable.

## Use

- [Command line](cli/README.md)
- [Grafana and Prometheus](grafana/README.md)
- [Operations](docs/OPERATIONS.md): access, backups, key rotation, limits

## Limits to know

- New links work at once. Edits and deletions can take a minute or so to reach every location.
- The free plan stops answering after 100,000 requests in a UTC day, across all Workers on the account.
- Click detail lasts three months. Longer history is whatever your Prometheus keeps; its default is 15 days.

## License

[MIT](LICENSE)
