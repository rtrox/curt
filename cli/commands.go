package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
	"unicode"
)

// clean makes server text safe to show in a terminal.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsPrint(r) {
			return r
		}
		return '?'
	}, s)
}

func checkURL(raw string) error {
	if urlHost(raw) == "" {
		// The input is not repeated: it could be a token pasted by mistake.
		return usagef("not a command or a full URL. URLs start with https:// or http://. See curt --help.")
	}
	return nil
}

// urlHost returns the lowercase host of an http or https URL, or "". It is more
// lenient than net/url, which refuses URLs the server accepts, such as ones
// with a bare percent sign.
func urlHost(raw string) string {
	scheme, rest, ok := strings.Cut(strings.TrimSpace(raw), "://")
	if !ok || (!strings.EqualFold(scheme, "http") && !strings.EqualFold(scheme, "https")) {
		return ""
	}
	if i := strings.IndexAny(rest, "/?#\\"); i >= 0 {
		rest = rest[:i]
	}
	rest = rest[strings.LastIndex(rest, "@")+1:]
	if i := strings.LastIndex(rest, ":"); i > strings.LastIndex(rest, "]") {
		rest = rest[:i]
	}
	return strings.ToLower(strings.TrimSuffix(rest, "."))
}

func (a *app) shorten(ctx context.Context, args []string) error {
	var slug, domain, expires once
	var tags many
	pos, err := parse("curt", args, func(f *flag.FlagSet) {
		f.Var(&slug, "slug", "")
		f.Var(&domain, "domain", "")
		f.Var(&expires, "expires", "")
		f.Var(&tags, "tag", "")
	})
	if err != nil {
		return err
	}
	if len(pos) > 1 {
		return usagef("expected one URL. Quote it if it contains spaces or special characters. See curt --help.")
	}
	if len(pos) == 0 && a.stdinIsTerm {
		return usagef("missing URL. See curt --help.")
	}
	var dest string
	if len(pos) == 1 && pos[0] != "-" {
		dest = strings.TrimSpace(pos[0])
	} else if dest, err = readOne(ctx, a.stdin, "URL"); err != nil {
		return err
	}
	if err := checkURL(dest); err != nil {
		return err
	}
	body := map[string]any{"destination": dest}
	if slug.set {
		body["slug"] = strings.ToLower(slug.value)
	}
	if domain.set {
		body["domain"] = strings.ToLower(domain.value)
	}
	if len(tags) > 0 {
		body["tags"] = tags
	}
	if expires.set {
		at, err := parseExpires(expires.value, a.now())
		if err != nil {
			return err
		}
		body["expiresAt"] = at
	}
	c, err := a.connect()
	if err != nil {
		return err
	}
	var l link
	if err := c.json(ctx, request{method: http.MethodPost, path: "/links", body: body}, &l); err != nil {
		if hasStatus(err, http.StatusConflict) && slug.set {
			return fmt.Errorf("The slug %q could not be used. Choose another with --slug, or leave it out for a random one.\n%w", slug.value, err)
		}
		return err
	}
	if checkURL(l.ShortURL) != nil || clean(l.ShortURL) != l.ShortURL {
		return c.notCurt()
	}
	if l.SyncPending {
		flag := "--enable"
		if l.Disabled {
			flag = "--disable"
		}
		a.say("Created, but pending. %s To retry now: curt edit %s %s", pendingText, l.ShortURL, flag)
	}
	_, err = fmt.Fprintln(a.stdout, l.ShortURL)
	return err
}

func (a *app) list(ctx context.Context, args []string, search bool) error {
	name := "list"
	if search {
		name = "search"
	}
	var tag, domain once
	var asJSON bool
	var limit int
	pos, err := parse(name, args, func(f *flag.FlagSet) {
		f.Var(&tag, "tag", "")
		f.Var(&domain, "domain", "")
		f.BoolVar(&asJSON, "json", false, "")
		f.IntVar(&limit, "limit", 50, "")
	})
	if err != nil {
		return err
	}
	if limit < 1 {
		return usagef("--limit must be at least 1")
	}
	q := url.Values{}
	if search {
		if len(pos) == 0 {
			return usagef("missing search text. See curt --help.")
		}
		q.Set("q", strings.Join(pos, " "))
	} else if len(pos) > 0 {
		return usagef("list takes no arguments. Use curt search to find links.")
	}
	if tag.set {
		q.Set("tag", strings.ToLower(tag.value))
	}
	if domain.set {
		q.Set("domain", strings.ToLower(domain.value))
	}
	// One extra row shows whether there are more. Pages hold at most 100.
	q.Set("limit", strconv.Itoa(min(limit, 99)+1))
	c, err := a.connect()
	if err != nil {
		return err
	}
	links, more := []link{}, false
	err = c.eachLink(ctx, q, func(l link) bool {
		if len(links) == limit {
			more = true
			return false
		}
		links = append(links, l)
		return true
	})
	if err != nil {
		return err
	}
	if asJSON {
		enc := json.NewEncoder(a.stdout)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		err = enc.Encode(links)
	} else {
		err = a.table(links)
	}
	if err != nil {
		return err
	}
	if len(links) == 0 && !asJSON {
		a.say("No links found.")
	}
	if more {
		a.say("Showing the first %d. Use --limit to see more.", limit)
	}
	return nil
}

