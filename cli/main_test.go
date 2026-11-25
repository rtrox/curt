package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testToken = "curt_test_abcdef123456"

type fakeServer struct {
	t       *testing.T
	srv     *httptest.Server
	links   []link
	handler http.HandlerFunc // replaces the default behaviour when set
	calls   []string
	bodies  []string
	ifMatch string
	noSlug  bool // ignore the slug filter, like an older server
}

func newServer(t *testing.T, links ...link) *fakeServer {
	f := &fakeServer{t: t, links: links}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func sendJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func sendError(w http.ResponseWriter, status int, msg string) {
	sendJSON(w, status, map[string]any{"error": map[string]string{"code": "x", "message": msg}})
}

func (f *fakeServer) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.calls = append(f.calls, r.Method+" "+r.URL.RequestURI())
	f.bodies = append(f.bodies, string(body))
	if got := r.Header.Get("Authorization"); got != "Bearer "+testToken {
		sendError(w, 401, "bad token")
		return
	}
	if f.handler != nil {
		f.handler(w, r)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1")
	switch {
	case r.Method == "POST" && path == "/links":
		sendJSON(w, 201, link{ID: "n1", ShortURL: "https://go.example/abc234"})
	case r.Method == "GET" && path == "/links":
		out := linkPage{Links: []link{}}
		for _, l := range f.links {
			if q := r.URL.Query().Get("q"); q != "" && !strings.Contains(l.Slug+l.Destination, q) {
				continue
			}
			if s := r.URL.Query().Get("slug"); s != "" && !f.noSlug && !strings.EqualFold(s, l.Slug) {
				continue
			}
			if d := r.URL.Query().Get("domain"); d != "" && d != l.Domain {
				continue
			}
			out.Links = append(out.Links, l)
		}
		sendJSON(w, 200, out)
	case path == "/me":
		sendJSON(w, 200, map[string]any{"id": "u1", "name": "Example User"})
	case path == "/export":
		p := map[string]any{"links": append([]link{}, f.links...), "nextCursor": nil}
		if len(f.links) > 1 {
			i := 0
			if r.URL.Query().Get("cursor") == "c1" {
				i = 1
			} else {
				p["nextCursor"] = "c1"
			}
			p["links"] = f.links[i : i+1]
		}
		sendJSON(w, 200, p)
	case strings.HasSuffix(path, "/qr"):
		w.Header().Set("Content-Type", "image/svg+xml")
		_, _ = io.WriteString(w, "<svg/>")
	case strings.HasPrefix(path, "/links/"):
		id := strings.TrimPrefix(path, "/links/")
		for _, l := range f.links {
			if l.ID != id {
				continue
			}
			switch r.Method {
			case "PATCH":
				f.ifMatch = r.Header.Get("If-Match")
				sendJSON(w, 200, l)
			case "DELETE":
				w.WriteHeader(204)
			default:
				sendJSON(w, 200, l)
			}
			return
		}
		sendError(w, 404, "no such link")
	default:
		sendError(w, 404, "no such endpoint")
	}
}

type result struct {
	code        int
	out, errOut string
}

type harness struct {
	stdin    string
	term     bool
	password string
	env      map[string]string
	config   string
	slept    []time.Duration
	onSleep  func()
	ctx      context.Context
}

func (h *harness) run(t *testing.T, args ...string) result {
	t.Helper()
	if h.config == "" {
		h.config = filepath.Join(t.TempDir(), "curt", "config.json")
	}
	var out, errOut bytes.Buffer
	a := &app{
		stdin: strings.NewReader(h.stdin), stdout: &out, stderr: &errOut,
		stdinIsTerm:  h.term,
		readPassword: func(context.Context) (string, error) { return h.password, nil },
		getenv:       func(k string) string { return h.env[k] },
		configPath:   func() (string, error) { return h.config, nil },
		sleep: func(ctx context.Context, d time.Duration) error {
			h.slept = append(h.slept, d)
			if h.onSleep != nil {
				h.onSleep()
			}
			return ctx.Err()
		},
		now: func() time.Time { return time.Date(2030, 1, 1, 12, 0, 0, 0, time.UTC) },
	}
	ctx := h.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	code := a.run(ctx, args)
	if s := out.String() + errOut.String(); strings.Contains(s, testToken) {
		t.Errorf("token was printed: %q", s)
	}
	return result{code, out.String(), errOut.String()}
}

func signedIn(f *fakeServer) *harness {
	return &harness{term: true, env: map[string]string{"CURT_URL": f.srv.URL, "CURT_TOKEN": testToken}}
}

func (r result) want(t *testing.T, code int, out string, errParts ...string) {
	t.Helper()
	if r.code != code {
		t.Errorf("exit code %d, want %d (stderr %q)", r.code, code, r.errOut)
	}
	if r.out != out {
		t.Errorf("stdout %q, want %q", r.out, out)
	}
	for _, p := range errParts {
		if !strings.Contains(r.errOut, p) {
			t.Errorf("stderr %q lacks %q", r.errOut, p)
		}
	}
}

func sample(id, domain, slug string) link {
	return link{ID: id, Domain: domain, Slug: slug, ShortURL: "https://" + domain + "/" + slug,
		Destination: "https://example.com/" + slug, Tags: []string{"docs"}, Version: 7}
}

func TestShorten(t *testing.T) {
	f := newServer(t)
	h := signedIn(f)
	r := h.run(t, "https://example.com/a?b=c", "--slug", "Docs", "--domain", "Go.example", "--tag", "x", "--tag", "y", "--expires", "7d")
	r.want(t, 0, "https://go.example/abc234\n")
	if r.errOut != "" {
		t.Errorf("stderr %q", r.errOut)
	}
	var got map[string]any
	_ = json.Unmarshal([]byte(f.bodies[0]), &got)
	if got["destination"] != "https://example.com/a?b=c" || got["slug"] != "docs" || got["domain"] != "go.example" ||
		len(got["tags"].([]any)) != 2 || got["expiresAt"].(float64) != float64(time.Date(2030, 1, 8, 12, 0, 0, 0, time.UTC).Unix()) {
		t.Errorf("body %v", got)
	}

	// Flags first, and only the fields that were given.
	f.bodies = nil
	h.run(t, "--slug", "x", "https://example.com").want(t, 0, "https://go.example/abc234\n")
	if strings.TrimSpace(f.bodies[0]) != `{"destination":"https://example.com","slug":"x"}` {
		t.Errorf("body %s", f.bodies[0])
	}
}

func TestShortenStdin(t *testing.T) {
	f := newServer(t)
	h := signedIn(f)
	h.term, h.stdin = false, "\n  https://example.com/x \r\n\n"
	h.run(t).want(t, 0, "https://go.example/abc234\n")
	h.run(t, "-").want(t, 0, "https://go.example/abc234\n")
	h.stdin = "https://example.com/1\nhttps://example.com/2\n"
	h.run(t).want(t, 2, "", "several lines")
	h.stdin = ""
	h.run(t).want(t, 2, "", "no URL")
	if len(f.calls) != 2 {
		t.Errorf("calls %v", f.calls)
	}
}

func TestUsageErrorsMakeNoRequest(t *testing.T) {
	f := newServer(t)
	h := signedIn(f)
	for _, args := range [][]string{
		{}, {"example.com"}, {"ftp://example.com"}, {"https://"}, {"https://a.example", "https://b.example"},
		{"https://example.com", "--nope"}, {"https://example.com", "--slug", ""},
		{"https://example.com", "--slug", "a", "--slug", "b"}, {"https://example.com", "--expires", "soon"},
		{"list", "x"}, {"list", "--limit", "0"}, {"search"},
		{"edit", "a"}, {"edit", "--disable"}, {"edit", "a", "--disable", "--enable"},
		{"edit", "a", "--no-tags", "--tag", "x"}, {"edit", "a", "--url", "nope"},
		{"delete"}, {"delete", "a", "b"}, {"qr"}, {"qr", "../me"}, {"delete", "..", "--yes"},
		{"export", "x"}, {"logout", "x"}, {"version", "x"}, {"login", "a", "b"},
	} {
		if r := h.run(t, args...); r.code != 2 || r.out != "" || r.errOut == "" {
			t.Errorf("%v: %+v", args, r)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("calls %v", f.calls)
	}
}

func TestHelpAndVersion(t *testing.T) {
	h := &harness{}
	for _, args := range [][]string{{"--help"}, {"-h"}, {"help"}, {"edit", "--help"}} {
		h.run(t, args...).want(t, 0, usageText)
	}
	h.run(t, "version").want(t, 0, "curt "+buildVersion()+"\n")
}

func TestErrorMessages(t *testing.T) {
	for _, c := range []struct {
		status int
		msg    string
		want   []string
	}{
		{401, "nope", []string{"did not accept the token", "curt login"}},
		{403, "lacks scope", []string{"Not allowed", "lacks scope"}},
		{404, "gone", []string{"Not found"}},
		{409, "slug taken", []string{"Choose another with --slug", "slug taken"}},
		{412, "version", []string{"changed by someone else", "Nothing was saved"}},
		{429, "slow", []string{"Try again in 12 seconds"}},
		{400, "bad destination", []string{"bad destination"}},
		{503, "", []string{"internal problem (HTTP 503)"}},
		{302, "", []string{"does not follow"}},
		{400, "echo " + testToken + "\x1b[2J\nfake", []string{"echo [hidden]?[2J?fake"}},
	} {
		f := newServer(t)
		f.handler = func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Retry-After", "12")
			sendError(w, c.status, c.msg)
		}
		signedIn(f).run(t, "https://example.com", "--slug", "a").want(t, 1, "", c.want...)
	}
}

func TestNetworkErrors(t *testing.T) {
	f := newServer(t)
	h := signedIn(f)
	f.srv.Close()
	h.run(t, "https://example.com").want(t, 1, "", "could not reach 127.0.0.1", "curt list before trying again")
	r := h.run(t, "search", "private-words")
	r.want(t, 1, "", "could not reach")
	if strings.Contains(r.errOut, "private-words") {
		t.Errorf("search text in error: %q", r.errOut)
	}
}

func TestTimeoutAndInterrupt(t *testing.T) {
	stop := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-stop }))
	defer srv.Close()
	defer close(stop)
	c := newClient(srv.URL, testToken)
	_, err := c.do(context.Background(), request{method: "GET", path: "/me", timeout: 20 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "did not answer in time") {
		t.Errorf("err %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)
	if _, err = c.do(ctx, request{method: "GET", path: "/me"}); err == nil || err.Error() != "interrupted" {
		t.Errorf("err %v", err)
	}
}

func TestRedirectNeverSendsToken(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		hits := 0
		other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits++ }))
		f := newServer(t)
		f.handler = func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, other.URL+"/?secret=1", status)
		}
		for _, args := range [][]string{{"https://example.com"}, {"list"}, {"export"}} {
			r := signedIn(f).run(t, args...)
			r.want(t, 1, "", "does not follow")
			if strings.Contains(r.errOut, "secret") {
				t.Errorf("redirect target printed: %q", r.errOut)
			}
		}
		if hits != 0 {
			t.Errorf("%d: other host was called", status)
		}
		other.Close()
	}
}

