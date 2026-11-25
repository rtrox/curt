package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// store is a fake server that keeps links and follows the real API's rules.
type store struct {
	srv     *httptest.Server
	domains []string
	admin   bool
	links   []link
	calls   []string
	// hook runs before each request; returning true means it answered.
	hook func(w http.ResponseWriter, r *http.Request) bool
	// after runs once a change is made; returning true means it answered.
	after func(w http.ResponseWriter, r *http.Request) bool
	// An older server that does not know "disabled" on create.
	ignoreDisabled bool
	pending        bool
}

var storeNow = time.Date(2030, 1, 1, 12, 0, 0, 0, time.UTC).Unix()

func newStore(t *testing.T, domains ...string) *store {
	s := &store{domains: domains, admin: true}
	s.srv = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *store) harness() *harness {
	return &harness{env: map[string]string{"CURT_URL": s.srv.URL, "CURT_TOKEN": testToken}}
}

func (s *store) sees(l link) bool { return s.admin || l.Owner.ID == "me" }

func (s *store) serve(w http.ResponseWriter, r *http.Request) {
	s.calls = append(s.calls, r.Method+" "+r.URL.Path)
	if s.hook != nil && s.hook(w, r) {
		return
	}
	q := r.URL.Query()
	path := strings.TrimPrefix(r.URL.Path, "/api/v1")
	switch {
	case path == "/me":
		sendJSON(w, 200, map[string]any{"id": "me", "name": nil, "email": nil, "isAdmin": s.admin})
	case path == "/domains":
		d := []map[string]string{}
		for _, h := range s.domains {
			d = append(d, map[string]string{"host": h})
		}
		sendJSON(w, 200, map[string]any{"domains": d})
	case path == "/export", path == "/links" && r.Method == "GET":
		out := []link{}
		for _, l := range s.links {
			if s.sees(l) && (q.Get("slug") == "" || q.Get("slug") == l.Slug) && (q.Get("domain") == "" || q.Get("domain") == l.Domain) {
				out = append(out, l)
			}
		}
		p := map[string]any{"links": out, "nextCursor": nil}
		if path == "/export" { // 500 per response, like the real one
			from, _ := strconv.Atoi(q.Get("cursor"))
			to := min(from+500, len(out))
			if p["links"] = out[from:to]; to < len(out) {
				p["nextCursor"] = strconv.Itoa(to)
			}
		}
		sendJSON(w, 200, p)
	case path == "/links/availability":
		taken := s.at(q.Get("domain"), q.Get("slug")) != nil
		sendJSON(w, 200, map[string]any{"available": !taken, "reason": map[bool]any{true: "taken", false: nil}[taken]})
	case path == "/links" && r.Method == "POST":
		var in link
		_ = json.NewDecoder(r.Body).Decode(&in)
		switch {
		case !slices.Contains(s.domains, in.Domain):
			sendCode(w, 400, "unknown_domain")
			return
		case in.ExpiresAt != nil && *in.ExpiresAt <= storeNow:
			sendCode(w, 400, "expiry_in_past")
			return
		case s.at(in.Domain, in.Slug) != nil:
			sendCode(w, 409, "slug_taken")
			return
		}
		in.ID = fmt.Sprintf("new%d", len(s.calls))
		in.ShortURL = "https://" + in.Domain + "/" + in.Slug
		if s.ignoreDisabled {
			in.Disabled = false
		}
		in.SyncPending = s.pending
		in.Version, in.Owner, in.CreatedAt = 1, owner{ID: "me"}, storeNow
		slices.Sort(in.Tags)
		s.links = append(s.links, in)
		if s.after == nil || !s.after(w, r) {
			sendJSON(w, 201, in)
		}
	case strings.HasPrefix(path, "/links/"):
		i := slices.IndexFunc(s.links, func(l link) bool { return l.ID == path[7:] && s.sees(l) })
		if i < 0 {
			sendCode(w, 404, "not_found")
			return
		}
		sendJSON(w, 200, s.links[i])
	default:
		sendCode(w, 404, "not_found")
	}
}

func sendCode(w http.ResponseWriter, status int, code string) {
	sendJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": "server says " + code}})
}

func (s *store) at(domain, slug string) *link {
	for i := range s.links {
		if s.links[i].Domain == domain && s.links[i].Slug == slug {
			return &s.links[i]
		}
	}
	return nil
}

