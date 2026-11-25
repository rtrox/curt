CREATE TABLE users (
  id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  name TEXT, email TEXT, is_admin INTEGER NOT NULL DEFAULT 0,
  cutoff_at INTEGER,
  created_at INTEGER NOT NULL, UNIQUE (issuer, subject)
);
CREATE TABLE links (
  id TEXT PRIMARY KEY, domain TEXT NOT NULL, slug TEXT NOT NULL,
  destination TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
  disabled INTEGER NOT NULL DEFAULT 0, expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1, kv_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (domain, slug)
);
CREATE INDEX links_owner ON links(owner_id, created_at, id);
CREATE INDEX links_created ON links(created_at, id);
CREATE INDEX links_slug ON links(slug);
CREATE INDEX links_unsynced ON links(id) WHERE kv_version < version;
CREATE TABLE tags (
  link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  tag TEXT NOT NULL, PRIMARY KEY (link_id, tag)
);
CREATE INDEX tags_tag ON tags(tag);
CREATE TABLE kv_deletes (
  kv_key TEXT PRIMARY KEY, requested_at INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  link_id TEXT, owner_id TEXT
);
CREATE INDEX kv_deletes_link ON kv_deletes(link_id);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE used_nonces (nonce_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
  expires_at INTEGER, last_used_day TEXT, revoked_at INTEGER
);
CREATE TABLE audit (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT NOT NULL,
  action TEXT NOT NULL, link_id TEXT, detail TEXT
);