func TestNotCurt(t *testing.T) {
	f := newServer(t)
	f.handler = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, "<html>")
	}
	for _, args := range [][]string{{"https://example.com"}, {"list"}, {"export"}} {
		signedIn(f).run(t, args...).want(t, 1, "", "did not answer like a curt server")
	}
	f.handler = func(w http.ResponseWriter, r *http.Request) { sendJSON(w, 200, map[string]any{}) }
	signedIn(f).run(t, "https://example.com").want(t, 1, "", "did not answer like a curt server")
}

func TestList(t *testing.T) {
	bad := sample("2", "s.example", "b")
	bad.Destination = "https://example.com/\x1b]0;x\a\t"
	bad.Disabled = true
	old, later := int64(5), time.Date(2031, 2, 3, 4, 5, 0, 0, time.UTC).Unix()
	gone, until := sample("3", "go.example", "c"), sample("4", "go.example", "d")
	gone.ExpiresAt, until.ExpiresAt = &old, &later
	f := newServer(t, sample("1", "go.example", "a"), bad, gone, until)
	r := signedIn(f).run(t, "list", "--tag", "Docs")
	if r.code != 0 || strings.ContainsAny(r.out, "\x1b\a\t") {
		t.Errorf("%+v", r)
	}
	for _, p := range []string{"https://go.example/a", "active", "disabled", "expired", "until 2031-02-03 04:05", "docs"} {
		if !strings.Contains(r.out, p) {
			t.Errorf("no %q in %q", p, r.out)
		}
	}
	if f.calls[0] != "GET /api/v1/links?limit=51&tag=docs" {
		t.Errorf("calls %v", f.calls)
	}
	signedIn(f).run(t, "search", "zzz").want(t, 0, "", "No links found")
	signedIn(f).run(t, "search", "zzz", "--json").want(t, 0, "[]\n")

	r = signedIn(f).run(t, "list", "--json", "--limit", "2")
	var got []map[string]any
	if err := json.Unmarshal([]byte(r.out), &got); err != nil || len(got) != 2 || got[0]["shortUrl"] != "https://go.example/a" {
		t.Errorf("%v %v", got, err)
	}
	if !strings.Contains(r.errOut, "first 2") {
		t.Errorf("stderr %q", r.errOut)
	}
}