func (s *store) changes() int {
	n := 0
	for _, c := range s.calls {
		if !strings.HasPrefix(c, "GET ") {
			n++
		}
	}
	return n
}

func exportFile(t *testing.T, links ...link) string {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"links": links, "nextCursor": nil})
	return rawFile(t, string(data))
}

func rawFile(t *testing.T, data string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "links.json")
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func at(sec int64) *int64 { return &sec }

// Reports on lines that carry both the verb and the name.
func (r result) wantLine(t *testing.T, verb, rest string) {
	t.Helper()
	for line := range strings.Lines(r.out) {
		if strings.HasPrefix(line, verb) && strings.Contains(line, rest) {
			return
		}
	}
	t.Errorf("no %q line with %q in:\n%s", verb, rest, r.out)
}

func (r result) wantSum(t *testing.T, code int, sum string) {
	t.Helper()
	if r.code != code || !strings.HasSuffix(r.out, "\n"+sum+"\n") {
		t.Errorf("exit %d, want %d with %q:\n%s%s", r.code, code, sum, r.out, r.errOut)
	}
}

func TestImportRoundTrip(t *testing.T) {
	src := newStore(t, "go.example", "s.example")
	plain, tagged := sample("a1", "go.example", "a"), sample("b1", "s.example", "a")
	plain.Tags, tagged.Tags = []string{}, []string{"wiki", "work"}
	off, future, gone, offGone := sample("c1", "go.example", "c"), sample("d1", "go.example", "d"), sample("e1", "go.example", "e"), sample("f1", "go.example", "f")
	off.Disabled, off.ExpiresAt = true, at(storeNow+9999)
	future.ExpiresAt = at(storeNow + 86400)
	gone.ExpiresAt, offGone.ExpiresAt, offGone.Disabled = at(storeNow-1), at(5), true
	weird := sample("g1", "go.example", "g")
	weird.Destination = "https://example.com/100%?q=<a>&b=\u2028"
	src.links = []link{plain, tagged, off, future, gone, offGone, weird}
	for i := range src.links {
		src.links[i].Owner.ID, src.links[i].CreatedAt = "someone", int64(100-i)
	}
	file := filepath.Join(t.TempDir(), "links.json")
	src.harness().run(t, "export", "-o", file).want(t, 0, "")

	dst := newStore(t, "go.example", "s.example")
	r := dst.harness().run(t, "import", file)
	r.wantSum(t, 0, "7 links: 7 to create, 0 skipped, 0 conflicts, 0 impossible, 0 pending")
	r.wantLine(t, "create", "go.example/e -> https://example.com/e (expiry has passed")
	if dst.changes() != 0 || !strings.Contains(r.errOut, "Dry run; nothing was changed") {
		t.Fatalf("dry run: %v %s", dst.calls, r.errOut)
	}
	r = dst.harness().run(t, "import", file, "--apply")
	r.wantSum(t, 0, "7 links: 7 created, 0 skipped, 0 conflicts, 0 impossible, 0 failed, 0 not tried, 0 pending")
	if !strings.Contains(r.errOut, "2 links have already expired") {
		t.Errorf("stderr %s", r.errOut)
	}

	for _, want := range src.links {
		got := dst.at(want.Domain, want.Slug)
		if got == nil {
			t.Errorf("%s missing", want.ShortURL)
			continue
		}
		if want.ExpiresAt != nil && *want.ExpiresAt <= storeNow {
			want.ExpiresAt, want.Disabled = nil, true
		}
		if got.Destination != want.Destination || !slices.Equal(got.Tags, want.Tags) || got.Disabled != want.Disabled ||
			!sameTime(got.ExpiresAt, want.ExpiresAt) || got.Owner.ID != "me" {
			t.Errorf("got %+v\nwant %+v", *got, want)
		}
	}
	if posts := dst.changes(); posts != 7 {
		t.Errorf("%d changes for 7 links: %v", posts, dst.calls)
	}
	if dst.links[0].Slug != "g" || dst.links[6].ShortURL != "https://go.example/a" {
		t.Errorf("not created oldest first: %+v", dst.links)
	}

	// Again: nothing to do, on either server, and no noise about differences.
	for _, s := range []*store{src, dst} {
		s.calls = nil
		r = s.harness().run(t, "import", file, "--apply")
		r.wantSum(t, 0, "7 links: 0 created, 7 skipped, 0 conflicts, 0 impossible, 0 failed, 0 not tried, 0 pending")
		if s.changes() != 0 || strings.Contains(r.out, "differs") {
			t.Errorf("second run: %v\n%s", s.calls, r.out)
		}
	}

	// What was restored can itself be exported and restored.
	again := filepath.Join(t.TempDir(), "again.json")
	dst.harness().run(t, "export", "-o", again).want(t, 0, "")
	third := newStore(t, "go.example", "s.example")
	third.harness().run(t, "import", again, "--apply").wantSum(t, 0,
		"7 links: 7 created, 0 skipped, 0 conflicts, 0 impossible, 0 failed, 0 not tried, 0 pending")
}

