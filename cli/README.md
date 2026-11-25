# curt command line

Create and manage short links from a terminal. One binary for Linux and macOS.

## Build

```sh
cd cli
go build -o curt .
```

Or, with Go:

```
go install github.com/rtrox/curt/cli@latest
```

That installs a binary named `cli`; rename it to `curt`. Release binaries are already named `curt`.

## Sign in

Create an API token with the `links` scope in the dashboard, then:

```sh
curt login https://app.go.example      # asks for the token, which is not shown
pass show curt | curt login https://app.go.example   # or reads it from stdin
```

The token is never accepted as an argument, because other users can see arguments in the process list. It is saved in `curt/config.json` in your user configuration directory, readable only by you. `curt` warns if the file's permissions are looser.

`CURT_URL` and `CURT_TOKEN` override the saved values. A saved token is only sent to the server it was saved for. `curt logout` deletes the saved token; revoke it in the dashboard to stop it working.

## Use

```sh
curt https://example.com/a/long/page
curt https://example.com --slug docs --domain s.example --tag work --tag wiki --expires 7d
echo https://example.com | curt

curt list --tag work --limit 100
curt search wiki --json
curt edit docs --url https://example.com/new --expires never
curt delete docs
curt qr docs -o docs.svg
curt export -o links.json
```

- Creating a link prints only the short URL on stdout. Messages go to stderr.
- Commands that take a link accept a slug, a link ID or a full short URL. If a slug is on several domains, `curt` lists them and asks for `--domain`.
- `edit --tag` replaces all tags; `--no-tags` removes them. An edit fails without saving anything if someone else changed the link in the meantime.
- `--expires` takes a duration (`90m`, `12h`, `7d`, `2w`), a date (through the end of that day, local time), an RFC 3339 time, or `never`.
- `delete` asks first unless `--yes` is given. Without a terminal, `--yes` is required.
- A change reported as pending is saved, but the old behaviour may continue for up to an hour while the server retries. The exit code is still 0. Running the same edit again retries it at once.
- `export -o` replaces the file only after the whole export has arrived.

Servers must use https, except on localhost. Redirects are never followed, so the token cannot be passed to another host.

Exit codes: 0 success, 1 error, 2 usage.

## Restore

```sh
curt export -o links.json
curt import links.json            # shows what would happen, changes nothing
curt import links.json --apply
curt import links.json --apply --domain-map go.example=s.example
```

Restored: domain, slug, destination, tags, expiry and disabled.

**Not restored: link IDs, stats and owners.** Every new link belongs to whoever runs the import, has a new ID, and starts its stats at zero. An admin's export holds everyone's links, so importing it makes the admin their owner.

- The whole file is checked first. If it is damaged, partial, or a link lacks a field, nothing is changed.
- A slug that already exists on the domain is skipped if its destination matches and reported as a conflict if not. Existing links are never overwritten.
- A link whose expiry has passed is restored disabled, with no expiry.
- A link on a domain the server does not have is reported. `--domain-map OLD=NEW` moves it.
- Disabled links are created already disabled. If an older server ignores that, the link is reported as failed and live, with the command to turn it off, and no further disabled links are created.
- A skipped link that is live but disabled or expired in the file is pointed out, not changed.
- Links the server marks pending are counted. Their old behaviour may continue for up to an hour.
- Requests are paced at five a second at most, and retried after a 429 or 503. One failed link does not stop the rest, but five server or network failures in a row do.
- It is safe to run again: links that are already there are skipped. After Ctrl-C the request in progress is finished first; a second Ctrl-C ends at once.
- Exit code 1 means some link was, or would be, left out. This applies to the dry run too. For a member, the dry run also checks each new slug, which takes a while for many links.

Pushing a tag such as `v1.2.3` runs the release workflow in `.github/workflows/release.yml`.

```sh
docker run --rm -e CURT_URL -e CURT_TOKEN ghcr.io/OWNER/curt https://example.com
```

`release.example.yml` is a draft release workflow. Copy it to `.github/workflows/` to use it.