func TestListFollowsPages(t *testing.T) {
	f := newServer(t)
	f.handler = func(w http.ResponseWriter, r *http.Request) {
		cur := r.URL.Query().Get("cursor")
		next := map[string]string{"": "p2", "p2": "p3"}[cur]
		p := linkPage{Links: []link{sample("i"+cur, "go.example", "s"+cur)}}
		if next != "" {
			p.NextCursor = &next
		}
		sendJSON(w, 200, p)
	}
	r := signedIn(f).run(t, "list", "--limit", "500")
	if r.code != 0 || strings.Count(r.out, "https://go.example/") != 3 || r.errOut != "" {
		t.Errorf("%+v", r)
	}
	same := "loop"
	f.handler = func(w http.ResponseWriter, r *http.Request) { sendJSON(w, 200, linkPage{NextCursor: &same}) }
	signedIn(f).run(t, "list").want(t, 1, "", "repeated a page")
}

func TestEdit(t *testing.T) {
	f := newServer(t, sample("id1", "go.example", "a"), sample("id2", "go.example", "ab"))
	r := signedIn(f).run(t, "edit", "A", "--url", "https://example.com/new", "--tag", "x", "--expires", "never", "--disable")
	r.want(t, 0, "", "Updated https://go.example/a")
	if f.ifMatch != "7" {
		t.Errorf("If-Match %q", f.ifMatch)
	}
	if got := strings.TrimSpace(f.bodies[len(f.bodies)-1]); got != `{"destination":"https://example.com/new","disabled":true,"expiresAt":null,"tags":["x"]}` {
		t.Errorf("body %s", got)
	}
	signedIn(f).run(t, "edit", "id2", "--no-tags").want(t, 0, "", "Updated https://go.example/ab")
	if got := strings.TrimSpace(f.bodies[len(f.bodies)-1]); got != `{"tags":[]}` {
		t.Errorf("body %s", got)
	}
}