func TestImportNeverOverwrites(t *testing.T) {
	for _, flags := range [][]string{{}, {"--apply"}} {
		s := newStore(t, "go.example")
		other, same, live := sample("x", "go.example", "a"), sample("y", "go.example", "b"), sample("z", "go.example", "c")
		other.Destination = "https://example.com/different"
		same.Destination = "https://EXAMPLE.com"
		same.Tags = []string{"mine"}
		s.links = []link{other, same, live}
		b, c := sample("2", "go.example", "B"), sample("3", "go.example", "c")
		b.Destination = "https://example.com/"
		c.Disabled = true
		file := exportFile(t, sample("1", "go.example", "a"), b, c, sample("4", "go.example", "d"))
		before := fmt.Sprint(s.links)
		r := s.harness().run(t, append([]string{"import", file}, flags...)...)
		if r.code != 1 || fmt.Sprint(s.links[:3]) != before {
			t.Errorf("%v: %+v", flags, r)
		}
		r.wantLine(t, "conflict", "go.example/a -> https://example.com/a (already exists with destination https://example.com/different)")
		r.wantLine(t, "skip", "go.example/b -> https://example.com/ (left as it is; differs in tags)")
		r.wantLine(t, "skip", "differs in disabled")
		if (len(flags) == 1) != (s.at("go.example", "d") != nil) {
			t.Errorf("%v: links %v", flags, s.links)
		}
	}
}

func TestImportValidatesWholeFileFirst(t *testing.T) {
	good := `{"domain":"go.example","slug":"a","destination":"https://example.com","tags":[],"expiresAt":null,"disabled":false}`
	without := func(field string) string {
		var m map[string]any
		_ = json.Unmarshal([]byte(good), &m)
		delete(m, field)
		b, _ := json.Marshal(m)
		return string(b)
	}
	files := map[string]string{
		"empty": "", "not json": "x", "cut short": `{"links":[` + good, "trailing": `{"links":[]}{}`, "array": `[` + good + `]`,
		"no links": `{}`, "null links": `{"links":null}`, "partial": `{"links":[` + good + `],"nextCursor":"x"}`,
		"null link": `{"links":[` + good + `,null]}`, "twice": `{"links":[` + good + `,` + strings.ReplaceAll(good, `"a"`, `"A"`) + `]}`,
		"wrong type":  `{"links":[` + strings.ReplaceAll(good, `false`, `"no"`) + `]}`,
		"bad expiry":  `{"links":[` + strings.ReplaceAll(good, `"expiresAt":null`, `"expiresAt":"soon"`) + `]}`,
		"half second": `{"links":[` + strings.ReplaceAll(good, `"expiresAt":null`, `"expiresAt":1.5`) + `]}`,
	}
	for _, f := range []string{"domain", "slug", "destination", "tags", "expiresAt", "disabled"} {
		files["no "+f] = `{"links":[` + strings.ReplaceAll(good, `"a"`, `"first"`) + `,` + without(f) + `]}`
	}
	s := newStore(t, "go.example")
	for name, data := range files {
		r := s.harness().run(t, "import", rawFile(t, data), "--apply")
		if r.code != 1 || r.out != "" || !strings.Contains(r.errOut, "nothing was changed") {
			t.Errorf("%s: %+v", name, r)
		}
	}
	s.harness().run(t, "import", filepath.Join(t.TempDir(), "none")).want(t, 1, "", "no such file")
	if len(s.calls) != 0 {
		t.Errorf("calls %v", s.calls)
	}
	s.harness().run(t, "import", rawFile(t, `{"links":[],"nextCursor":null}`), "--apply").wantSum(t, 0,
		"0 links: 0 created, 0 skipped, 0 conflicts, 0 impossible, 0 failed, 0 not tried, 0 pending")
}

