package main

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	durationForm = regexp.MustCompile(`^(\d{1,6}[mhdw])+$`)
	durationPart = regexp.MustCompile(`(\d+)([mhdw])`)
	units        = map[string]time.Duration{
		"m": time.Minute, "h": time.Hour, "d": 24 * time.Hour, "w": 7 * 24 * time.Hour,
	}
)

const maxExpiry = 100 * 365 * 24 * time.Hour

// parseExpires returns Unix seconds, or nil for "never". A plain date lasts
// through the end of that day in local time.
func parseExpires(s string, now time.Time) (*int64, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "never" {
		return nil, nil
	}
	var at time.Time
	if durationForm.MatchString(s) {
		var total time.Duration
		for _, p := range durationPart.FindAllStringSubmatch(s, -1) {
			n, _ := strconv.ParseInt(p[1], 10, 64)
			if n > int64(maxExpiry/units[p[2]]) {
				return nil, usagef("--expires is more than 100 years away")
			}
			if total += time.Duration(n) * units[p[2]]; total > maxExpiry {
				return nil, usagef("--expires is more than 100 years away")
			}
		}
		at = now.Add(total)
	} else if day, err := time.ParseInLocation("2006-01-02", s, now.Location()); err == nil {
		at = day.AddDate(0, 0, 1).Add(-time.Second)
	} else if t, err := time.Parse(time.RFC3339, strings.ToUpper(s)); err == nil {
		at = t
	} else {
		return nil, usagef("--expires must be a duration such as 7d, a date such as 2030-12-31, an RFC 3339 time, or never")
	}
	if at.Unix() <= now.Unix() {
		return nil, usagef("--expires is not in the future")
	}
	if at.Sub(now) > maxExpiry {
		return nil, usagef("--expires is more than 100 years away")
	}
	unix := at.Unix()
	return &unix, nil
}
