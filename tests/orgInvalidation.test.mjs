import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { useRequestContext } from './support/d1.mjs';

register(new URL('./support/package3Loader.mjs', import.meta.url));

const { PUT: putOrg, POST: postOrg, DELETE: deleteOrg } = await import('../app/api/orgs/route.js');
const {
  PUT: putCollection, POST: postCollection, DELETE: deleteCollection,
} = await import('../app/api/orgs/collections/route.js');
const { loadPublicSitemapRows, publicBlogPath } = await import('../lib/sitemapData.js');
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

async function primeCache(state, context) {
  const rows = await loadPublicSitemapRows();
  await flush(context);
  return rows;
}

async function freshRows(context) {
  const rows = await loadPublicSitemapRows();
  await flush(context);
  return rows;
}

test('org public to private invalidates, refills without the org and announces removals', async () => {
  await withWorld(async ({ sqlite, kv, stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    const primed = await primeCache({}, context);
    assert.ok(primed.blogs.some((row) => row.slug === 'b-org'));

    const response = await putOrg(request('/api/orgs', {
      method: 'PUT', body: { orgId: 'org-acme', visibility: 'private' },
    }));
    assert.equal(response.status, 200);
    await flush(context);

    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    assert.equal(kv.store.has(SITEMAP_KEY), false);

    const rows = await freshRows(context);
    assert.equal(rows.blogs.some((row) => row.slug === 'b-org'), false);
    assert.equal(rows.orgs.some((row) => row.slug === 'acme'), false);
    assert.equal(rows.collections.some((row) => row.cslug === 'series'), false);
    assert.equal(sqlite.prepare("SELECT visibility FROM orgs WHERE id = 'org-acme'").get().visibility, 'private');

    assert.deepEqual(stub.indexNowUrls(), [
      `${SITE_URL}/acme/series/b-org`,
      `${SITE_URL}/acme/b-org-plain`,
    ]);
    assert.deepEqual(stub.unexpected(), []);
  });
});

test('org private to public refills with the newly eligible URLs and announces them', async () => {
  await withWorld(async ({ stub, context }) => {
    await installSession('u-bob', { username: 'bob' });
    await primeCache({}, context);

    const response = await putOrg(request('/api/orgs', {
      method: 'PUT', body: { orgId: 'org-private', visibility: 'public' },
    }));
    assert.equal(response.status, 200);
    await flush(context);

    const rows = await freshRows(context);
    assert.ok(rows.blogs.some((row) => row.slug === 'b-private'));
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/private-hq/b-private`]);
  });
});

test('org slug rename invalidates and announces old and new article URLs', async () => {
  await withWorld(async ({ sqlite, stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    const primed = await primeCache({}, context);
    assert.deepEqual(primed.orgs.map((row) => row.slug).sort(), ['acme']);

    const response = await putOrg(request('/api/orgs', {
      method: 'PUT', body: { orgId: 'org-acme', slug: 'acme-renamed' },
    }));
    assert.equal(response.status, 200);
    await flush(context);

    const rows = await freshRows(context);
    assert.ok(rows.orgs.some((row) => row.slug === 'acme-renamed'));
    assert.ok(rows.orgs.every((row) => row.slug !== 'acme'));
    assert.deepEqual(
      rows.blogs.filter((row) => row.published_as === 'org:org-acme').map(publicBlogPath).sort(),
      ['/acme-renamed/b-org-plain', '/acme-renamed/series/b-org'],
    );
    assert.deepEqual(stub.indexNowUrls().sort(), [
      `${SITE_URL}/acme-renamed/b-org-plain`,
      `${SITE_URL}/acme-renamed/series/b-org`,
      `${SITE_URL}/acme/b-org-plain`,
      `${SITE_URL}/acme/series/b-org`,
    ]);
    assert.equal(sqlite.prepare("SELECT slug FROM orgs WHERE id = 'org-acme'").get().slug, 'acme-renamed');
  });
});

test('org delete keeps the former article URLs as removal notifications', async () => {
  await withWorld(async ({ stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    await primeCache({}, context);

    const response = await deleteOrg(request('/api/orgs', { method: 'DELETE', body: { orgId: 'org-acme' } }));
    assert.equal(response.status, 200);
    await flush(context);

    const rows = await freshRows(context);
    assert.equal(rows.blogs.some((row) => row.published_as === 'org:org-acme'), false);
    assert.equal(rows.orgs.some((row) => row.slug === 'acme'), false);
    assert.deepEqual(stub.indexNowUrls().sort(), [
      `${SITE_URL}/acme/b-org-plain`,
      `${SITE_URL}/acme/series/b-org`,
    ]);
  });
});

test('a slug write followed by a failed update still invalidates and notifies the rename', async () => {
  const sqlite = makeSqlite();
  seedBase(sqlite);
  const timeline = [];
  const kv = makeKV({}, timeline);
  const context = useRequestContext({ DB: failOn(makeD1(sqlite, timeline), /UPDATE orgs SET name = COALESCE/), KV: kv });
  const stub = stubDiscoveryFetch();
  try {
    await installSession('u-alice', { username: 'alice' });
    await primeCache({}, context);

    const response = await putOrg(request('/api/orgs', {
      method: 'PUT', body: { orgId: 'org-acme', slug: 'acme-renamed' },
    }));
    assert.equal(response.status, 500);
    await flush(context);

    assert.equal(sqlite.prepare("SELECT slug FROM orgs WHERE id = 'org-acme'").get().slug, 'acme-renamed');
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    assert.deepEqual(stub.indexNowUrls().sort(), [
      `${SITE_URL}/acme-renamed/b-org-plain`,
      `${SITE_URL}/acme-renamed/series/b-org`,
      `${SITE_URL}/acme/b-org-plain`,
      `${SITE_URL}/acme/series/b-org`,
    ]);
  } finally {
    stub.restore();
    context.restore();
  }
});

test('a denied org update writes nothing and announces nothing', async () => {
  await withWorld(async ({ kv, stub, context }) => {
    await installSession('u-bob', { username: 'bob' });
    await primeCache({}, context);
    const deletesBefore = kv.deletes.length;

    const response = await putOrg(request('/api/orgs', {
      method: 'PUT', body: { orgId: 'org-acme', visibility: 'private' },
    }));
    assert.equal(response.status, 403);
    await flush(context);

    assert.equal(kv.deletes.length, deletesBefore);
    assert.equal(stub.calls.length, 0);
  });
});

test('creating an org invalidates the sitemap snapshot after the row exists', async () => {
  await withWorld(async ({ kv, stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    await primeCache({}, context);

    const response = await postOrg(request('/api/orgs', {
      method: 'POST',
      body: { name: 'New Org', slug: 'new-org', visibility: 'public' },
    }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    assert.equal(stub.calls.filter((call) => call.url.includes('indexnow')).length, 0);
  });
});

test('org collection rename invalidates and announces old and new article URLs', async () => {
  await withWorld(async ({ stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    const primed = await primeCache({}, context);
    assert.ok(primed.collections.some((row) => row.cslug === 'series'));

    const response = await putCollection(request('/api/orgs/collections', {
      method: 'PUT', body: { collectionId: 'col-series', slug: 'series-two' },
    }));
    assert.equal(response.status, 200);
    await flush(context);

    const rows = await freshRows(context);
    assert.ok(rows.collections.some((row) => row.cslug === 'series-two'));
    assert.deepEqual(stub.indexNowUrls().sort(), [
      `${SITE_URL}/acme/series-two/b-org`,
      `${SITE_URL}/acme/series/b-org`,
    ]);
  });
});

test('org collection delete refills the org-path URLs and announces the move', async () => {
  await withWorld(async ({ stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    await primeCache({}, context);

    const response = await deleteCollection(request('/api/orgs/collections', {
      method: 'DELETE', body: { collectionId: 'col-series' },
    }));
    assert.equal(response.status, 200);
    await flush(context);

    const rows = await freshRows(context);
    assert.equal(rows.collections.length, 0);
    assert.deepEqual(rows.blogs.map(publicBlogPath).sort(), [
      '/acme/b-org',
      '/acme/b-org-plain',
      '/alice/b-personal',
    ]);
    assert.deepEqual(stub.indexNowUrls().sort(), [
      `${SITE_URL}/acme/b-org`,
      `${SITE_URL}/acme/series/b-org`,
    ]);
  });
});

test('a denied org collection update writes nothing and announces nothing', async () => {
  await withWorld(async ({ kv, stub, context }) => {
    await installSession('u-bob', { username: 'bob' });
    await primeCache({}, context);
    const deletesBefore = kv.deletes.length;

    const response = await putCollection(request('/api/orgs/collections', {
      method: 'PUT', body: { collectionId: 'col-series', slug: 'series-two' },
    }));
    assert.equal(response.status, 403);
    await flush(context);
    assert.equal(kv.deletes.length, deletesBefore);
    assert.equal(stub.calls.length, 0);
  });
});