func TestImportImpossible(t *testing.T) {
	s := newStore(t, "go.example")
	bad := make([]link, 7)
	for i := range bad {
		bad[i] = sample("x", "go.example", fmt.Sprintf("s%d", i))
	}
	bad[0].Slug = "-no"
	bad[1].Destination = "javascript:alert(1)"
	bad[2].Destination = "https://user@GO.example.:443/x"
	bad[3].Tags = []string{"!"}
	bad[4].Tags = make([]string, 21)
	for i := range bad[4].Tags {
		bad[4].Tags[i] = fmt.Sprintf("t%d", i)
	}
	bad[5].Destination = "https://example.com/" + strings.Repeat("a", 4096)
	bad[6].Domain = "old.example"
	file := exportFile(t, append(bad, sample("ok", "go.example", "fine"))...)
	r := s.harness().run(t, "import", file)
	r.wantSum(t, 1, "8 links: 1 to create, 0 skipped, 0 conflicts, 7 impossible, 0 pending")
	r.wantLine(t, "impossible", "old.example/s6 -> https://example.com/s6 (this server has no domain old.example; use --domain-map old.example=NEW)")
	s.harness().run(t, "import", file, "--apply").wantSum(t, 1,
		"8 links: 1 created, 0 skipped, 0 conflicts, 7 impossible, 0 failed, 0 not tried, 0 pending")
	if s.changes() != 1 || s.at("go.example", "fine") == nil {
		t.Errorf("%v", s.calls)
	}
}

func TestImportDomainMap(t *testing.T) {
	s := newStore(t, "new.example", "go.example")
	file := exportFile(t, sample("1", "old.example", "a"), sample("2", "old.example", "b"), sample("3", "go.example", "a"))
	r := s.harness().run(t, "import", file, "--apply", "--domain-map", "Old.example=New.example")
	r.wantSum(t, 0, "3 links: 3 created, 0 skipped, 0 conflicts, 0 impossible, 0 failed, 0 not tried, 0 pending")
	if s.at("new.example", "a") == nil || s.at("new.example", "b") == nil || s.at("go.example", "a") == nil {
		t.Errorf("%v", s.links)
	}

	// Two links moved onto one name: neither is picked.
	s = newStore(t, "go.example")
	r = s.harness().run(t, "import", file, "--apply", "--domain-map", "old.example=go.example")
	r.wantSum(t, 1, "3 links: 1 created, 0 skipped, 2 conflicts, 0 impossible, 0 failed, 0 not tried, 0 pending")

	s.calls = nil
	for _, m := range []string{"x", "=y", "x=", "old.example=nowhere.example", "typo.example=go.example"} {
		if r := s.harness().run(t, "import", file, "--apply", "--domain-map", m); r.code != 2 {
			t.Errorf("%s: %+v", m, r)
		}
	}
	if r := s.harness().run(t, "import", file, "--domain-map", "old.example=go.example", "--domain-map", "old.example=x.example"); r.code != 2 {
		t.Errorf("%+v", r)
	}
	if s.changes() != 0 {
		t.Errorf("%v", s.calls)
	}
	s.harness().run(t, "import").want(t, 2, "", "missing file")
}

func TestImportRetries(t *testing.T) {
	for _, status := range []int{429, 503} {
		s := newStore(t, "go.example")
		n := 0
		s.hook = func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method != "POST" {
				return false
			}
			if n++; n < 3 {
				if n == 1 {
					w.Header().Set("Retry-After", "7")
				}
				sendCode(w, status, "slow")
				return true
			}
			return false
		}
		h := s.harness()
		h.run(t, "import", exportFile(t, sample("1", "go.example", "a")), "--apply").wantSum(t, 0,
			"1 links: 1 created, 0 skipped, 0 conflicts, 0 impossible, 0 failed, 0 not tried, 0 pending")
		if want := []time.Duration{importPace, importPace, importPace, 7 * time.Second, 2 * time.Second}; !slices.Equal(h.slept, want) {
			t.Errorf("slept %v, want %v", h.slept, want)
		}
	}
}