func (a *app) table(links []link) error {
	if len(links) == 0 {
		return nil
	}
	w := tabwriter.NewWriter(a.stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "SHORT URL\tDESTINATION\tSTATUS\tTAGS")
	for _, l := range links {
		status := "active"
		switch {
		case l.Disabled:
			status = "disabled"
		case l.ExpiresAt != nil && *l.ExpiresAt <= a.now().Unix():
			status = "expired"
		case l.ExpiresAt != nil:
			status = "until " + time.Unix(*l.ExpiresAt, 0).In(a.now().Location()).Format("2006-01-02 15:04")
		}
		if l.SyncPending {
			status += " (pending)"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", clean(l.ShortURL), clean(l.Destination), status, clean(strings.Join(l.Tags, ", ")))
	}
	if err := w.Flush(); err != nil {
		return err
	}
	if slices.ContainsFunc(links, func(l link) bool { return l.SyncPending }) {
		a.say("Some links are pending. %s", pendingText)
	}
	return nil
}

var idForm = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// find turns a slug, ID or short URL into exactly one link, or fails. It never
// picks between several.
func (a *app) find(ctx context.Context, c *client, arg string, domain once) (link, error) {
	slug, host := arg, strings.ToLower(domain.value)
	if strings.Contains(arg, "://") {
		u, err := url.Parse(arg)
		if err != nil || u.Host == "" || strings.Trim(u.Path, "/") == "" {
			return link{}, usagef("that is not a short URL")
		}
		h := strings.ToLower(u.Host)
		if host != "" && host != h {
			return link{}, usagef("--domain %s does not match the short URL", host)
		}
		slug, host = strings.Trim(u.Path, "/"), h
	}
	slug = strings.ToLower(slug)
	if !idForm.MatchString(slug) {
		return link{}, usagef("that is not a slug, link ID or short URL")
	}

	var matches []link
	q := url.Values{"slug": {slug}, "limit": {"100"}}
	if host != "" {
		q.Set("domain", host)
	}
	err := c.eachLink(ctx, q, func(l link) bool {
		// Checked again here in case the server ignores the slug filter.
		if strings.ToLower(l.Slug) != slug || (host != "" && strings.ToLower(l.Domain) != host) {
			return true
		}
		matches = append(matches, l)
		return host == "" // a slug is unique within a domain
	})
	if err != nil {
		return link{}, err
	}
	// With a domain the argument is always a slug. The two words are other
	// endpoints under /links.
	if host == "" && arg != "availability" && arg != "stats" {
		var l link
		err := c.json(ctx, request{method: http.MethodGet, path: "/links/" + url.PathEscape(arg)}, &l)
		switch {
		case hasStatus(err, http.StatusNotFound, http.StatusBadRequest):
		case err != nil:
			return link{}, err
		case l.ID == arg && !slices.ContainsFunc(matches, func(m link) bool { return m.ID == l.ID }):
			matches = append(matches, l)
		}
	}

	switch len(matches) {
	case 0:
		where := ""
		if host != "" {
			where = " on " + host
		}
		return link{}, fmt.Errorf("No link %q%s. It does not exist or is not yours.", arg, where)
	case 1:
		if !idForm.MatchString(matches[0].ID) {
			return link{}, c.notCurt()
		}
		return matches[0], nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Several links match %q. Which one? Run again with --domain, or use the short URL:", arg)
	for _, m := range matches {
		fmt.Fprintf(&b, "\n  %s -> %s", clean(m.ShortURL), clean(m.Destination))
	}
	return link{}, &usageError{b.String()}
}

func (a *app) edit(ctx context.Context, args []string) error {
	var domain, dest, expires once
	var tags many
	var noTags, disable, enable bool
	pos, err := parse("edit", args, func(f *flag.FlagSet) {
		f.Var(&domain, "domain", "")
		f.Var(&dest, "url", "")
		f.Var(&expires, "expires", "")
		f.Var(&tags, "tag", "")
		f.BoolVar(&noTags, "no-tags", false, "")
		f.BoolVar(&disable, "disable", false, "")
		f.BoolVar(&enable, "enable", false, "")
	})
	if err != nil {
		return err
	}
	if err := wantArgs(pos, 1, "slug or link ID"); err != nil {
		return err
	}
	if disable && enable {
		return usagef("use --disable or --enable, not both")
	}
	if noTags && len(tags) > 0 {
		return usagef("use --tag or --no-tags, not both")
	}
	body := map[string]any{}
	if dest.set {
		if err := checkURL(dest.value); err != nil {
			return usagef("--url needs a full URL that starts with https:// or http://")
		}
		body["destination"] = dest.value
	}
	if len(tags) > 0 {
		body["tags"] = tags
	} else if noTags {
		body["tags"] = []string{}
	}
	if expires.set {
		at, err := parseExpires(expires.value, a.now())
		if err != nil {
			return err
		}
		body["expiresAt"] = at
	}
	if disable || enable {
		body["disabled"] = disable
	}
	if len(body) == 0 {
		return usagef("nothing to change. See curt --help.")
	}
	c, err := a.connect()
	if err != nil {
		return err
	}
	l, err := a.find(ctx, c, pos[0], domain)
	if err != nil {
		return err
	}
	var updated link
	err = c.json(ctx, request{
		method: http.MethodPatch, path: "/links/" + url.PathEscape(l.ID),
		body: body, ifMatch: strconv.FormatInt(l.Version, 10),
	}, &updated)
	if err != nil {
		return err
	}
	if updated.SyncPending {
		a.say("Saved %s, but pending. %s To retry now, run the same edit again.", l.ShortURL, pendingText)
		return nil
	}
	a.say("Updated %s. The change may take about a minute to reach everyone.", l.ShortURL)
	return nil
}

func (a *app) delete(ctx context.Context, args []string) error {
	var domain once
	var yes bool
	pos, err := parse("delete", args, func(f *flag.FlagSet) {
		f.Var(&domain, "domain", "")
		f.BoolVar(&yes, "yes", false, "")
	})
	if err != nil {
		return err
	}
	if err := wantArgs(pos, 1, "slug or link ID"); err != nil {
		return err
	}
	if !yes && !a.stdinIsTerm {
		return usagef("delete asks first. Add --yes to delete without a terminal.")
	}
	c, err := a.connect()
	if err != nil {
		return err
	}
	l, err := a.find(ctx, c, pos[0], domain)
	if err != nil {
		return err
	}
	if !yes {
		fmt.Fprintf(a.stderr, "Delete %s -> %s? This cannot be undone. [y/N] ", clean(l.ShortURL), clean(l.Destination))
		answer, err := waitFor(ctx, func() (string, error) { return readLine(a.stdin) })
		if err != nil {
			return err
		}
		if answer = strings.ToLower(answer); answer != "y" && answer != "yes" {
			return errors.New("not deleted")
		}
	}
	pending, err := c.do(ctx, request{method: http.MethodDelete, path: "/links/" + url.PathEscape(l.ID)})
	if err != nil {
		return err
	}
	if len(pending) > 0 {
		a.say("Deleted %s, but pending. %s", l.ShortURL, pendingText)
		return nil
	}
	a.say("Deleted %s. It may keep working for about a minute.", l.ShortURL)
	return nil
}

func (a *app) qr(ctx context.Context, args []string) error {
	var domain, out once
	pos, err := parse("qr", args, func(f *flag.FlagSet) {
		f.Var(&domain, "domain", "")
		f.Var(&out, "o", "")
	})
	if err != nil {
		return err
	}
	if err := wantArgs(pos, 1, "slug or link ID"); err != nil {
		return err
	}
	c, err := a.connect()
	if err != nil {
		return err
	}
	l, err := a.find(ctx, c, pos[0], domain)
	if err != nil {
		return err
	}
	svg, err := c.do(ctx, request{method: http.MethodGet, path: "/links/" + url.PathEscape(l.ID) + "/qr", accept: "image/svg+xml"})
	if err != nil {
		return err
	}
	if out.set && out.value != "-" {
		return os.WriteFile(out.value, svg, 0o644)
	}
	_, err = a.stdout.Write(svg)
	return err
}

func (a *app) export(ctx context.Context, args []string) error {
	var out once
	pos, err := parse("export", args, func(f *flag.FlagSet) { f.Var(&out, "o", "") })
	if err != nil {
		return err
	}
	if err := wantArgs(pos, 0, ""); err != nil {
		return err
	}
	c, err := a.connect()
	if err != nil {
		return err
	}
	links, err := fetchExport(ctx, c.do, c)
	if err != nil {
		return err
	}
	data, err := json.Marshal(map[string]any{"links": links, "nextCursor": nil})
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if out.set && out.value != "-" {
		return writePrivate(out.value, data)
	}
	_, err = a.stdout.Write(data)
	return err
}

// fetchExport returns every link as the server sent it, so fields this version
// does not know survive. It returns nothing unless every page is in: a backup
// cut short looks like a good one until it is needed.
func fetchExport(ctx context.Context, do func(context.Context, request) ([]byte, error), c *client) ([]json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, exportTimeout)
	defer cancel()
	links := []json.RawMessage{}
	q, seen := url.Values{}, map[string]bool{}
	for {
		var page struct {
			Links      []json.RawMessage `json:"links"`
			NextCursor *string           `json:"nextCursor"`
		}
		data, err := do(ctx, request{method: http.MethodGet, path: "/export", query: q, timeout: exportTimeout, limit: maxExport})
		if err != nil {
			return nil, fmt.Errorf("The export did not finish; nothing was written.\n%w", err)
		}
		if json.Unmarshal(data, &page) != nil {
			return nil, errors.New("the export is incomplete or damaged; nothing was written")
		}
		if page.Links == nil {
			return nil, c.notCurt()
		}
		links = append(links, page.Links...)
		if page.NextCursor == nil || *page.NextCursor == "" {
			return links, nil
		}
		if seen[*page.NextCursor] {
			return nil, errors.New("the server repeated a page of the export; nothing was written")
		}
		seen[*page.NextCursor] = true
		q.Set("cursor", *page.NextCursor)
	}
}

func (a *app) login(ctx context.Context, args []string) error {
	pos, err := parse("login", args, func(*flag.FlagSet) {})
	if err != nil {
		return err
	}
	if len(pos) > 1 {
		return usagef("too many arguments. The token is never an argument; curt login asks for it or reads it from stdin.")
	}
	raw := a.getenv("CURT_URL")
	if len(pos) == 1 {
		raw = pos[0]
	} else if raw == "" {
		if cfg, err := a.load(); err == nil {
			raw = cfg.URL
		}
	}
	if raw == "" {
		if !a.stdinIsTerm {
			return usagef("missing server address. Use: curt login https://app.go.example")
		}
		fmt.Fprint(a.stderr, "Server address (like https://app.go.example): ")
		if raw, err = waitFor(ctx, func() (string, error) { return readLine(a.stdin) }); err != nil {
			return err
		}
	}
	base, err := parseServer(raw)
	if err != nil {
		return err
	}
	var token string
	if a.stdinIsTerm {
		fmt.Fprintf(a.stderr, "API token for %s (not shown): ", base)
		token, err = a.readPassword(ctx)
		fmt.Fprintln(a.stderr)
	} else {
		token, err = readOne(ctx, a.stdin, "token")
	}
	if err != nil {
		return err
	}
	token = strings.TrimSpace(token)
	if err := checkToken(token); err != nil {
		return err
	}
	a.token = token

	var me struct {
		ID   string  `json:"id"`
		Name *string `json:"name"`
	}
	c := newClient(base, token)
	if err := c.json(ctx, request{method: http.MethodGet, path: "/me"}, &me); err != nil {
		return err
	}
	if me.ID == "" {
		return c.notCurt()
	}
	path, err := a.save(savedConfig{URL: base, Token: token})
	if err != nil {
		return fmt.Errorf("could not save the token: %w", err)
	}
	who := ""
	if me.Name != nil && *me.Name != "" {
		who = " as " + *me.Name
	}
	a.say("Signed in to %s%s. Saved in %s.", c.host(), who, path)
	if t := a.getenv("CURT_TOKEN"); t != "" {
		a.say("Note: CURT_TOKEN is set and takes priority over the saved token.")
	}
	return nil
}

func (a *app) logout(args []string) error {
	pos, err := parse("logout", args, func(*flag.FlagSet) {})
	if err != nil {
		return err
	}
	if err := wantArgs(pos, 0, ""); err != nil {
		return err
	}
	path, err := a.configPath()
	if err != nil {
		return err
	}
	switch err := os.Remove(path); {
	case errors.Is(err, fs.ErrNotExist):
		a.say("Not signed in; nothing to remove.")
	case err != nil:
		return err
	default:
		a.say("Removed the saved token. It still works elsewhere until you revoke it in the dashboard.")
	}
	if a.getenv("CURT_TOKEN") != "" {
		a.say("Note: CURT_TOKEN is still set in this shell.")
	}
	return nil
}

func (a *app) version(args []string) error {
	pos, err := parse("version", args, func(*flag.FlagSet) {})
	if err != nil {
		return err
	}
	if err := wantArgs(pos, 0, ""); err != nil {
		return err
	}
	_, err = fmt.Fprintln(a.stdout, "curt "+buildVersion())
	return err
}