func TestEditConflict(t *testing.T) {
	f := newServer(t)
	f.handler = func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "PATCH" {
			sendError(w, 412, "version mismatch")
			return
		}
		sendJSON(w, 200, linkPage{Links: []link{sample("id1", "go.example", "a")}})
	}
	signedIn(f).run(t, "edit", "a", "--enable").want(t, 1, "", "Nothing was saved", "version mismatch")
	patches := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, "PATCH") {
			patches++
		}
	}
	if patches != 1 {
		t.Errorf("edit was retried: %v", f.calls)
	}
}

func TestAmbiguousSlug(t *testing.T) {
	f := newServer(t, sample("id1", "go.example", "a"), sample("id2", "s.example", "a"))
	for _, args := range [][]string{{"delete", "a", "--yes"}, {"edit", "a", "--disable"}, {"qr", "a"}} {
		signedIn(f).run(t, args...).want(t, 2, "", "--domain", "https://go.example/a", "https://s.example/a")
	}
	for _, c := range f.calls {
		if !strings.HasPrefix(c, "GET ") || strings.HasSuffix(c, "/qr") {
			t.Errorf("acted on a guess: %s", c)
		}
	}
	for _, args := range [][]string{{"delete", "a", "--yes", "--domain", "S.example"}, {"delete", "https://s.example/a", "--yes"}} {
		f.calls = nil
		signedIn(f).run(t, args...).want(t, 0, "", "Deleted https://s.example/a")
		if f.calls[len(f.calls)-1] != "DELETE /api/v1/links/id2" {
			t.Errorf("calls %v", f.calls)
		}
	}
	signedIn(f).run(t, "delete", "https://s.example/a", "--yes", "--domain", "go.example").want(t, 2, "", "does not match")
	signedIn(f).run(t, "qr", "nope").want(t, 1, "", `No link "nope"`)
}

