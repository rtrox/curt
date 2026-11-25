package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/term"
)

type savedConfig struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

// parseServer returns scheme and host only. Errors never repeat the input: a
// token pasted in the wrong place must not be printed.
func parseServer(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Hostname() == "" || u.Opaque != "" {
		return "", usagef("the server address must look like https://app.go.example")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" {
		return "", usagef("the server address must be only a scheme and host, like https://app.go.example")
	}
	host := strings.ToLower(u.Hostname())
	ip := net.ParseIP(host)
	local := host == "localhost" || (ip != nil && ip.IsLoopback())
	if u.Scheme != "https" && (u.Scheme != "http" || !local) {
		return "", usagef("the server address must use https (http is allowed only for localhost)")
	}
	port := u.Port()
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	return u.Scheme + "://" + host, nil
}

func checkToken(token string) error {
	if token == "" {
		return usagef("the token is empty")
	}
	for _, r := range token {
		if r <= ' ' || r > '~' {
			return usagef("the token contains spaces or other characters that do not belong in one")
		}
	}
	return nil
}

// load returns an empty config if none is saved.
func (a *app) load() (savedConfig, error) {
	var cfg savedConfig
	path, err := a.configPath()
	if err != nil {
		return cfg, fmt.Errorf("no place to look for saved settings: %w. Set CURT_URL and CURT_TOKEN", err)
	}
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	defer f.Close()
	if st, err := f.Stat(); err == nil && st.Mode().Perm()&0o077 != 0 {
		a.say("Warning: other users may be able to read %s (mode %04o). Run: chmod 600 '%s'", path, st.Mode().Perm(), path)
	}
	if json.NewDecoder(io.LimitReader(f, 1<<16)).Decode(&cfg) != nil {
		return savedConfig{}, fmt.Errorf("%s is not valid. Run curt logout, then curt login", path)
	}
	return cfg, nil
}

func (a *app) connect() (*client, error) {
	base, token := a.getenv("CURT_URL"), a.getenv("CURT_TOKEN")
	if base != "" {
		var err error
		if base, err = parseServer(base); err != nil {
			return nil, fmt.Errorf("CURT_URL: %w", err)
		}
	}
	if base == "" || token == "" {
		cfg, err := a.load()
		if err != nil {
			return nil, err
		}
		saved := ""
		if cfg.URL != "" {
			if saved, err = parseServer(cfg.URL); err != nil {
				return nil, fmt.Errorf("saved settings: %w", err)
			}
		}
		if base == "" {
			base = saved
		}
		// A saved token belongs to the server it was saved for and no other.
		if token == "" && base != "" && base == saved {
			token = cfg.Token
		}
	}
	if base == "" {
		return nil, errors.New("no server is set. Run curt login, or set CURT_URL and CURT_TOKEN")
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, fmt.Errorf("no token for %s. Run curt login, or set CURT_TOKEN", base)
	}
	if err := checkToken(token); err != nil {
		return nil, err
	}
	a.token = token
	return newClient(base, token), nil
}

// writePrivate replaces path in one step, so a failure leaves the old file.
func writePrivate(path string, data []byte) error {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	if st, err := os.Stat(path); err == nil && !st.Mode().IsRegular() {
		return os.WriteFile(path, data, 0o600) // a device or pipe
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".curt-*") // created with mode 0600
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func (a *app) save(cfg savedConfig) (string, error) {
	path, err := a.configPath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", err
	}
	return path, writePrivate(path, append(data, '\n'))
}

// waitFor runs a blocking read that cannot be cancelled, and gives up on it
// when the context ends. The process exits right after.
func waitFor(ctx context.Context, read func() (string, error)) (string, error) {
	type result struct {
		s   string
		err error
	}
	ch := make(chan result, 1)
	go func() {
		s, err := read()
		ch <- result{s, err}
	}()
	select {
	case r := <-ch:
		return r.s, r.err
	case <-ctx.Done():
		return "", errors.New("interrupted")
	}
}

func readHidden(ctx context.Context, fd int) (string, error) {
	state, err := term.GetState(fd)
	if err != nil {
		return "", err
	}
	s, err := waitFor(ctx, func() (string, error) {
		b, err := term.ReadPassword(fd)
		return string(b), err
	})
	if err != nil {
		// Interrupted mid-read: turn echo back on.
		_ = term.Restore(fd, state)
	}
	return s, err
}

// readLine reads one byte at a time so nothing meant for a later read, such as
// the hidden token prompt, is swallowed.
func readLine(r io.Reader) (string, error) {
	var b []byte
	one := make([]byte, 1)
	for len(b) < 8192 {
		n, err := r.Read(one)
		if n == 1 {
			if one[0] == '\n' {
				return strings.TrimSpace(string(b)), nil
			}
			b = append(b, one[0])
		}
		if err == io.EOF {
			return strings.TrimSpace(string(b)), nil
		}
		if err != nil {
			return "", err
		}
	}
	return "", errors.New("input line is too long")
}

// readOne returns the single non-empty line in r.
func readOne(ctx context.Context, r io.Reader, what string) (string, error) {
	text, err := waitFor(ctx, func() (string, error) {
		b, err := io.ReadAll(io.LimitReader(r, 64<<10))
		return string(b), err
	})
	if err != nil {
		return "", err
	}
	found := ""
	for line := range strings.Lines(text) {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if found != "" {
			return "", usagef("expected one %s on stdin, got several lines", what)
		}
		found = line
	}
	if found == "" {
		return "", usagef("no %s given", what)
	}
	return found, nil
}