func TestImportKeepsGoing(t *testing.T) {
	s := newStore(t, "go.example")
	s.hook = func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != "POST" {
			return false
		}
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		if strings.Contains(string(body), `"slug":"b"`) {
			sendCode(w, 429, "slow")
			return true
		}
		if strings.Contains(string(body), `"slug":"c"`) {
			sendCode(w, 400, "invalid_request")
			return true
		}
		return false
	}
	file := exportFile(t, sample("1", "go.example", "a"), sample("2", "go.example", "b"), sample("3", "go.example", "c"), sample("4", "go.example", "d"))
	h := s.harness()
	r := h.run(t, "import", file, "--apply")
	r.wantSum(t, 1, "4 links: 2 created, 0 skipped, 0 conflicts, 0 impossible, 2 failed, 0 not tried, 0 pending")
	r.wantLine(t, "failed", "go.example/b")
	r.wantLine(t, "failed", "invalid_request")
	if !strings.Contains(r.errOut, "2 of 4 links were not restored") {
		t.Errorf("%s", r.errOut)
	}
	s.hook = nil
	s.harness().run(t, "import", file, "--apply").wantSum(t, 0,
		"4 links: 2 created, 2 skipped, 0 conflicts, 0 impossible, 0 failed, 0 not tried, 0 pending")
}

func TestImportStopsWhenHopeless(t *testing.T) {
	var links []link
	for i := range 9 {
		links = append(links, sample("x", "go.example", fmt.Sprintf("s%d", i)))
	}
	for status, sum := range map[int]string{
		500: "9 links: 0 created, 0 skipped, 0 conflicts, 0 impossible, 5 failed, 4 not tried, 0 pending",
		401: "9 links: 0 created, 0 skipped, 0 conflicts, 0 impossible, 1 failed, 8 not tried, 0 pending",
		403: "9 links: 0 created, 0 skipped, 0 conflicts, 0 impossible, 1 failed, 8 not tried, 0 pending",
	} {
		s := newStore(t, "go.example")
		s.hook = func(w http.ResponseWriter, r *http.Request) bool {
			if r.Method == "POST" {
				sendCode(w, status, "no")
			}
			return r.Method == "POST"
		}
		r := s.harness().run(t, "import", exportFile(t, links...), "--apply")
		r.wantSum(t, 1, sum)
		if !strings.Contains(r.errOut, "Run the same command again") {
			t.Errorf("%s", r.errOut)
		}
	}
}

func TestImportUnreachableOrRefusedChangesNothing(t *testing.T) {
	s := newStore(t, "go.example")
	file := exportFile(t, sample("1", "go.example", "a"))
	for _, path := range []string{"/me", "/domains", "/export"} {
		s.hook = func(w http.ResponseWriter, r *http.Request) bool {
			if strings.HasSuffix(r.URL.Path, path) {
				sendCode(w, 403, "forbidden")
				return true
			}
			return false
		}
		r := s.harness().run(t, "import", file, "--apply")
		r.want(t, 1, "", "Nothing was changed", "Not allowed")
	}
	if s.changes() != 0 {
		t.Errorf("%v", s.calls)
	}
}

// The connection drops before or after a disabled link is made. It must never be
// enabled, and the next run must find it done or do it.
func TestImportDisabledLostAnswer(t *testing.T) {
	off := sample("1", "go.example", "a")
	off.Disabled = true
	file := exportFile(t, off, sample("2", "go.example", "b"))
	for _, made := range []bool{false, true} {
		s := newStore(t, "go.example")
		drop := func(_ http.ResponseWriter, r *http.Request) bool {
			if r.Method == "POST" {
				panic(http.ErrAbortHandler)
			}
			return false
		}
		if made {
			s.after = drop
		} else {
			s.hook = drop
		}
		r := s.harness().run(t, "import", file, "--apply")
		if l := s.at("go.example", "a"); made != (r.code == 0) || (l != nil) != made || (l != nil && !l.Disabled) {
			t.Errorf("made=%v: %+v\n%s%s", made, l, r.out, r.errOut)
		}
		s.hook, s.after = nil, nil
		r = s.harness().run(t, "import", file, "--apply")
		if l := s.at("go.example", "a"); r.code != 0 || l == nil || !l.Disabled || l.Version != 1 || !slices.Equal(l.Tags, off.Tags) {
			t.Errorf("made=%v: %+v\n%s%s", made, l, r.out, r.errOut)
		}
	}
}