func TestSlugThatIsAnotherLinksID(t *testing.T) {
	f := newServer(t, sample("id1", "go.example", "a"), sample("id2", "go.example", "id1"))
	signedIn(f).run(t, "delete", "id1", "--yes").want(t, 2, "", "Several links match")
}

func TestLookupUsesSlugFilter(t *testing.T) {
	links := []link{sample("id1", "go.example", "a"), sample("id2", "go.example", "ab"), sample("id3", "s.example", "ab")}
	f := newServer(t, links...)
	signedIn(f).run(t, "qr", "AB", "--domain", "go.example").want(t, 0, "<svg/>")
	want := []string{"GET /api/v1/links?domain=go.example&limit=100&slug=ab", "GET /api/v1/links/id2/qr"}
	if strings.Join(f.calls, "\n") != strings.Join(want, "\n") {
		t.Errorf("calls %v", f.calls)
	}
	// A server that ignores the filter must not lead to the wrong link.
	f = newServer(t, links...)
	f.noSlug = true
	signedIn(f).run(t, "delete", "ab", "--yes", "--domain", "s.example").want(t, 0, "", "Deleted https://s.example/ab")
	if f.calls[len(f.calls)-1] != "DELETE /api/v1/links/id3" {
		t.Errorf("calls %v", f.calls)
	}
	signedIn(f).run(t, "delete", "ab", "--yes").want(t, 2, "", "Several links match")
	signedIn(f).run(t, "delete", "b", "--yes").want(t, 1, "", `No link "b"`)
}

func TestLookupFollowsPagesWhenFilterIgnored(t *testing.T) {
	f := newServer(t)
	next := "p2"
	f.handler = func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "DELETE":
			w.WriteHeader(204)
		case strings.HasPrefix(r.URL.Path, "/api/v1/links/"):
			sendError(w, 404, "no such link")
		case r.URL.Query().Get("cursor") == "":
			sendJSON(w, 200, linkPage{Links: []link{sample("id1", "go.example", "a")}, NextCursor: &next})
		default:
			sendJSON(w, 200, linkPage{Links: []link{sample("id2", "go.example", "b")}})
		}
	}
	signedIn(f).run(t, "delete", "b", "--yes").want(t, 0, "", "Deleted https://go.example/b")
}

func TestReservedWordsAreNotIDs(t *testing.T) {
	f := newServer(t)
	signedIn(f).run(t, "qr", "stats").want(t, 1, "", "No link")
	signedIn(f).run(t, "qr", "availability").want(t, 1, "", "No link")
	if len(f.calls) != 2 {
		t.Errorf("calls %v", f.calls)
	}
}

func TestDeleteAsks(t *testing.T) {
	f := newServer(t, sample("id1", "go.example", "a"))
	h := signedIn(f)
	for _, answer := range []string{"\n", "", "n\n", "sure\n"} {
		h.stdin = answer
		h.run(t, "delete", "a").want(t, 1, "", "cannot be undone", "not deleted")
	}
	h.term = false
	h.stdin = "y\n"
	h.run(t, "delete", "a").want(t, 2, "", "--yes")
	for _, c := range f.calls {
		if strings.HasPrefix(c, "DELETE") {
			t.Fatalf("deleted: %v", f.calls)
		}
	}
	h.term = true
	h.run(t, "delete", "a").want(t, 0, "", "Deleted")
}

