import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { useRequestContext } from './support/d1.mjs';

register(new URL('./support/package3Loader.mjs', import.meta.url));

const { PATCH: patchCollections } = await import('../app/api/library/collections/route.js');
const { PUT: putCollection, DELETE: deleteLibraryCollection } = await import('../app/api/library/collections/[id]/route.js');
const {
  POST: postLibraryEntry, PATCH: patchLibraryEntry, DELETE: deleteLibraryEntry,
} = await import('../app/api/library/collections/[id]/entries/route.js');
const { POST: postV1Collection } = await import('../app/api/v1/collections/route.js');
const { PATCH: patchV1Collection, DELETE: deleteV1Collection } = await import('../app/api/v1/collections/[id]/route.js');
const { POST: postV1Entry, DELETE: deleteV1Entry } = await import('../app/api/v1/collections/[id]/entries/route.js');
const { loadPublicSitemapRows } = await import('../lib/sitemapData.js');
const {
  SITEMAP_KEY, bearerToken, flush, installSession, makeD1, makeKV, makeSqlite, request, seedBase,
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

async function prime(context) {
  await loadPublicSitemapRows();
  await flush(context);
}

async function fresh(context) {
  const rows = await loadPublicSitemapRows();
  await flush(context);
  return rows;
}

const curatedPaths = (rows) => rows.curatedCollections
  .map((row) => `/${row.username}/reads/${row.cslug}`)
  .sort();

test('a curated collection rename and visibility change invalidates and refills the URL', async () => {
  await withWorld(async ({ kv, stub, context }) => {
    await installSession('u-carol', { username: 'carol' });
    const primed = await fresh(context);
    assert.deepEqual(curatedPaths(primed), ['/carol/reads/reads']);
    await prime(context);

    const response = await patchCollections(request('/api/library/collections', {
      method: 'PATCH', body: { id: 'bc-public', name: 'New Reads', visibility: 'private' },
    }));
    assert.equal(response.status, 200);
    await flush(context);

    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    assert.deepEqual(curatedPaths(await fresh(context)), []);
    assert.equal(stub.calls.length, 0, 'collection pages are not article notifications');
  });
});

test('a curated collection made public adds its URL to the fresh snapshot', async () => {
  await withWorld(async ({ sqlite, context }) => {
    await installSession('u-carol', { username: 'carol' });
    sqlite.prepare('INSERT INTO curated_collection_entries (collection_id, blog_id, added_by) VALUES (?, ?, ?)')
      .run('bc-private', 'b-personal', 'u-carol');
    assert.deepEqual(curatedPaths(await fresh(context)), ['/carol/reads/reads']);

    const response = await putCollection(request('/api/library/collections/bc-private', {
      method: 'PUT', body: { visibility: 'public' },
    }), { params: Promise.resolve({ id: 'bc-private' }) });
    assert.equal(response.status, 200);
    await flush(context);

    assert.deepEqual(curatedPaths(await fresh(context)), ['/carol/reads/private-reads', '/carol/reads/reads']);
  });
});

test('library entry add, reorder and remove keep the snapshot fresh', async () => {
  await withWorld(async ({ context }) => {
    await installSession('u-carol', { username: 'carol' });
    const params = { params: Promise.resolve({ id: 'bc-private' }) };
    await fresh(context);

    const add = await postLibraryEntry(request('/api/library/collections/bc-private/entries', {
      method: 'POST', body: { blogId: 'b-personal' },
    }), params);
    assert.equal(add.status, 201);
    await flush(context);
    await putCollection(request('/api/library/collections/bc-private', {
      method: 'PUT', body: { visibility: 'public' },
    }), params);
    await flush(context);
    assert.deepEqual(curatedPaths(await fresh(context)), ['/carol/reads/private-reads', '/carol/reads/reads']);

    const reorder = await patchLibraryEntry(request('/api/library/collections/bc-private/entries', {
      method: 'PATCH', body: { order: ['b-personal'] },
    }), params);
    assert.equal(reorder.status, 200);
    await flush(context);

    const remove = await deleteLibraryEntry(request('/api/library/collections/bc-private/entries?blogId=b-personal', {
      method: 'DELETE',
    }), params);
    assert.equal(remove.status, 200);
    await flush(context);
    assert.deepEqual(curatedPaths(await fresh(context)), ['/carol/reads/reads']);
  });
});

test('deleting a curated collection removes its URL', async () => {
  await withWorld(async ({ context }) => {
    await installSession('u-carol', { username: 'carol' });
    await fresh(context);

    const response = await deleteLibraryCollection(request('/api/library/collections/bc-public', {
      method: 'DELETE',
    }), { params: Promise.resolve({ id: 'bc-public' }) });
    assert.equal(response.status, 200);
    await flush(context);
    assert.deepEqual(curatedPaths(await fresh(context)), []);
  });
});

test('the v1 collections API invalidates create, visibility and delete', async () => {
  await withWorld(async ({ kv, context }) => {
    const token = await bearerToken('u-carol', ['lixblogs:blog:write']);
    const headers = { authorization: `Bearer ${token}` };
    await fresh(context);

    const created = await postV1Collection(request('/api/v1/collections', {
      method: 'POST', headers, body: { name: 'V1 Reads', slug: 'v1-reads', visibility: 'public' },
    }));
    assert.equal(created.status, 201);
    await flush(context);
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    const { data: collection } = await created.json();
    assert.equal(collection.slug, 'v1-reads');

    // Nothing is in the collection yet, so the fresh snapshot has no URL for it.
    assert.equal(curatedPaths(await fresh(context)).includes('/carol/reads/v1-reads'), false);

    const params = { params: Promise.resolve({ id: collection.id }) };
    const added = await postV1Entry(request(`/api/v1/collections/${collection.id}/entries`, {
      method: 'POST', headers, body: { blogId: 'b-personal' },
    }), params);
    assert.equal(added.status, 201);
    await flush(context);
    assert.ok(curatedPaths(await fresh(context)).includes('/carol/reads/v1-reads'));

    const hidden = await patchV1Collection(request(`/api/v1/collections/${collection.id}`, {
      method: 'PATCH', headers, body: { visibility: 'private' },
    }), params);
    assert.equal(hidden.status, 200);
    await flush(context);
    assert.equal(curatedPaths(await fresh(context)).includes('/carol/reads/v1-reads'), false);

    await patchV1Collection(request(`/api/v1/collections/${collection.id}`, {
      method: 'PATCH', headers, body: { visibility: 'public' },
    }), params);
    await flush(context);
    assert.ok(curatedPaths(await fresh(context)).includes('/carol/reads/v1-reads'));

    const removed = await deleteV1Entry(request(`/api/v1/collections/${collection.id}/entries?blogId=b-personal`, {
      method: 'DELETE', headers,
    }), params);
    assert.equal(removed.status, 200);
    await flush(context);
    assert.equal(curatedPaths(await fresh(context)).includes('/carol/reads/v1-reads'), false);

    const deleted = await deleteV1Collection(request(`/api/v1/collections/${collection.id}`, {
      method: 'DELETE', headers,
    }), params);
    assert.equal(deleted.status, 200);
    await flush(context);
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
  });
});

test('a no-write curated update leaves the snapshot alone', async () => {
  await withWorld(async ({ kv, stub, context }) => {
    await installSession('u-bob', { username: 'bob' });
    await fresh(context);
    const deletesBefore = kv.deletes.length;

    const response = await patchCollections(request('/api/library/collections', {
      method: 'PATCH', body: { id: 'bc-public', visibility: 'private' },
    }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.equal(kv.deletes.length, deletesBefore);
    assert.equal(stub.calls.length, 0);
  });
});
