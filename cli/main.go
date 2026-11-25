// Command curt is the command-line client for a curt URL shortener.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"
)

// version is set by release builds with -ldflags "-X main.version=...".
var version = ""

const (
	exitOK    = 0
	exitError = 1
	exitUsage = 2
)

const usageText = `curt - create and manage short links

Usage:
  curt <url> [--slug S] [--domain D] [--tag T]... [--expires WHEN]
  curt [flags] < file-with-one-url

  curt list              [--tag T] [--domain D] [--limit N] [--json]
  curt search <text>     [--tag T] [--domain D] [--limit N] [--json]
  curt edit <link>       [--domain D] [--url URL] [--tag T]... [--no-tags]
                         [--expires WHEN] [--disable | --enable]
  curt delete <link>     [--domain D] [--yes]
  curt qr <link>         [--domain D] [-o file.svg]
  curt export            [-o file]
  curt import <file>     [--apply] [--domain-map OLD=NEW]...
  curt login [server]    The token is asked for, or read from stdin
  curt logout
  curt version

<link> is a slug, a link ID or a full short URL. A slug that exists on several
domains needs --domain.

WHEN is a duration (90m, 12h, 7d, 2w), a date (2030-12-31, through the end of
that day) or an RFC 3339 time. "never" removes an expiry.

import recreates links from a file made by export. Without --apply it only
shows what would happen. Restored: domain, slug, destination, tags, expiry and
disabled. Not restored: link IDs, stats and owners; every new link belongs to
you. Existing links are never overwritten. A link whose expiry has passed is
restored disabled, without an expiry. --domain-map moves links to another domain.

Environment: CURT_URL and CURT_TOKEN override the saved sign-in.
Exit codes: 0 success, 1 error, 2 usage.
`

// usageError is a mistake in how the command was called. Exit code 2.
type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

func usagef(format string, args ...any) error {
	return &usageError{fmt.Sprintf(format, args...)}
}

// app carries everything a command touches, so tests can replace it.
type app struct {
	stdin          io.Reader
	stdout, stderr io.Writer
	stdinIsTerm    bool
	readPassword   func(context.Context) (string, error)
	getenv         func(string) string
	configPath     func() (string, error)
	now            func() time.Time
	sleep          func(context.Context, time.Duration) error
	token          string // removed from anything printed to stderr
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	context.AfterFunc(ctx, stop) // a second Ctrl-C ends the program at once
	fd := int(os.Stdin.Fd())
	a := &app{
		stdin:        os.Stdin,
		stdout:       os.Stdout,
		stderr:       os.Stderr,
		stdinIsTerm:  term.IsTerminal(fd),
		readPassword: func(ctx context.Context) (string, error) { return readHidden(ctx, fd) },
		getenv:       os.Getenv,
		configPath: func() (string, error) {
			dir, err := os.UserConfigDir()
			return filepath.Join(dir, "curt", "config.json"), err
		},
		now: time.Now,
		sleep: func(ctx context.Context, d time.Duration) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(d):
				return nil
			}
		},
	}
	code := a.run(ctx, os.Args[1:])
	stop()
	os.Exit(code)
}

func (a *app) run(ctx context.Context, args []string) int {
	err := a.dispatch(ctx, args)
	if err == nil {
		return exitOK
	}
	if errors.Is(err, flag.ErrHelp) {
		fmt.Fprint(a.stdout, usageText)
		return exitOK
	}
	a.say("curt: %v", err)
	var ue *usageError
	if errors.As(err, &ue) {
		return exitUsage
	}
	return exitError
}

func (a *app) dispatch(ctx context.Context, args []string) error {
	if len(args) > 0 {
		rest := args[1:]
		switch args[0] {
		case "list":
			return a.list(ctx, rest, false)
		case "search":
			return a.list(ctx, rest, true)
		case "edit":
			return a.edit(ctx, rest)
		case "delete":
			return a.delete(ctx, rest)
		case "qr":
			return a.qr(ctx, rest)
		case "export":
			return a.export(ctx, rest)
		case "import":
			return a.importLinks(ctx, rest)
		case "login":
			return a.login(ctx, rest)
		case "logout":
			return a.logout(rest)
		case "version", "--version", "-version":
			return a.version(rest)
		case "help":
			return flag.ErrHelp
		}
	}
	return a.shorten(ctx, args)
}

// say writes one message to stderr. The token never gets through, even if a
// server echoes it back in an error.
func (a *app) say(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if a.token != "" {
		msg = strings.ReplaceAll(msg, a.token, "[hidden]")
	}
	lines := strings.Split(msg, "\n")
	for i := range lines {
		lines[i] = clean(lines[i])
	}
	fmt.Fprintln(a.stderr, strings.Join(lines, "\n"))
}

func buildVersion() string {
	if version != "" {
		return version
	}
	if bi, ok := debug.ReadBuildInfo(); ok && bi.Main.Version != "" && bi.Main.Version != "(devel)" {
		return bi.Main.Version
	}
	return "dev"
}

// once is a string flag that may be given one time and may not be empty, so an
// unset shell variable or a repeated flag is an error instead of a surprise.
type once struct {
	value string
	set   bool
}

func (o *once) String() string { return o.value }
func (o *once) Set(s string) error {
	if o.set {
		return errors.New("given more than once")
	}
	if strings.TrimSpace(s) == "" {
		return errors.New("value is empty")
	}
	o.value, o.set = strings.TrimSpace(s), true
	return nil
}

type many []string

func (m *many) String() string { return strings.Join(*m, ", ") }
func (m *many) Set(s string) error {
	if strings.TrimSpace(s) == "" {
		return errors.New("value is empty")
	}
	*m = append(*m, strings.TrimSpace(s))
	return nil
}

// parse allows flags before and after positional arguments, which the flag
// package alone does not.
func parse(name string, args []string, define func(*flag.FlagSet)) ([]string, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	define(fs)
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return nil, err
			}
			return nil, usagef("%v. See curt --help.", err)
		}
		rest := fs.Args()
		if len(rest) == 0 {
			return pos, nil
		}
		used := len(args) - len(rest)
		if used > 0 && args[used-1] == "--" {
			return append(pos, rest...), nil
		}
		pos = append(pos, rest[0])
		args = rest[1:]
	}
}

func wantArgs(pos []string, n int, what string) error {
	if len(pos) == n {
		return nil
	}
	if len(pos) > n {
		return usagef("too many arguments. See curt --help.")
	}
	return usagef("missing %s. See curt --help.", what)
}