func TestQR(t *testing.T) {
	f := newServer(t, sample("id1", "go.example", "a"))
	signedIn(f).run(t, "qr", "a").want(t, 0, "<svg/>")
	file := filepath.Join(t.TempDir(), "a.svg")
	signedIn(f).run(t, "qr", "a", "-o", file).want(t, 0, "")
	if b, _ := os.ReadFile(file); string(b) != "<svg/>" {
		t.Errorf("file %q", b)
	}
}

func TestExport(t *testing.T) {
	f := newServer(t, sample("id1", "go.example", "a"), sample("id2", "go.example", "b"))
	r := signedIn(f).run(t, "export")
	if !strings.Contains(r.out, `"nextCursor":null`) {
		t.Errorf("output does not match exportSchema: %s", r.out)
	}
	var got struct{ Links []link }
	if r := signedIn(newServer(t)).run(t, "export"); r.code != 0 || !strings.Contains(r.out, `"links":[]`) {
		t.Errorf("empty export: %+v", r)
	}
	if err := json.Unmarshal([]byte(r.out), &got); err != nil || len(got.Links) != 2 || got.Links[1].ID != "id2" {
		t.Errorf("%+v %v", r, err)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "backup.json")
	signedIn(f).run(t, "export", "-o", file).want(t, 0, "")
	good, _ := os.ReadFile(file)
	st, _ := os.Stat(file)
	if len(good) == 0 || st.Mode().Perm() != 0o600 {
		t.Errorf("%q %v", good, st.Mode())
	}
	// A failed or partial export must not replace a good backup.
	next := "x"
	for name, handler := range map[string]http.HandlerFunc{
		"error": func(w http.ResponseWriter, _ *http.Request) { sendError(w, 503, "") },
		"cut short": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Length", "100")
			_, _ = io.WriteString(w, `[{"id":`)
		},
		"damaged": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"links":[{"id":"id1"},`)
		},
		"repeated page": func(w http.ResponseWriter, _ *http.Request) {
			sendJSON(w, 200, linkPage{Links: []link{}, NextCursor: &next})
		},
		"second page fails": func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("cursor") != "" {
				sendError(w, 429, "")
				return
			}
			sendJSON(w, 200, linkPage{Links: []link{sample("id1", "go.example", "a")}, NextCursor: &next})
		},
		"no links field": func(w http.ResponseWriter, _ *http.Request) { sendJSON(w, 200, map[string]any{}) },
	} {
		f.handler = handler
		if r := signedIn(f).run(t, "export", "-o", file); r.code != 1 {
			t.Errorf("%s: %+v", name, r)
		}
		if b, _ := os.ReadFile(file); !bytes.Equal(b, good) {
			t.Errorf("%s: backup replaced by %q", name, b)
		}
	}
	if e, _ := os.ReadDir(dir); len(e) != 1 {
		t.Errorf("left files behind: %v", e)
	}
}

func TestLargeExport(t *testing.T) {
	f := newServer(t)
	f.handler = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"links":[{"id":"1"}`)
		row := []byte(`,{"id":"2","destination":"https://example.com/` + strings.Repeat("a", 4000) + `"}`)
		for range 6000 { // past the limit for ordinary responses
			_, _ = w.Write(row)
		}
		_, _ = io.WriteString(w, `],"nextCursor":null}`)
	}
	r := signedIn(f).run(t, "export")
	if r.code != 0 || len(r.out) < maxBody {
		t.Errorf("code %d, %d bytes, %s", r.code, len(r.out), r.errOut)
	}
}

