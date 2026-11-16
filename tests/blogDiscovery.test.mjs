import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./support/platformLoader.mjs', import.meta.url));

const {
  DISCOVERY_BATCH_LIMIT,
  getIndexableBlogUrl,
  getIndexableBlogUrlsForBlogIds,
  notifyBlogDiscoveryChange,
} = await import('../lib/blogDiscovery.js');
const {
  SITE_URL, insertBlog, makeD1, makeSqlite, seedBase, stubDiscoveryFetch,
} = await import('./support/package3Fixture.mjs');

function setup() {
  const sqlite = makeSqlite();
  seedBase(sqlite);
  return { sqlite, db: makeD1(sqlite) };
}

function withFetch(fn) {
  const stub = stubDiscoveryFetch();
  return Promise.resolve()
    .then(() => fn(stub))
    .finally(() => stub.restore());
}

test('an unchanged eligible article is announced once', async () => {
  const { db } = setup();
  const url = await getIndexableBlogUrl(db, 'b-personal');
  assert.equal(url, `${SITE_URL}/alice/b-personal`);

  await withFetch(async (stub) => {
    notifyBlogDiscoveryChange(url, url);
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`]);
    assert.equal(stub.webSubCalls().length, 1);
  });
});

test('an eligible rename announces the old and the new URL', async () => {
  const { sqlite, db } = setup();
  const before = await getIndexableBlogUrl(db, 'b-personal');
  sqlite.prepare("UPDATE blogs SET slug = 'renamed' WHERE id = 'b-personal'").run();
  const after = await getIndexableBlogUrl(db, 'b-personal');

  assert.equal(before, `${SITE_URL}/alice/b-personal`);
  assert.equal(after, `${SITE_URL}/alice/renamed`);
  await withFetch(async (stub) => {
    notifyBlogDiscoveryChange(before, after);
    assert.deepEqual(stub.indexNowUrls(), [before, after]);
  });
});

test('a newly eligible article announces only its new URL', async () => {
  const { sqlite, db } = setup();
  const before = await getIndexableBlogUrl(db, 'b-draft');
  sqlite.prepare("UPDATE blogs SET status = 'published' WHERE id = 'b-draft'").run();
  const after = await getIndexableBlogUrl(db, 'b-draft');

  assert.equal(before, null);
  assert.equal(after, `${SITE_URL}/alice/b-draft`);
  await withFetch(async (stub) => {
    notifyBlogDiscoveryChange(before, after);
    assert.deepEqual(stub.indexNowUrls(), [after]);
  });
});

test('a removed article announces only its former URL', async () => {
  const { sqlite, db } = setup();
  const before = await getIndexableBlogUrl(db, 'b-personal');
  sqlite.prepare("UPDATE blogs SET status = 'under_review' WHERE id = 'b-personal'").run();
  const after = await getIndexableBlogUrl(db, 'b-personal');

  assert.equal(after, null);
  await withFetch(async (stub) => {
    notifyBlogDiscoveryChange(before, after);
    assert.deepEqual(stub.indexNowUrls(), [before]);
  });
});

test('an ineligible to ineligible change sends nothing', async () => {
  const { sqlite, db } = setup();
  const before = await getIndexableBlogUrl(db, 'b-draft');
  sqlite.prepare("UPDATE blogs SET title = 'changed' WHERE id = 'b-draft'").run();
  const after = await getIndexableBlogUrl(db, 'b-draft');

  await withFetch(async (stub) => {
    notifyBlogDiscoveryChange(before, after);
    assert.deepEqual(before, null);
    assert.deepEqual(after, null);
    assert.equal(stub.calls.length, 0);
  });
});

test('private, dangling, unknown and missing rows resolve to no URL', async () => {
  const { sqlite, db } = setup();
  insertBlog(sqlite, 'b-dangling', { published_as: 'org:missing' });
  insertBlog(sqlite, 'b-unknown', { published_as: 'team:1' });
  insertBlog(sqlite, 'b-ghost-author', { author_id: 'u-missing' });

  assert.equal(await getIndexableBlogUrl(db, 'b-private'), null);
  assert.equal(await getIndexableBlogUrl(db, 'b-dangling'), null);
  assert.equal(await getIndexableBlogUrl(db, 'b-unknown'), null);
  assert.equal(await getIndexableBlogUrl(db, 'b-ghost-author'), null);
  assert.equal(await getIndexableBlogUrl(db, 'does-not-exist'), null);
  assert.equal(await getIndexableBlogUrl(db, ''), null);
});

test('member-only posts stay eligible and keep their canonical URL', async () => {
  const { sqlite, db } = setup();
  insertBlog(sqlite, 'b-member', { member_only: 1, updated_at: 550 });
  insertBlog(sqlite, 'b-member-org', { member_only: 1, published_as: 'org:org-acme', updated_at: 560 });

  assert.equal(await getIndexableBlogUrl(db, 'b-member'), `${SITE_URL}/alice/b-member`);
  assert.equal(await getIndexableBlogUrl(db, 'b-member-org'), `${SITE_URL}/acme/b-member-org`);
});

test('bulk lookups map the same rows to their committed URLs', async () => {
  const { sqlite, db } = setup();
  const ids = ['b-org', 'b-private', 'b-draft'];
  assert.deepEqual(await getIndexableBlogUrlsForBlogIds(db, ids), [`${SITE_URL}/acme/series/b-org`]);

  sqlite.prepare("UPDATE collections SET slug = 'series-two' WHERE id = 'col-series'").run();
  assert.deepEqual(await getIndexableBlogUrlsForBlogIds(db, ids), [`${SITE_URL}/acme/series-two/b-org`]);

  sqlite.prepare('UPDATE blogs SET collection_id = NULL WHERE id = ?').run('b-org');
  assert.deepEqual(await getIndexableBlogUrlsForBlogIds(db, ids), [`${SITE_URL}/acme/b-org`]);
});

test('the notification union deduplicates and chunks at the provider limit', async () => {
  assert.equal(DISCOVERY_BATCH_LIMIT, 10000);
  const urls = Array.from({ length: DISCOVERY_BATCH_LIMIT + 1 }, (_, index) => `${SITE_URL}/writer/post-${index}`);

  await withFetch(async (stub) => {
    notifyBlogDiscoveryChange(urls, [urls[0]]);
    const payloads = stub.indexNowPayloads();
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].length, DISCOVERY_BATCH_LIMIT);
    assert.equal(payloads[1].length, 1);
    assert.equal(new Set(stub.indexNowUrls()).size, DISCOVERY_BATCH_LIMIT + 1);
    assert.equal(stub.webSubCalls().length, 2);
  });
});

test('the notification union ignores empty and non-site values', async () => {
  await withFetch(async (stub) => {
    notifyBlogDiscoveryChange(null, undefined);
    notifyBlogDiscoveryChange(['', 'javascript:alert(1)', 'https://evil.example/post'], []);
    assert.equal(stub.calls.length, 0);
  });
});
