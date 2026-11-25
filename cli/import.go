package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	importPace     = 200 * time.Millisecond
	importAttempts = 6
	importMaxWait  = 2 * time.Minute
	importMaxFile  = 1 << 30
	// After this many failures in a row that are the server's or network's
	// fault, trying the rest would only be noise.
	importGiveUp = 5
)

var (
	slugForm = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$`)
	tagForm  = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N} _-]*$`)
)

// wanted is one link from the file, after domain mapping.
type wanted struct {
	domain, slug, dest string
	tags               []string
	expires            *int64
	disabled           bool
	created            int64
}

func (w *wanted) name() string { return w.domain + "/" + w.slug }

type action int

const (
	doCreate action = iota
	doSkip
	isConflict
	isImpossible
	isFailed
	isUntried
)

// entry is one line of the plan, and later of the result.
type entry struct {
	wanted
	act     action
	note    string
	pending bool // the server has not updated the redirect copy yet
	live    bool // exists, should be disabled, is not
}

func units16(s string) int { return len(utf16.Encode([]rune(s))) }

// readImport checks the whole file. Every problem found here means the file is
// not a complete export, so nothing is done with any of it.
func readImport(path string) ([]wanted, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, importMaxFile+1))
	if err != nil {
		return nil, err
	}
	if len(data) > importMaxFile {
		return nil, errors.New("the file is too large")
	}
	var doc struct {
		Links      []json.RawMessage `json:"links"`
		NextCursor *string           `json:"nextCursor"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("%s is not a complete curt export; nothing was changed", path)
	}
	if doc.Links == nil {
		return nil, fmt.Errorf("%s has no list of links; nothing was changed", path)
	}
	if doc.NextCursor != nil && *doc.NextCursor != "" {
		return nil, fmt.Errorf("%s holds only part of an export; nothing was changed", path)
	}
	var out []wanted
	var problems []string
	seen := map[string]bool{}
	for i, raw := range doc.Links {
		w, problem := readLink(raw)
		if problem == "" && seen[w.name()] {
			problem = w.name() + " appears twice"
		}
		if problem != "" {
			problems = append(problems, fmt.Sprintf("link %d: %s", i+1, problem))
			continue
		}
		seen[w.name()] = true
		out = append(out, w)
	}
	if n := len(problems); n > 0 {
		if n > 20 {
			problems = append(problems[:20], fmt.Sprintf("and %d more", n-20))
		}
		return nil, fmt.Errorf("%s is not valid; nothing was changed:\n  %s", path, strings.Join(problems, "\n  "))
	}
	// Oldest first, so lists on the new server keep their order.
	slices.SortStableFunc(out, func(a, b wanted) int { return cmp.Compare(a.created, b.created) })
	return out, nil
}

// readLink requires every field import uses. Guessing a missing "disabled", for
// example, could bring a disabled link back to life.
func readLink(raw json.RawMessage) (wanted, string) {
	var in struct {
		Domain      *string         `json:"domain"`
		Slug        *string         `json:"slug"`
		Destination *string         `json:"destination"`
		Tags        *[]string       `json:"tags"`
		ExpiresAt   json.RawMessage `json:"expiresAt"`
		Disabled    *bool           `json:"disabled"`
		CreatedAt   int64           `json:"createdAt"`
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return wanted{}, "a field has the wrong type"
	}
	switch {
	case in.Domain == nil || strings.TrimSpace(*in.Domain) == "":
		return wanted{}, "no domain"
	case in.Slug == nil || strings.TrimSpace(*in.Slug) == "":
		return wanted{}, "no slug"
	case in.Destination == nil || *in.Destination == "":
		return wanted{}, "no destination"
	case in.Tags == nil:
		return wanted{}, "no tags"
	case in.ExpiresAt == nil:
		return wanted{}, "no expiresAt"
	case in.Disabled == nil:
		return wanted{}, "no disabled"
	}
	w := wanted{
		domain:   strings.ToLower(strings.TrimSpace(*in.Domain)),
		slug:     strings.ToLower(strings.TrimSpace(*in.Slug)),
		dest:     *in.Destination,
		tags:     normalTags(*in.Tags),
		disabled: *in.Disabled,
		created:  in.CreatedAt,
	}
	if !bytes.Equal(in.ExpiresAt, []byte("null")) {
		var at int64
		if json.Unmarshal(in.ExpiresAt, &at) != nil || at <= 0 {
			return wanted{}, "expiresAt is not a time"
		}
		w.expires = &at
	}
	return w, ""
}

func normalTags(in []string) []string {
	out := []string{}
	for _, t := range in {
		out = append(out, strings.ToLower(strings.TrimSpace(t)))
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// refusal says why the API would never accept a link, or "".
func refusal(w *wanted, ownHosts []string) string {
	if !slugForm.MatchString(w.slug) {
		return "the slug is not valid"
	}
	if checkURL(w.dest) != nil {
		return "the destination is not an http or https URL"
	}
	if units16(w.dest) > 4096 {
		return "the destination is too long"
	}
	if slices.Contains(ownHosts, urlHost(w.dest)) {
		return "the destination is one of this server's own domains"
	}
	if len(w.tags) > 20 {
		return "it has more than 20 tags"
	}
	for _, t := range w.tags {
		if !tagForm.MatchString(t) || units16(t) > 32 {
			return fmt.Sprintf("the tag %q is not valid", t)
		}
	}
	return ""
}

// sameDestination allows for the server's URL normalization of hand-edited files.
func sameDestination(a, b string) bool {
	if a == b {
		return true
	}
	norm := func(s string) (string, bool) {
		u, err := url.Parse(s)
		if err != nil {
			return "", false
		}
		u.Scheme, u.Host = strings.ToLower(u.Scheme), strings.ToLower(u.Host)
		if u.Path == "" {
			u.Path = "/"
		}
		return u.String(), true
	}
	x, ok1 := norm(a)
	y, ok2 := norm(b)
	return ok1 && ok2 && x == y
}

// expired reports whether the API would refuse the link's expiry.
func (w *wanted) expired(now time.Time) bool { return w.expires != nil && *w.expires <= now.Unix() }

// final is what the link should look like when the import is done with it.
func (w *wanted) final(now time.Time) (expires *int64, disabled bool) {
	if w.expired(now) {
		return nil, true
	}
	return w.expires, w.disabled
}

func parseDomainMap(args []string) (map[string]string, error) {
	out := map[string]string{}
	for _, a := range args {
		from, to, ok := strings.Cut(strings.ToLower(a), "=")
		from, to = strings.TrimSpace(from), strings.TrimSpace(to)
		if !ok || from == "" || to == "" {
			return nil, usagef("--domain-map must look like old.example=new.example")
		}
		if _, dup := out[from]; dup {
			return nil, usagef("--domain-map names %s twice", from)
		}
		out[from] = to
	}
	return out, nil
}

type importer struct {
	*app
	c     *client
	me    string
	admin bool
	last  bool // a request was made before, so wait before the next
	// Set once the server has ignored "disabled" on a create.
	noDisabled bool
}

// send paces requests and retries 429 and 503. Requests use ctx; waiting also
// stops when wait is done, so an interrupt does not sit through a long pause.
// unsure is true when some attempt may have been carried out without saying so.
func (im *importer) send(ctx, wait context.Context, r request) (data []byte, unsure bool, err error) {
	for attempt := 1; ; attempt++ {
		pause := importPace
		if attempt > 1 {
			pause = min(time.Second<<(attempt-2), importMaxWait)
			var ae *apiError
			if errors.As(err, &ae) && ae.retryAfter > 0 {
				pause = min(ae.retryAfter, importMaxWait)
			}
		}
		if im.last || attempt > 1 {
			if serr := im.sleep(wait, pause); serr != nil {
				if err == nil {
					err = errors.New("interrupted")
				}
				return nil, unsure, err
			}
		}
		im.last = true
		data, err = im.c.do(ctx, r)
		if err == nil {
			return data, unsure, nil
		}
		// An unreadable 200 or a 5xx does not say whether the change was made.
		var ae *apiError
		if !errors.As(err, &ae) || ae.status >= 500 {
			unsure = true
		}
		if !hasStatus(err, http.StatusTooManyRequests, http.StatusServiceUnavailable) || attempt == importAttempts {
			return nil, unsure, err
		}
	}
}

func (im *importer) get(ctx context.Context, path string, q url.Values, out any) error {
	data, _, err := im.send(ctx, ctx, request{method: http.MethodGet, path: path, query: q})
	if err != nil {
		return err
	}
	if json.Unmarshal(data, out) != nil {
		return im.c.notCurt()
	}
	return nil
}

func (a *app) importLinks(ctx context.Context, args []string) error {
	var maps many
	var apply bool
	pos, err := parse("import", args, func(f *flag.FlagSet) {
		f.Var(&maps, "domain-map", "")
		f.BoolVar(&apply, "apply", false, "")
	})
	if err != nil {
		return err
	}
	if err := wantArgs(pos, 1, "file"); err != nil {
		return err
	}
	domainMap, err := parseDomainMap(maps)
	if err != nil {
		return err
	}
	links, err := readImport(pos[0])
	if err != nil {
		return err
	}
	for from := range domainMap {
		if !slices.ContainsFunc(links, func(w wanted) bool { return w.domain == from }) {
			return usagef("--domain-map: no link in the file is on %s", from)
		}
	}
	for i := range links {
		if to, ok := domainMap[links[i].domain]; ok {
			links[i].domain = to
		}
	}
	c, err := a.connect()
	if err != nil {
		return err
	}
	im := &importer{app: a, c: c}
	plan, err := im.plan(ctx, links, domainMap, !apply)
	if err != nil {
		return fmt.Errorf("Nothing was changed.\n%w", err)
	}
	if apply {
		err = im.apply(ctx, plan)
	} else {
		for i := range plan {
			im.report(&plan[i], false)
		}
	}
	return im.finish(plan, apply, err)
}

// plan decides what to do with every link without changing anything.
func (im *importer) plan(ctx context.Context, links []wanted, domainMap map[string]string, checkTaken bool) ([]entry, error) {
	var me struct {
		ID      string `json:"id"`
		IsAdmin bool   `json:"isAdmin"`
	}
	if err := im.get(ctx, "/me", nil, &me); err != nil {
		return nil, err
	}
	var doms struct {
		Domains []struct {
			Host string `json:"host"`
		} `json:"domains"`
	}
	if err := im.get(ctx, "/domains", nil, &doms); err != nil {
		return nil, err
	}
	if me.ID == "" || doms.Domains == nil {
		return nil, im.c.notCurt()
	}
	im.me, im.admin = me.ID, me.IsAdmin
	var hosts []string
	for _, d := range doms.Domains {
		hosts = append(hosts, strings.ToLower(d.Host))
	}
	for from, to := range domainMap {
		if !slices.Contains(hosts, to) {
			return nil, usagef("--domain-map %s=%s: %s is not configured on this server", from, to, to)
		}
	}
	raws, err := fetchExport(ctx, func(ctx context.Context, r request) ([]byte, error) {
		data, _, err := im.send(ctx, ctx, r)
		return data, err
	}, im.c)
	if err != nil {
		return nil, err
	}
	have := map[string]link{}
	for _, raw := range raws {
		var l link
		if json.Unmarshal(raw, &l) != nil {
			return nil, im.c.notCurt()
		}
		have[strings.ToLower(l.Domain+"/"+l.Slug)] = l
	}

	times := map[string]int{}
	for i := range links {
		times[links[i].name()]++
	}
	own := append(slices.Clone(hosts), urlHost(im.c.base))
	plan := make([]entry, 0, len(links))
	if checkTaken && !im.admin && len(links) > 50 {
		im.say("Checking up to %d slugs, about 5 a second.", len(links))
	}
	for _, w := range links {
		e := entry{wanted: w}
		l, exists := have[w.name()]
		why := refusal(&w, own)
		switch {
		case !slices.Contains(hosts, w.domain):
			e.act, e.note = isImpossible, "this server has no domain "+w.domain+"; use --domain-map "+w.domain+"=NEW"
		case times[w.name()] > 1:
			e.act, e.note = isConflict, "--domain-map moves several links here"
		case exists:
			im.compare(&e, l)
		case why != "":
			e.act, e.note = isImpossible, why
		case checkTaken && !im.admin:
			// Members cannot see other people's links, only that a slug is taken.
			var free struct {
				Available *bool   `json:"available"`
				Reason    *string `json:"reason"`
			}
			if err := im.get(ctx, "/links/availability", url.Values{"domain": {w.domain}, "slug": {w.slug}}, &free); err != nil {
				return nil, err
			}
			if free.Available == nil {
				return nil, im.c.notCurt()
			}
			if !*free.Available {
				e.act, e.note = isConflict, "the slug is taken by a link you cannot see"
				if free.Reason != nil && *free.Reason != "taken" {
					e.act, e.note = isImpossible, "the slug is "+*free.Reason
				}
			}
		}
		plan = append(plan, e)
	}
	return plan, nil
}

func sameTime(a, b *int64) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

// compare decides what an existing link on the same domain and slug means.
func (im *importer) compare(e *entry, l link) {
	if !sameDestination(l.Destination, e.dest) {
		e.act, e.note = isConflict, "already exists with destination "+l.Destination
		return
	}
	expires, disabled := e.final(im.now())
	e.act, e.note, e.pending = doSkip, "", l.SyncPending
	var differs []string
	if !slices.Equal(normalTags(l.Tags), e.tags) {
		differs = append(differs, "tags")
	}
	// The link may be as import leaves it or, on the original server, as exported.
	if !sameTime(expires, l.ExpiresAt) && !sameTime(e.expires, l.ExpiresAt) {
		differs = append(differs, "expiry")
	}
	if disabled != l.Disabled && (e.disabled != l.Disabled || !sameTime(e.expires, l.ExpiresAt)) {
		differs = append(differs, "disabled")
		e.live = disabled
	}
	if len(differs) > 0 {
		e.note = "left as it is; differs in " + strings.Join(differs, ", ")
	}
	if e.live {
		e.note += "; it is LIVE but should be disabled: curt edit " + l.ShortURL + " --disable"
	}
}

func (im *importer) apply(ctx context.Context, plan []entry) error {
	var stop error
	failures := 0
	for i := range plan {
		e := &plan[i]
		if e.act != doCreate {
			im.report(e, true)
			continue
		}
		if stop == nil && ctx.Err() != nil {
			stop = errors.New("interrupted")
		}
		if stop != nil {
			e.act = isUntried
			continue
		}
		// A link that was started is finished even after an interrupt.
		err := im.create(context.WithoutCancel(ctx), ctx, e)
		if err != nil {
			e.act, e.note = isFailed, strings.ReplaceAll(err.Error(), "\n", " ")
		}
		im.report(e, true)
		var ae *apiError
		var own *linkError
		switch {
		case err == nil:
			failures = 0
		case errors.As(err, &own): // says nothing about the rest
		case hasStatus(err, http.StatusUnauthorized, http.StatusForbidden):
			stop = errors.New("stopped, because the rest would fail the same way")
		case !errors.As(err, &ae) || ae.status == http.StatusTooManyRequests || ae.status >= 500:
			if failures++; failures == importGiveUp {
				stop = fmt.Errorf("stopped after %d failures in a row", failures)
			}
		default:
			failures = 0
		}
	}
	return stop
}

// linkError is a failure of one link only.
type linkError struct{ msg string }

func (e *linkError) Error() string { return e.msg }

func liveError(l link) error {
	return &linkError{"the server ignored \"disabled\", so the link was created and is LIVE. Turn it off: curt edit " + l.ShortURL + " --disable"}
}

// create makes the link in its final state in one request. It is never created
// enabled and then disabled: the redirect copy accepts one write per second per
// link, so the second write could be lost and the link stay live.
func (im *importer) create(ctx, wait context.Context, e *entry) error {
	expires, disabled := e.final(im.now())
	if disabled && im.noDisabled {
		return &linkError{"not created: this server cannot create disabled links, so it would have been live"}
	}
	past := e.expired(im.now())
	body := map[string]any{"domain": e.domain, "slug": e.slug, "destination": e.dest, "tags": e.tags}
	if expires != nil {
		body["expiresAt"] = *expires
	}
	if disabled {
		body["disabled"] = true
	}
	data, unsure, err := im.send(ctx, wait, request{method: http.MethodPost, path: "/links", body: body})
	var ae *apiError
	if errors.As(err, &ae) && ae.code == "expiry_in_past" && !past {
		// It ran out meanwhile, or the clocks disagree. Treat it as past from here on.
		one := int64(1)
		e.expires = &one
		return im.create(ctx, wait, e)
	}
	var l link
	if err == nil && (json.Unmarshal(data, &l) != nil || l.ID == "" || l.Slug != e.slug || l.Domain != e.domain) {
		err, unsure = im.c.notCurt(), true
	}
	if err == nil {
		e.pending = l.SyncPending
		if disabled && !l.Disabled {
			im.noDisabled = true
			return liveError(l)
		}
		return nil
	}
	if !unsure && !hasStatus(err, http.StatusConflict) {
		return err
	}
	// The slug is taken, possibly by our own create whose answer was lost.
	l, found, lerr := im.lookup(ctx, e)
	if lerr != nil || (!found && !hasStatus(err, http.StatusConflict)) {
		return err
	}
	if !found {
		e.act, e.note = isConflict, "the slug is taken by a link you cannot see"
		return nil
	}
	im.compare(e, l)
	if unsure && e.act == doSkip && l.Version == 1 && l.Owner.ID == im.me {
		if e.live {
			im.noDisabled = true
			return liveError(l)
		}
		if e.note == "" {
			e.act = doCreate
		}
	}
	return nil
}

func (im *importer) lookup(ctx context.Context, e *entry) (link, bool, error) {
	var p linkPage
	if err := im.get(ctx, "/links", url.Values{"domain": {e.domain}, "slug": {e.slug}, "limit": {"100"}}, &p); err != nil {
		return link{}, false, err
	}
	for _, l := range p.Links {
		if strings.EqualFold(l.Domain, e.domain) && strings.EqualFold(l.Slug, e.slug) {
			return l, true, nil
		}
	}
	return link{}, false, nil
}

func (im *importer) report(e *entry, done bool) {
	word := map[action][2]string{
		doCreate: {"create", "created"}, doSkip: {"skip", "skipped"},
		isConflict: {"conflict", "conflict"}, isImpossible: {"impossible", "impossible"}, isFailed: {"failed", "failed"},
	}[e.act]
	verb := word[0]
	if done {
		verb = word[1]
	}
	line := fmt.Sprintf("%-10s  %s -> %s", verb, e.name(), e.dest)
	var notes []string
	if e.act == doCreate {
		_, disabled := e.final(im.now())
		switch {
		case e.expired(im.now()):
			notes = append(notes, "expiry has passed: no expiry, disabled instead")
		case disabled:
			notes = append(notes, "disabled")
		}
	}
	if e.note != "" {
		notes = append(notes, e.note)
	}
	if e.pending {
		notes = append(notes, "pending: old behaviour may continue")
	}
	if len(notes) > 0 {
		line += " (" + strings.Join(notes, "; ") + ")"
	}
	if im.token != "" {
		line = strings.ReplaceAll(line, im.token, "[hidden]")
	}
	fmt.Fprintln(im.stdout, clean(line))
}

func (im *importer) finish(plan []entry, applied bool, stop error) error {
	n := map[action]int{}
	past, pending, live := 0, 0, 0
	for i := range plan {
		e := &plan[i]
		n[e.act]++
		if e.act == doCreate && e.expired(im.now()) {
			past++
		}
		if e.pending {
			pending++
		}
		if e.act == doSkip && e.live {
			live++
		}
	}
	create := "to create"
	if applied {
		create = "created"
	}
	fmt.Fprintf(im.stdout, "\n%d links: %d %s, %d skipped, %d conflicts, %d impossible", len(plan),
		n[doCreate], create, n[doSkip], n[isConflict], n[isImpossible])
	if applied {
		fmt.Fprintf(im.stdout, ", %d failed, %d not tried", n[isFailed], n[isUntried])
	}
	fmt.Fprintf(im.stdout, ", %d pending\n", pending)
	if past > 0 {
		im.say("%d links have already expired. They are restored disabled and without an expiry.", past)
	}
	if pending > 0 {
		im.say("%d links are pending. %s To retry one now: curt edit <short URL> --enable (or --disable, for one that is disabled).", pending, pendingText)
	}
	if live > 0 {
		im.say("Warning: %d existing links are live but disabled or expired in the file. They were left as they are.", live)
	}
	if !applied {
		im.say("Dry run; nothing was changed. New links would belong to you, with new IDs and no stats. Add --apply to do it.")
	}
	if stop != nil {
		return fmt.Errorf("%w. Run the same command again to continue", stop)
	}
	if bad := n[isConflict] + n[isImpossible] + n[isFailed]; bad > 0 {
		if applied {
			return fmt.Errorf("%d of %d links were not restored", bad, len(plan))
		}
		return fmt.Errorf("%d of %d links cannot be restored", bad, len(plan))
	}
	return nil
}