func TestLoginAndLogout(t *testing.T) {
	f := newServer(t)
	h := &harness{stdin: testToken + "\n", env: map[string]string{}}
	h.run(t, "login", f.srv.URL+"/").want(t, 0, "", "Signed in to 127.0.0.1", "as Example User")
	st, err := os.Stat(h.config)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", st, err)
	}
	if d, _ := os.Stat(filepath.Dir(h.config)); d.Mode().Perm() != 0o700 {
		t.Errorf("dir mode %v", d.Mode())
	}
	h.run(t, "https://example.com").want(t, 0, "https://go.example/abc234\n")

	// A looser mode warns but still works, and login repairs it.
	_ = os.Chmod(h.config, 0o644)
	h.run(t, "https://example.com").want(t, 0, "https://go.example/abc234\n", "Warning", "0644", "chmod 600")
	h.run(t, "login").want(t, 0, "")
	if st, _ := os.Stat(h.config); st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", st.Mode())
	}

	h.run(t, "logout").want(t, 0, "", "Removed the saved token", "revoke")
	h.run(t, "logout").want(t, 0, "", "Not signed in")
	h.run(t, "list").want(t, 1, "", "curt login")
}

func TestLoginHidden(t *testing.T) {
	f := newServer(t)
	h := &harness{term: true, stdin: f.srv.URL + "\n", password: testToken}
	h.run(t, "login").want(t, 0, "", "not shown", "Signed in")
	f2 := newServer(t)
	h.env = map[string]string{"CURT_URL": f2.srv.URL, "CURT_TOKEN": "other"}
	h.run(t, "login").want(t, 0, "", "Signed in to "+strings.TrimPrefix(f2.srv.URL, "http://"), "CURT_TOKEN is set")
}

func TestLoginRefused(t *testing.T) {
	f := newServer(t)
	h := &harness{stdin: "wrong-token"}
	h.run(t, "login", f.srv.URL).want(t, 1, "", "did not accept")
	h.stdin = "two words"
	h.run(t, "login", f.srv.URL).want(t, 2, "", "token contains")
	h.stdin = testToken
	h.run(t, "login").want(t, 2, "", "missing server address")
	// A token given as an argument is refused and not repeated.
	h.run(t, "login", testToken).want(t, 2, "", "server address")
	h.run(t, "login", "--token", testToken).want(t, 2, "", "not defined")
	h.run(t, "login", f.srv.URL, testToken).want(t, 2, "", "never an argument")
	h.run(t, testToken).want(t, 2, "", "not a command")
	if _, err := os.Stat(h.config); err == nil {
		t.Error("config was saved")
	}
}

func TestSavedTokenStaysWithItsServer(t *testing.T) {
	f, other := newServer(t), newServer(t)
	h := &harness{stdin: testToken, env: map[string]string{}}
	h.run(t, "login", f.srv.URL).want(t, 0, "")
	h.env["CURT_URL"] = other.srv.URL
	h.run(t, "list").want(t, 1, "", "no token for")
	if len(other.calls) != 0 {
		t.Errorf("token sent to another server: %v", other.calls)
	}
}

func TestDamagedConfig(t *testing.T) {
	h := &harness{config: filepath.Join(t.TempDir(), "config.json")}
	_ = os.WriteFile(h.config, []byte(`{"token": "`+testToken), 0o600)
	h.run(t, "list").want(t, 1, "", "not valid")
}

func TestParseServer(t *testing.T) {
	for in, want := range map[string]string{
		"https://App.Go.example/":     "https://app.go.example",
		"https://app.go.example:443":  "https://app.go.example",
		"https://app.go.example:8443": "https://app.go.example:8443",
		"http://localhost:8787":       "http://localhost:8787",
		"http://127.0.0.1:80":         "http://127.0.0.1",
		"http://[::1]:99":             "http://[::1]:99",
	} {
		if got, err := parseServer(in); err != nil || got != want {
			t.Errorf("%s: %q %v", in, got, err)
		}
	}
	for _, in := range []string{"", "app.go.example", "http://app.go.example", "http://localhost.example.com",
		"http://127.0.0.1.example.com", "http://10.0.0.1", "ftp://app.go.example", "https://user:pw@app.go.example",
		"https://app.go.example/api/v1", "https://app.go.example?x=1", "https://", "http://localhost@example.com"} {
		if got, err := parseServer(in); err == nil {
			t.Errorf("%q accepted as %q", in, got)
		} else if in != "" && strings.Contains(err.Error(), in) && in != "https://" && in != "app.go.example" {
			t.Errorf("%q repeated in %q", in, err)
		}
	}
}

