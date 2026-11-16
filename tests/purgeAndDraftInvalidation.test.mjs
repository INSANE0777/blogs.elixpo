import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { useRequestContext } from './support/d1.mjs';

register(new URL('./support/package3Loader.mjs', import.meta.url));

const { POST: saveDraft } = await import('../app/api/blogs/draft/route.js');
const { purgeUser } = await import('../lib/purgeUser.js');
const { loadPublicSitemapRows } = await import('../lib/sitemapData.js');
const {
  SITE_URL, SITEMAP_KEY, failOn, flush, installSession, makeD1, makeKV, makeSqlite, request, seedBase,
  stubDiscoveryFetch,
} = await import('./support/package3Fixture.mjs');

function world() {
  const sqlite = makeSqlite();
  seedBase(sqlite);
  const timeline = [];
  return { sqlite, timeline, db: makeD1(sqlite, timeline), kv: makeKV({}, timeline) };
}

async function withWorld(fn) {
  const state = world();
  const context = useRequestContext({ DB: state.db, KV: state.kv });
  const stub = stubDiscoveryFetch();
  try {
    await fn({ ...state, stub, context });
  } finally {
    stub.restore();
    context.restore();
  }
}

async function fresh(context) {
  const rows = await loadPublicSitemapRows();
  await flush(context);
  return rows;
}

const block = (text) => [{ id: 'b1', type: 'paragraph', content: [{ type: 'text', text }] }];

test('purging a user invalidates and refills without their URLs', async () => {
  await withWorld(async ({ sqlite, kv, stub, context }) => {
    sqlite.prepare("INSERT INTO namespaces (name, owner_type, owner_id, created_at) VALUES ('carol', 'user', 'u-carol', 1)").run();
    const primed = await fresh(context);
    assert.deepEqual(primed.curatedCollections.map((row) => `${row.username}/reads/${row.cslug}`), ['carol/reads/reads']);

    await purgeUser(makeD1(sqlite), 'u-carol', { deleteMedia: false });
    await flush(context);

    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    const rows = await fresh(context);
    assert.deepEqual(rows.curatedCollections, []);
    assert.ok(rows.blogs.some((blog) => blog.slug === 'b-personal'), 'unrelated eligible articles stay');
    assert.equal(stub.indexNowUrls().length, 0, 'purge never announces deleted or private new URLs');
  });
});

test('a purge that fails after earlier deletes still invalidates the snapshot', async () => {
  const sqlite = makeSqlite();
  seedBase(sqlite);
  sqlite.prepare("INSERT INTO namespaces (name, owner_type, owner_id, created_at) VALUES ('bob', 'user', 'u-bob', 1)").run();
  const timeline = [];
  const kv = makeKV({}, timeline);
  const context = useRequestContext({
    DB: failOn(makeD1(sqlite, timeline), /DELETE FROM users WHERE id = \?/),
    KV: kv,
  });
  const stub = stubDiscoveryFetch();
  try {
    await fresh(context);
    await assert.rejects(purgeUser(makeFailingDb(sqlite, timeline), 'u-bob', { deleteMedia: false }), /forced failure/);
    await flush(context);
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
  } finally {
    stub.restore();
    context.restore();
  }
});

test('a published draft save invalidates after the final tag rewrite', async () => {
  await withWorld(async ({ sqlite, timeline, stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    await fresh(context);

    const response = await saveDraft(request('/api/blogs/draft', {
      method: 'POST',
      body: { slugid: 'b-personal', title: 'Fresh title', editorContent: block('one two three'), tags: ['new-tag'] },
    }));
    assert.equal(response.status, 200);
    await flush(context);

    const tagWrite = timeline
      .map((entry) => entry.kind === 'sql' && entry.sql.includes('INSERT OR IGNORE INTO blog_tags'))
      .lastIndexOf(true);
    const sitemapDelete = timeline.findIndex((entry) => entry.kind === 'kv-delete' && entry.key === SITEMAP_KEY);
    assert.ok(tagWrite >= 0, 'the tag rewrite ran');
    assert.ok(sitemapDelete > tagWrite, 'invalidation happens after the tag rewrite');

    const rows = await fresh(context);
    assert.deepEqual(rows.tags.map((row) => row.tag), ['new-tag', 'shared']);
    assert.equal(sqlite.prepare("SELECT title FROM blogs WHERE id = 'b-personal'").get().title, 'Fresh title');
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`], 'unchanged URL is announced once');
  });
});

test('a tag write failure after the blog update still invalidates', async () => {
  const sqlite = makeSqlite();
  seedBase(sqlite);
  const timeline = [];
  const kv = makeKV({}, timeline);
  const context = useRequestContext({ DB: failOn(makeD1(sqlite, timeline), /DELETE FROM blog_tags/), KV: kv });
  const stub = stubDiscoveryFetch();
  try {
    await installSession('u-alice', { username: 'alice' });
    await fresh(context);

    const response = await saveDraft(request('/api/blogs/draft', {
      method: 'POST',
      body: { slugid: 'b-personal', title: 'Partial', editorContent: block('one two three'), tags: ['new-tag'] },
    }));
    assert.equal(response.status, 500);
    await flush(context);

    assert.equal(sqlite.prepare("SELECT title FROM blogs WHERE id = 'b-personal'").get().title, 'Partial');
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
  } finally {
    stub.restore();
    context.restore();
  }
});

test('moving a published article to another target announces old and new URLs', async () => {
  await withWorld(async ({ stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    await fresh(context);

    const response = await saveDraft(request('/api/blogs/draft', {
      method: 'POST',
      body: {
        slugid: 'b-personal', title: 'Moved', publishAs: 'org:org-acme',
        editorContent: block('one two three'),
      },
    }));
    assert.equal(response.status, 200);
    await flush(context);

    assert.deepEqual(stub.indexNowUrls(), [
      `${SITE_URL}/alice/b-personal`,
      `${SITE_URL}/acme/b-personal`,
    ]);
  });
});

function makeFailingDb(sqlite, timeline) {
  return failOn(makeD1(sqlite, timeline), /DELETE FROM users WHERE id = \?/);
}
