package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	requestTimeout = 30 * time.Second
	exportTimeout  = 10 * time.Minute
	maxBody        = 16 << 20
	maxExport      = 256 << 20 // 500 links, each with a long destination, can pass 16 MB
)

// Types follow packages/shared/src/schemas.ts.
type link struct {
	ID          string   `json:"id"`
	Domain      string   `json:"domain"`
	Slug        string   `json:"slug"`
	ShortURL    string   `json:"shortUrl"`
	Destination string   `json:"destination"`
	Tags        []string `json:"tags"`
	Disabled    bool     `json:"disabled"`
	ExpiresAt   *int64   `json:"expiresAt"`
	Owner       owner    `json:"owner"`
	Version     int64    `json:"version"`
	SyncPending bool     `json:"syncPending,omitempty"`
	CreatedAt   int64    `json:"createdAt"`
	UpdatedAt   int64    `json:"updatedAt"`
}

type owner struct {
	ID   string  `json:"id"`
	Name *string `json:"name"`
}

// pendingText explains a change the server has stored but not yet copied to
// where redirects read it.
const pendingText = "The old behaviour may continue for up to an hour while the server retries."

type linkPage struct {
	Links      []link  `json:"links"`
	NextCursor *string `json:"nextCursor"`
}

type apiError struct {
	status     int
	code       string
	message    string // from the server, may be empty
	retryAfter time.Duration
	host       string
}

func (e *apiError) Error() string {
	with := func(text string) string {
		if e.message == "" {
			return text
		}
		return text + "\nServer said: " + e.message
	}
	switch {
	case e.status >= 300 && e.status < 400:
		return fmt.Sprintf("%s sent a redirect, which curt does not follow because it could leak your token. Check that the server address is the curt dashboard and that no access gateway is in front of /api.", e.host)
	case e.status == http.StatusUnauthorized:
		return with("The server did not accept the token. It may be wrong, expired or revoked. Create a new one in the dashboard and run curt login (or update CURT_TOKEN).")
	case e.status == http.StatusForbidden:
		return with("Not allowed. The token may lack the links scope.")
	case e.status == http.StatusNotFound:
		return with("Not found. The link does not exist or is not yours.")
	case e.status == http.StatusConflict:
		return with("Conflict with something that already exists.")
	case e.status == http.StatusPreconditionFailed:
		return with("The link was changed by someone else while you were editing it. Nothing was saved. Check its current values with curt search, then run the edit again.")
	case e.status == http.StatusTooManyRequests:
		if s := int(e.retryAfter.Seconds()); s == 1 {
			return "Too many requests. Try again in 1 second."
		} else if s > 1 {
			return fmt.Sprintf("Too many requests. Try again in %d seconds.", s)
		}
		return "Too many requests. Wait a minute and try again."
	case e.status >= 500:
		return with(fmt.Sprintf("%s had an internal problem (HTTP %d). Try again later.", e.host, e.status))
	}
	if e.message != "" {
		return e.message
	}
	return fmt.Sprintf("The server refused the request (HTTP %d).", e.status)
}

func hasStatus(err error, codes ...int) bool {
	var ae *apiError
	if !errors.As(err, &ae) {
		return false
	}
	for _, c := range codes {
		if ae.status == c {
			return true
		}
	}
	return false
}

type client struct {
	base  string // scheme and host, no trailing slash
	token string
	http  *http.Client
}