func TestParseExpires(t *testing.T) {
	zone := time.FixedZone("x", 2*3600)
	now := time.Date(2030, 1, 1, 12, 0, 0, 0, zone)
	for in, want := range map[string]time.Time{
		"90m": now.Add(90 * time.Minute), "12h": now.Add(12 * time.Hour), "7d": now.AddDate(0, 0, 7),
		"2w": now.AddDate(0, 0, 14), "1d12h": now.Add(36 * time.Hour),
		"2030-01-01":           time.Date(2030, 1, 1, 23, 59, 59, 0, zone),
		"2030-12-31":           time.Date(2030, 12, 31, 23, 59, 59, 0, zone),
		"2030-06-01T00:00:00Z": time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC),
	} {
		if got, err := parseExpires(in, now); err != nil || got == nil || *got != want.Unix() {
			t.Errorf("%s: %v %v", in, got, err)
		}
	}
	if got, err := parseExpires("never", now); got != nil || err != nil {
		t.Errorf("never: %v %v", got, err)
	}
	for _, in := range []string{"", "0d", "-7d", "7", "7y", "1.5d", "2029-12-31", "2030-02-30", "999999w", "99999w99999w",
		"2020-01-01T00:00:00Z", "9999-01-01", "tomorrow"} {
		if got, err := parseExpires(in, now); err == nil {
			t.Errorf("%q accepted as %d", in, *got)
		}
	}
}

func TestLenientURLs(t *testing.T) {
	f := newServer(t)
	for _, u := range []string{"https://example.com/100%", "HTTPS://example.com/a", "https://example.com/a b"} {
		signedIn(f).run(t, u).want(t, 0, "https://go.example/abc234\n")
	}
	for in, want := range map[string]string{
		"https://Go.example./x": "go.example", "http://u:p@go.example:8080?x": "go.example", "https://[::1]:8/": "[::1]",
		"https://go.example\\@example.com": "go.example", "ftp://go.example": "", "go.example": "", "https://": "",
	} {
		if got := urlHost(in); got != want {
			t.Errorf("%s: %q", in, got)
		}
	}
}

func TestSyncPending(t *testing.T) {
	f := newServer(t)
	l := sample("id1", "go.example", "a")
	l.SyncPending = true
	f.handler = func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "DELETE":
			sendJSON(w, 202, map[string]any{"syncPending": true})
		case "GET":
			sendJSON(w, 200, linkPage{Links: []link{l}})
		default:
			sendJSON(w, 200, l)
		}
	}
	signedIn(f).run(t, "https://example.com").want(t, 0, "https://go.example/a\n", "pending", "up to an hour", "To retry now: curt edit https://go.example/a --enable")
	signedIn(f).run(t, "edit", "a", "--disable", "--domain", "go.example").want(t, 0, "", "Saved", "pending", "up to an hour", "run the same edit again")
	signedIn(f).run(t, "delete", "a", "--yes", "--domain", "go.example").want(t, 0, "", "Deleted", "pending", "up to an hour")
	r := signedIn(f).run(t, "list")
	if r.code != 0 || !strings.Contains(r.out, "active (pending)") || !strings.Contains(r.errOut, "up to an hour") {
		t.Errorf("%+v", r)
	}
	if r := signedIn(f).run(t, "list", "--json"); !strings.Contains(r.out, `"syncPending": true`) {
		t.Errorf("%+v", r)
	}
}

func TestDoubleDash(t *testing.T) {
	f := newServer(t)
	signedIn(f).run(t, "--slug", "a", "--", "https://example.com").want(t, 0, "https://go.example/abc234\n")
}

func TestRequestShape(t *testing.T) {
	f := newServer(t)
	f.handler = func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Type") != "application/json" || !strings.HasPrefix(r.Header.Get("User-Agent"), "curt-cli/") {
			t.Errorf("headers %v", r.Header)
		}
		sendJSON(w, 201, link{ShortURL: "https://go.example/x"})
	}
	signedIn(f).run(t, "https://example.com").want(t, 0, "https://go.example/x\n")
	if u, _ := url.Parse(strings.Fields(f.calls[0])[1]); u.RawQuery != "" || strings.Contains(f.calls[0], testToken) {
		t.Errorf("calls %v", f.calls)
	}
}