func TestImportLostAnswerCountsAsCreated(t *testing.T) {
	off := sample("1", "go.example", "a")
	off.Disabled = true
	for _, l := range []link{sample("1", "go.example", "a"), off} {
		for name, after := range map[string]func(http.ResponseWriter, *http.Request) bool{
			"dropped": func(http.ResponseWriter, *http.Request) bool { panic(http.ErrAbortHandler) },
			// Made but answered 503, so the retry gets 409.
			"503": func(w http.ResponseWriter, _ *http.Request) bool { sendCode(w, 503, "x"); return true },
		} {
			s := newStore(t, "go.example")
			s.after = after
			r := s.harness().run(t, "import", exportFile(t, l), "--apply")
			r.wantSum(t, 0, "1 links: 1 created, 0 skipped, 0 conflicts, 0 impossible, 0 failed, 0 not tried, 0 pending")
			if got := s.at("go.example", "a"); got.Disabled != l.Disabled {
				t.Errorf("%s: %+v", name, got)
			}
		}
	}
}

func TestImportServerIgnoresDisabled(t *testing.T) {
	off, off2, past := sample("1", "go.example", "a"), sample("3", "go.example", "c"), sample("4", "go.example", "d")
	off.Disabled, off2.Disabled, past.ExpiresAt = true, true, at(5)
	file := exportFile(t, off, sample("2", "go.example", "b"), off2, past)
	for _, lost := range []bool{false, true} {
		s := newStore(t, "go.example")
		s.ignoreDisabled = true
		if lost {
			s.after = func(http.ResponseWriter, *http.Request) bool { panic(http.ErrAbortHandler) }
		}
		r := s.harness().run(t, "import", file, "--apply")
		r.wantSum(t, 1, "4 links: 1 created, 0 skipped, 0 conflicts, 0 impossible, 3 failed, 0 not tried, 0 pending")
		r.wantLine(t, "failed", "is LIVE. Turn it off: curt edit https://go.example/a --disable")
		r.wantLine(t, "failed", "go.example/c -> https://example.com/c (not created")
		// Only one link was exposed before this was noticed.
		if s.at("go.example", "c") != nil || s.at("go.example", "d") != nil || s.at("go.example", "b") == nil {
			t.Errorf("lost=%v: %+v", lost, s.links)
		}
		// Running again does not change the live link, and says so.
		s.after = nil
		r = s.harness().run(t, "import", file)
		r.wantLine(t, "skip", "it is LIVE but should be disabled: curt edit https://go.example/a --disable")
		if !strings.Contains(r.errOut, "Warning: 1 existing links are live") {
			t.Errorf("%s", r.errOut)
		}
	}
}

// Many disabled links in a row on an old server must not stop the enabled ones.
func TestImportIgnoredDisabledDoesNotStop(t *testing.T) {
	var links []link
	for i := range 9 {
		l := sample("x", "go.example", fmt.Sprintf("s%d", i))
		l.Disabled = i < 8
		links = append(links, l)
	}
	s := newStore(t, "go.example")
	s.ignoreDisabled = true
	s.harness().run(t, "import", exportFile(t, links...), "--apply").wantSum(t, 1,
		"9 links: 1 created, 0 skipped, 0 conflicts, 0 impossible, 8 failed, 0 not tried, 0 pending")
}

func TestImportPending(t *testing.T) {
	s := newStore(t, "go.example")
	s.pending = true
	off := sample("1", "go.example", "a")
	off.Disabled = true
	file := exportFile(t, off, sample("2", "go.example", "b"))
	r := s.harness().run(t, "import", file, "--apply")
	r.wantSum(t, 0, "2 links: 2 created, 0 skipped, 0 conflicts, 0 impossible, 0 failed, 0 not tried, 2 pending")
	r.wantLine(t, "created", "go.example/a -> https://example.com/a (disabled; pending: old behaviour may continue)")
	if !strings.Contains(r.errOut, "2 links are pending") || !strings.Contains(r.errOut, "up to an hour") || !strings.Contains(r.errOut, "To retry") {
		t.Errorf("%s", r.errOut)
	}
	s.harness().run(t, "import", file).wantSum(t, 0, "2 links: 0 to create, 2 skipped, 0 conflicts, 0 impossible, 2 pending")
}

