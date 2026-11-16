// Shared offline fixture for package-3 behavior tests: real handler SQL against
// in-memory SQLite, a controlled KV, a recording timeline and stubbed network.
import { DatabaseSync } from 'node:sqlite';
import { signSession } from '../../lib/auth.js';

export const SITE_URL = 'https://blogs.elixpo.com';
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
export const WEBSUB_HUB = 'https://pubsubhubbub.appspot.com/';
export const SITEMAP_KEY = 'v3:public-sitemap-rows';

export const SCHEMA = `
  CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT, email TEXT,
    avatar_url TEXT, tier TEXT, locale TEXT, updated_at INTEGER);
  CREATE TABLE orgs (id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, tagline TEXT,
    description TEXT, bio TEXT, website TEXT, links TEXT, visibility TEXT, owner_id TEXT,
    featured_blog_ids TEXT, timezone TEXT, location TEXT, contact_email TEXT,
    logo_r2_key TEXT, logo_url TEXT, banner_r2_key TEXT, banner_url TEXT, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE org_members (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER);
  CREATE TABLE org_invites (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT, role TEXT,
    invited_by TEXT, created_by TEXT, created_at INTEGER);
  CREATE TABLE namespaces (name TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, created_at INTEGER);
  CREATE TABLE collections (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE blogs (id TEXT PRIMARY KEY, slug TEXT NOT NULL, slugid TEXT, title TEXT, subtitle TEXT,
    content TEXT, excerpt TEXT, author_id TEXT NOT NULL, published_as TEXT, collection_id TEXT,
    status TEXT NOT NULL DEFAULT 'draft', page_emoji TEXT, cover_image_r2_key TEXT,
    cover_pos_x REAL, cover_pos_y REAL, cover_zoom REAL, read_time_minutes INTEGER,
    secret INTEGER NOT NULL DEFAULT 0, member_only INTEGER NOT NULL DEFAULT 0, license TEXT,
    language TEXT, region TEXT, allow_comments INTEGER DEFAULT 1, deleted_at INTEGER,
    pre_delete_status TEXT, created_at INTEGER, updated_at INTEGER, published_at INTEGER);
  CREATE TABLE blog_tags (blog_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (blog_id, tag));
  CREATE TABLE blog_co_authors (blog_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT, status TEXT);
  CREATE TABLE blog_versions (id TEXT PRIMARY KEY, blog_id TEXT NOT NULL, content TEXT, label TEXT,
    created_by TEXT, created_at INTEGER);
  CREATE TABLE bookmark_collections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT, introduction TEXT, cover_url TEXT, slug TEXT, is_public INTEGER DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'private', created_at INTEGER, updated_at INTEGER);
  CREATE TABLE curated_collection_entries (collection_id TEXT NOT NULL, blog_id TEXT NOT NULL,
    added_by TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, curator_note TEXT, category TEXT,
    added_at INTEGER, updated_at INTEGER, PRIMARY KEY (collection_id, blog_id));
  CREATE TABLE curation_preferences (user_id TEXT PRIMARY KEY, allow_public_curation INTEGER DEFAULT 1,
    default_license TEXT);
  CREATE TABLE contests (id TEXT PRIMARY KEY, organizer_id TEXT, slug TEXT NOT NULL, title TEXT,
    description TEXT, problem_statement TEXT, rules TEXT, theme TEXT, cover_url TEXT,
    template_content TEXT, status TEXT NOT NULL DEFAULT 'draft', starts_at INTEGER,
    submissions_close_at INTEGER, judging_closes_at INTEGER, results_at INTEGER,
    required_topics TEXT, tags TEXT, allowed_targets TEXT, eligibility TEXT, per_author_limit INTEGER,
    language TEXT, region TEXT, published_at INTEGER, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE contest_members (contest_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER);
  CREATE TABLE contest_submissions (id TEXT PRIMARY KEY, contest_id TEXT NOT NULL, blog_id TEXT,
    author_id TEXT NOT NULL, snapshot_content TEXT, snapshot_metadata TEXT, withdrawn_at INTEGER, created_at INTEGER);
  CREATE TABLE contest_awards (contest_id TEXT NOT NULL, submission_id TEXT NOT NULL, placement TEXT NOT NULL,
    position INTEGER NOT NULL, awarded_by TEXT, awarded_at INTEGER);
  CREATE TABLE contest_audit_log (id TEXT PRIMARY KEY, contest_id TEXT NOT NULL, actor_id TEXT,
    action TEXT NOT NULL, target_id TEXT, metadata TEXT, created_at INTEGER);
  CREATE TABLE reports (id TEXT PRIMARY KEY, blog_id TEXT NOT NULL, reporter_id TEXT, reason TEXT,
    detail TEXT, status TEXT DEFAULT 'open', gh_issue_number INTEGER, created_at INTEGER);
  CREATE TABLE subpages (id TEXT PRIMARY KEY, blog_id TEXT NOT NULL);
  CREATE TABLE blog_collab_state (blog_id TEXT PRIMARY KEY);
  CREATE TABLE media_uploads (id TEXT PRIMARY KEY, user_id TEXT, blog_id TEXT, cloudinary_public_id TEXT,
    storage_provider TEXT, storage_cloud_name TEXT);
  CREATE TABLE notifications (id TEXT PRIMARY KEY, user_id TEXT, actor_id TEXT, actor_name TEXT,
    actor_avatar TEXT, type TEXT, target_id TEXT, target_title TEXT, target_url TEXT, created_at INTEGER);
  CREATE TABLE follows (follower_id TEXT, following_id TEXT);
  CREATE TABLE comments (id TEXT PRIMARY KEY, blog_id TEXT, user_id TEXT, parent_id TEXT);
  CREATE TABLE likes (blog_id TEXT, user_id TEXT);
  CREATE TABLE claps (blog_id TEXT, user_id TEXT);
  CREATE TABLE bookmarks (blog_id TEXT, user_id TEXT, collection_id TEXT);
  CREATE TABLE read_history (blog_id TEXT, user_id TEXT);
  CREATE TABLE blog_views (id TEXT PRIMARY KEY, blog_id TEXT, user_id TEXT);
  CREATE TABLE user_interests (user_id TEXT, tag TEXT);
  CREATE TABLE user_signals (user_id TEXT, signal TEXT);
  CREATE TABLE search_history (user_id TEXT, query TEXT);
  CREATE TABLE cloudinary_connections (user_id TEXT PRIMARY KEY);
  CREATE TABLE api_rate_limits (subject_id TEXT NOT NULL, route TEXT NOT NULL, window_start INTEGER NOT NULL,
    request_count INTEGER NOT NULL, PRIMARY KEY (subject_id, route, window_start));
  CREATE TABLE api_idempotency_keys (user_id TEXT NOT NULL, operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, status_code INTEGER, response_body TEXT,
    created_at INTEGER, expires_at INTEGER, PRIMARY KEY (user_id, operation, idempotency_key));
  CREATE TABLE api_audit_events (id TEXT PRIMARY KEY, request_id TEXT, user_id TEXT, client_id TEXT,
    action TEXT, resource_type TEXT, resource_id TEXT, outcome TEXT, created_at INTEGER);
`;