func newClient(base, token string) *client {
	return &client{base: base, token: token, http: &http.Client{
		// No redirect is ever followed, so the token cannot reach another host.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

type request struct {
	method  string
	path    string // under /api/v1, already escaped
	query   url.Values
	body    any
	ifMatch string
	accept  string // expected content type; application/json by default
	timeout time.Duration
	limit   int64
}

func (c *client) host() string {
	_, host, _ := strings.Cut(c.base, "://")
	return host
}

func (c *client) do(ctx context.Context, r request) ([]byte, error) {
	if r.accept == "" {
		r.accept = "application/json"
	}
	if r.timeout == 0 {
		r.timeout = requestTimeout
	}
	if r.limit == 0 {
		r.limit = maxBody
	}
	parent := ctx
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	target := c.base + "/api/v1" + r.path
	if len(r.query) > 0 {
		target += "?" + r.query.Encode()
	}
	var body io.Reader
	if r.body != nil {
		var buf bytes.Buffer
		if err := json.NewEncoder(&buf).Encode(r.body); err != nil {
			return nil, err
		}
		body = &buf
	}
	req, err := http.NewRequestWithContext(ctx, r.method, target, body)
	if err != nil {
		return nil, errors.New("could not build the request; check the server address")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", r.accept)
	req.Header.Set("User-Agent", "curt-cli/"+buildVersion())
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if r.ifMatch != "" {
		req.Header.Set("If-Match", r.ifMatch)
	}

	res, err := c.http.Do(req)
	if err != nil {
		return nil, c.networkError(parent, r, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, r.limit+1))
	if err != nil {
		return nil, c.networkError(parent, r, err)
	}
	if int64(len(data)) > r.limit {
		return nil, fmt.Errorf("the response from %s is too large", c.host())
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, c.responseError(res, data)
	}
	if r.method == http.MethodDelete && res.StatusCode == http.StatusAccepted {
		return []byte("pending"), nil
	}
	if r.method == http.MethodDelete || res.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	// A sign-in page or a web app's fallback page also answers 200.
	if got, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type")); got != r.accept {
		return nil, c.notCurt()
	}
	return data, nil
}

func (c *client) notCurt() error {
	return fmt.Errorf("%s did not answer like a curt server. Check that the server address is the curt dashboard.", c.host())
}

func (c *client) responseError(res *http.Response, data []byte) error {
	e := &apiError{status: res.StatusCode, host: c.host()}
	var parsed struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &parsed) == nil {
		e.code = parsed.Error.Code
		e.message = clean(parsed.Error.Message) // one line, so it cannot imitate ours
	}
	after := res.Header.Get("Retry-After")
	if n, err := strconv.ParseInt(after, 10, 32); err == nil && n > 0 {
		e.retryAfter = time.Duration(n) * time.Second
	} else if at, err := http.ParseTime(after); err == nil && time.Until(at) > 0 {
		e.retryAfter = time.Until(at).Round(time.Second) + time.Second
	}
	return e
}

func (c *client) networkError(parent context.Context, r request, err error) error {
	if errors.Is(parent.Err(), context.Canceled) {
		return errors.New("interrupted")
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err // drops the URL, which may hold search text
	}
	hint := ""
	if r.method != http.MethodGet {
		hint = " The change may still have been made; check with curt list before trying again."
	}
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return fmt.Errorf("%s did not answer in time.%s", c.host(), hint)
	}
	return fmt.Errorf("could not reach %s: %w.%s", c.host(), err, hint)
}

func (c *client) json(ctx context.Context, r request, out any) error {
	data, err := c.do(ctx, r)
	if err != nil {
		return err
	}
	if json.Unmarshal(data, out) != nil {
		return c.notCurt()
	}
	return nil
}

func (c *client) page(ctx context.Context, q url.Values) (linkPage, error) {
	var p linkPage
	err := c.json(ctx, request{method: http.MethodGet, path: "/links", query: q}, &p)
	return p, err
}

// eachLink calls fn for every match, following cursors, until fn returns false.
func (c *client) eachLink(ctx context.Context, q url.Values, fn func(link) bool) error {
	seen := map[string]bool{}
	for {
		p, err := c.page(ctx, q)
		if err != nil {
			return err
		}
		for _, l := range p.Links {
			if !fn(l) {
				return nil
			}
		}
		if p.NextCursor == nil || *p.NextCursor == "" {
			return nil
		}
		if seen[*p.NextCursor] {
			return errors.New("the server repeated a page of results")
		}
		seen[*p.NextCursor] = true
		q.Set("cursor", *p.NextCursor)
	}
}