func TestImportReadsEveryExportPage(t *testing.T) {
	src, dst := newStore(t, "go.example"), newStore(t, "go.example")
	for i := range 1201 {
		src.links = append(src.links, sample(fmt.Sprintf("i%d", i), "go.example", fmt.Sprintf("s%d", i)))
	}
	dst.links = slices.Clone(src.links[:1101])
	file := filepath.Join(t.TempDir(), "links.json")
	src.harness().run(t, "export", "-o", file).want(t, 0, "")
	if len(src.calls) != 3 {
		t.Errorf("calls %v", src.calls)
	}
	dst.harness().run(t, "import", file).wantSum(t, 0, "1201 links: 100 to create, 1101 skipped, 0 conflicts, 0 impossible, 0 pending")
}

func TestImportInterrupt(t *testing.T) {
	s := newStore(t, "go.example")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	off := sample("1", "go.example", "a")
	off.Disabled = true
	s.after = func(_ http.ResponseWriter, r *http.Request) bool {
		if r.Method == "POST" {
			cancel()
		}
		return false
	}
	file := exportFile(t, off, sample("2", "go.example", "b"), sample("3", "go.example", "c"))
	h := s.harness()
	h.ctx = ctx
	r := h.run(t, "import", file, "--apply")
	r.wantSum(t, 1, "3 links: 1 created, 0 skipped, 0 conflicts, 0 impossible, 0 failed, 2 not tried, 0 pending")
	if l := s.at("go.example", "a"); l == nil || !l.Disabled {
		t.Errorf("%+v", l)
	}
	if !strings.Contains(r.errOut, "interrupted. Run the same command again") {
		t.Errorf("%s", r.errOut)
	}
	s.after = nil
	s.harness().run(t, "import", file, "--apply").wantSum(t, 0,
		"3 links: 2 created, 1 skipped, 0 conflicts, 0 impossible, 0 failed, 0 not tried, 0 pending")
}

func TestImportExpiryRunsOutMeanwhile(t *testing.T) {
	s := newStore(t, "go.example")
	l := sample("1", "go.example", "a")
	l.ExpiresAt = at(storeNow + 1000)
	s.hook = func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method != "POST" {
			return false
		}
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		if strings.Contains(string(body), "expiresAt") {
			sendCode(w, 400, "expiry_in_past")
			return true
		}
		return false
	}
	r := s.harness().run(t, "import", exportFile(t, l), "--apply")
	r.wantLine(t, "created", "expiry has passed")
	if got := s.at("go.example", "a"); got == nil || !got.Disabled || got.ExpiresAt != nil || !slices.Equal(got.Tags, []string{"docs"}) {
		t.Errorf("%+v", got)
	}
}

func TestImportAsMember(t *testing.T) {
	s := newStore(t, "go.example")
	s.admin = false
	hidden := sample("x", "go.example", "a")
	hidden.Owner.ID = "other"
	s.links = []link{hidden}
	file := exportFile(t, sample("1", "go.example", "a"), sample("2", "go.example", "b"))
	r := s.harness().run(t, "import", file)
	r.wantSum(t, 1, "2 links: 1 to create, 0 skipped, 1 conflicts, 0 impossible, 0 pending")
	r.wantLine(t, "conflict", "taken by a link you cannot see")
	r = s.harness().run(t, "import", file, "--apply")
	r.wantSum(t, 1, "2 links: 1 created, 0 skipped, 1 conflicts, 0 impossible, 0 failed, 0 not tried, 0 pending")
	r.wantLine(t, "conflict", "taken by a link you cannot see")
}

func TestImportHelpSaysWhatIsLost(t *testing.T) {
	if !strings.Contains(usageText, "Not restored: link IDs, stats and owners") {
		t.Error("help text")
	}
	b, _ := os.ReadFile("README.md")
	if !strings.Contains(string(b), "Not restored: link IDs, stats and owners") {
		t.Error("README")
	}
}