export function makeSqlite() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  return sqlite;
}

// sqlite-backed D1 with the batch() the handlers use. Statements are recorded in
// the shared timeline so tests can assert write ordering against KV deletion.
export function makeD1(sqlite, timeline = []) {
  const statement = (sql, params) => ({
    async all() {
      return { results: sqlite.prepare(sql).all(...params), success: true, meta: {} };
    },
    async first() {
      return sqlite.prepare(sql).get(...params) ?? null;
    },
    async run() {
      const info = sqlite.prepare(sql).run(...params);
      timeline.push({ kind: 'sql', sql });
      return { success: true, meta: { changes: Number(info.changes) } };
    },
  });
  const bindable = (sql, params) => {
    const prepared = statement(sql, params);
    prepared.bind = (...next) => bindable(sql, next);
    return prepared;
  };
  return {
    prepare: (sql) => bindable(sql, []),
    async batch(statements) {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
  };
}

// Fails the first `failAt` matching prepare() calls, to simulate a later write
// failing after an earlier one committed.
export function failOn(db, matcher, failAt = 0) {
  let hits = 0;
  return {
    prepare(sql) {
      if (matcher.test(sql)) {
        if (hits >= failAt) throw new Error(`forced failure: ${sql}`);
        hits += 1;
      }
      return db.prepare(sql);
    },
    batch: (statements) => db.batch(statements),
  };
}

export function makeKV(initial = {}, timeline = []) {
  const store = new Map(Object.entries(initial));
  const puts = [];
  const deletes = [];
  return {
    store,
    puts,
    deletes,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      puts.push({ key, options });
      store.set(key, JSON.parse(value));
    },
    async delete(key) {
      deletes.push(key);
      timeline.push({ kind: 'kv-delete', key });
      store.delete(key);
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function stubDiscoveryFetch() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || input);
    const body = init.body ? String(init.body) : null;
    calls.push({ url, method: init.method || 'GET', body });
    if (url.startsWith('https://accounts.elixpo.com/')) return jsonResponse({ available: true });
    return jsonResponse({ ok: true });
  };
  return {
    calls,
    indexNowPayloads() {
      return calls
        .filter((call) => call.url === INDEXNOW_ENDPOINT)
        .map((call) => JSON.parse(call.body).urlList);
    },
    indexNowUrls() {
      return this.indexNowPayloads().flat();
    },
    webSubCalls() {
      return calls.filter((call) => call.url === WEBSUB_HUB);
    },
    unexpected() {
      return calls.filter((call) => call.url !== INDEXNOW_ENDPOINT
        && call.url !== WEBSUB_HUB
        && !call.url.startsWith('https://accounts.elixpo.com/'));
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

const SESSION_SYMBOL = Symbol.for('lixblogs.test.sessionCookie');

export async function installSession(userId, profile = {}) {
  process.env.SESSION_SECRET ||= 'package3-test-session-secret';
  const value = await signSession({
    userId,
    sessionExpiresAt: Date.now() + 60 * 60 * 1000,
    profile: { username: profile.username || 'tester', display_name: profile.display_name || 'Tester' },
  });
  globalThis[SESSION_SYMBOL] = value;
}

export function clearSession() {
  delete globalThis[SESSION_SYMBOL];
}

let signingPair;
async function keyPair() {
  signingPair ??= await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return signingPair;
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function bearerToken(userId, scopes, options = {}) {
  const { privateKey, publicKey } = await keyPair();
  if (!process.env.ACCOUNTS_JWT_PUBLIC_KEY) {
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64');
    const lines = spki.match(/.{1,64}/g).join('\n');
    process.env.ACCOUNTS_JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    type: 'access',
    sub: userId,
    aud: 'blogs.elixpo.com',
    client_id: 'lixblogs-cli-prod',
    scopes,
    sid: 'test-session',
    iat: now,
    nbf: now - 1,
    exp: now + 3600,
    ...options,
  }));
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

export function insertUser(sqlite, id, username, extra = {}) {
  sqlite.prepare('INSERT INTO users (id, username, display_name, email, tier, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, username, extra.display_name || username, extra.email || `${username}@example.com`, extra.tier || 'member', extra.updated_at ?? 100);
}

export function insertOrg(sqlite, id, slug, extra = {}) {
  sqlite.prepare(`
    INSERT INTO orgs (id, slug, name, visibility, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, slug, extra.name || slug, extra.visibility ?? 'public', extra.owner_id || 'u-alice', extra.created_at ?? 100, extra.updated_at ?? 100);
}

export function insertCollection(sqlite, id, orgId, slug, extra = {}) {
  sqlite.prepare('INSERT INTO collections (id, org_id, slug, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, slug, extra.name || slug, extra.created_by || 'u-alice', extra.created_at ?? 100, extra.updated_at ?? 100);
}

const LONG_CONTENT = JSON.stringify([{
  id: 'seed-block',
  type: 'paragraph',
  content: [{
    type: 'text',
    text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty',
  }],
}]);

export function insertBlog(sqlite, id, fields = {}) {
  const row = {
    slug: fields.slug ?? id,
    slugid: fields.slugid ?? id,
    author_id: fields.author_id ?? 'u-alice',
    published_as: fields.published_as ?? 'personal',
    collection_id: fields.collection_id ?? null,
    status: fields.status ?? 'published',
    secret: fields.secret ?? 0,
    member_only: fields.member_only ?? 0,
    deleted_at: fields.deleted_at ?? null,
    published_at: fields.published_at ?? 100,
    updated_at: fields.updated_at ?? 500,
    created_at: fields.created_at ?? 100,
  };
  sqlite.prepare(`
    INSERT INTO blogs (id, slug, slugid, title, author_id, published_as, collection_id, status, secret,
      member_only, deleted_at, published_at, updated_at, created_at, content, excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
  `).run(
    id, row.slug, row.slugid, fields.title ?? id, row.author_id, row.published_as, row.collection_id,
    row.status, row.secret, row.member_only, row.deleted_at, row.published_at, row.updated_at, row.created_at,
    fields.content ?? LONG_CONTENT,
  );
}

export function insertCuratedCollection(sqlite, id, userId, slug, extra = {}) {
  sqlite.prepare(`
    INSERT INTO bookmark_collections (id, user_id, name, slug, visibility, is_public, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, extra.name || slug, slug, extra.visibility ?? 'public', extra.visibility === 'public' ? 1 : 0, 100, extra.updated_at ?? 100);
}

export function insertContest(sqlite, id, slug, extra = {}) {
  sqlite.prepare(`
    INSERT INTO contests (id, organizer_id, slug, title, status, starts_at, submissions_close_at,
      judging_closes_at, results_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, extra.organizer_id || 'u-alice', slug, extra.title || slug, extra.status || 'scheduled',
    extra.starts_at ?? 100, extra.submissions_close_at ?? 200, extra.judging_closes_at ?? 300,
    extra.results_at ?? null, 100, extra.updated_at ?? 100,
  );
}

// Base world: alice (org owner), bob (private-org owner), carol (curator).
export function seedBase(sqlite) {
  insertUser(sqlite, 'u-alice', 'alice');
  insertUser(sqlite, 'u-bob', 'bob');
  insertUser(sqlite, 'u-carol', 'carol');
  sqlite.exec(`
    INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES
      ('org-acme', 'u-alice', 'admin', 100),
      ('org-acme', 'u-bob', 'write', 100),
      ('org-private', 'u-bob', 'admin', 100);
  `);
  insertOrg(sqlite, 'org-acme', 'acme', { owner_id: 'u-alice' });
  insertOrg(sqlite, 'org-private', 'private-hq', { owner_id: 'u-bob', visibility: 'private' });
  insertOrg(sqlite, 'org-legacy', 'legacy-hq', { owner_id: 'u-bob', visibility: null });
  insertCollection(sqlite, 'col-series', 'org-acme', 'series');
  insertBlog(sqlite, 'b-personal', { author_id: 'u-alice', updated_at: 500 });
  insertBlog(sqlite, 'b-org', { published_as: 'org:org-acme', collection_id: 'col-series', updated_at: 400 });
  insertBlog(sqlite, 'b-org-plain', { published_as: 'org:org-acme', updated_at: 300 });
  insertBlog(sqlite, 'b-private', { author_id: 'u-bob', published_as: 'org:org-private', updated_at: 900 });
  insertBlog(sqlite, 'b-secret', { secret: 1, updated_at: 800 });
  insertBlog(sqlite, 'b-unlisted', { status: 'unlisted', updated_at: 700 });
  insertBlog(sqlite, 'b-draft', { status: 'draft', updated_at: 600 });
  sqlite.exec(`
    INSERT INTO blog_tags (blog_id, tag) VALUES ('b-personal', 'shared'), ('b-org', 'shared');
  `);
  insertCuratedCollection(sqlite, 'bc-public', 'u-carol', 'reads', { visibility: 'public' });
  sqlite.prepare('INSERT INTO curated_collection_entries (collection_id, blog_id, added_by) VALUES (?, ?, ?)')
    .run('bc-public', 'b-personal', 'u-carol');
  insertCuratedCollection(sqlite, 'bc-private', 'u-carol', 'private-reads', { visibility: 'private' });
  insertContest(sqlite, 'c-live', 'live-contest', { status: 'live', updated_at: 100 });
  sqlite.prepare("INSERT INTO contests (id, organizer_id, slug, title, status, starts_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)")
    .run('c-draft', 'u-alice', 'draft-contest', 'draft-contest', 400, 100);
}

export async function flush(context) {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await context.settle();
  await new Promise((resolve) => setImmediate(resolve));
  await context.settle();
}

export function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Request(`${SITE_URL}${url}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
