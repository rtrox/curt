# Operations

## Removing someone's access

1. Remove them from the group in your sign-in provider.
2. In the dashboard, open **People** and choose **Cut off**. Their sessions end, their API tokens are revoked and admin is cleared, at once. Their links keep working.

In the other order, they could sign in again before step 1. Without step 2, their session lasts up to seven days and their API tokens until they expire or are revoked.

Admin status is read from the provider at sign-in. Until the next sign-in or a cutoff, a former admin's API tokens keep admin powers, so cut them off.

## Backup and restore

`curt export -o links.json` saves every link you may see; an admin's export has everyone's. Run it on a schedule from a machine you control, with an admin's API token. Never store exports in public CI artifacts.

`curt import links.json` shows what a restore would create; `--apply` does it. Restored links belong to whoever runs it. Owners, IDs and click history are not restored.

## Rotating keys

| What | How | Effect |
|---|---|---|
| Provider signing key (`browser` mode) | Run `pin-jwks.mjs`, update `OIDC_JWKS`, deploy | Sign-in fails between rotation and deploy. Sessions and tokens keep working |
| `COOKIE_KEY` | Set a new secret | Sign-ins in progress must restart. Sessions keep working |
| `AE_TOKEN` | Create a new token, set it, delete the old one | Stats unavailable if it is wrong |
| API token | Create, swap, revoke in the dashboard | |

## If KV and D1 disagree

The hourly job repairs pending writes and deletions. For anything else, an admin can call `POST /api/v1/admin/resync`, repeating with `?cursor=` until `nextCursor` is null. It rewrites entries for links that exist.

Resync uses one KV write per link. The free plan allows 1,000 KV writes a day, so on a large install spread it over several days or use Workers Paid.

## When a change is pending

If a change says it is pending, the old link may keep working until the hourly job repairs it. Try the change again. On the free plan, once the day's 1,000 KV writes are used, changes stay pending until midnight UTC, including disabling a link. Workers Paid removes that daily limit.

## Rate limiting

Nothing in this repository limits request rates. Add a Cloudflare rate-limit rule before sharing links widely: without one, anyone can use up the free plan's daily requests and stop every link. Check how many rules your plan allows; cover the short domains first.

## Private names

Before pushing, run `scripts/check-private-names.sh` with a file of names kept outside the repository. CI repeats the check, but only after a push is already public.

## Upgrading and rolling back

Migrations only add, and run before the Workers deploy, so the previous version still works. Roll back by deploying it again.

## Wrangler telemetry

Both configurations set `send_metrics` to false. Commands run elsewhere follow your own settings; `WRANGLER_SEND_METRICS=false` turns it off.
