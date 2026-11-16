import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { useRequestContext } from './support/d1.mjs';

register(new URL('./support/package3Loader.mjs', import.meta.url));
const { POST: publishWeb } = await import('../app/api/blogs/publish/route.js');
const { POST: saveDraft } = await import('../app/api/blogs/draft/route.js');
const { DELETE: deleteOrg } = await import('../app/api/orgs/route.js');
const { GET: runCron } = await import('../app/api/cron/contests/route.js');
const { PATCH: patchEntries } = await import('../app/api/library/collections/[id]/entries/route.js');
const { POST: publishV1 } = await import('../app/api/v1/blogs/[id]/publish/route.js');
const { POST: unpublishV1 } = await import('../app/api/v1/blogs/[id]/unpublish/route.js');
const { POST: restoreV1 } = await import('../app/api/v1/blogs/[id]/restore/route.js');
const { PATCH: patchV1 } = await import('../app/api/v1/blogs/[id]/route.js');
const { blogEntityTag } = await import('../lib/api/v1/entityTag.js');
const { loadPublicSitemapRows } = await import('../lib/sitemapData.js');
const {
  SITE_URL, SITEMAP_KEY, bearerToken, failOn, flush, installSession,
  insertContest, makeD1, makeKV, makeSqlite, request, seedBase, stubDiscoveryFetch,
} = await import('./support/package3Fixture.mjs');

async function withFailure(matcher, fn) {
  const sqlite = makeSqlite();
  seedBase(sqlite);
  const kv = makeKV();
  const context = useRequestContext({ DB: failOn(makeD1(sqlite), matcher), KV: kv });
  const stub = stubDiscoveryFetch();
  try {
    await fn({ sqlite, kv, context, stub });
  } finally {
    await flush(context);
    stub.restore();
    context.restore();
    sqlite.close();
  }
}

const params = (id) => ({ params: Promise.resolve({ id }) });
const blocks = [{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'word '.repeat(30) }] }];

test('a publish committed before media failure still invalidates and announces the article', async () => {
  await withFailure(/UPDATE media_uploads SET blog_id/, async ({ sqlite, kv, context, stub }) => {
    await installSession('u-alice', { username: 'alice' });
    await loadPublicSitemapRows();
    await flush(context);
    const response = await publishWeb(request('/api/blogs/publish', {
      method: 'POST', body: { slugid: 'partial-publish', title: 'Partial Publish', status: 'published', editorContent: blocks },
    }));
    assert.equal(response.status, 500);
    assert.equal(sqlite.prepare("SELECT status FROM blogs WHERE id = 'partial-publish'").get().status, 'published');
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/partial-publish`]);
  });
});

test('a committed draft target move still announces old and new URLs after tag failure', async () => {
  await withFailure(/DELETE FROM blog_tags/, async ({ sqlite, kv, stub }) => {
    await installSession('u-alice', { username: 'alice' });
    const response = await saveDraft(request('/api/blogs/draft', {
      method: 'POST', body: { slugid: 'b-personal', title: 'Moved', publishAs: 'org:org-acme', editorContent: blocks, tags: ['new'] },
    }));
    assert.equal(response.status, 500);
    assert.equal(sqlite.prepare("SELECT published_as FROM blogs WHERE id = 'b-personal'").get().published_as, 'org:org-acme');
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`, `${SITE_URL}/acme/b-personal`]);
  });
});

test('partial org deletion announces collection-path moves while the org survives', async () => {
  await withFailure(/DELETE FROM orgs WHERE id/, async ({ sqlite, kv, stub }) => {
    await installSession('u-alice', { username: 'alice' });
    const response = await deleteOrg(request('/api/orgs', { method: 'DELETE', body: { orgId: 'org-acme' } }));
    assert.equal(response.status, 500);
    assert.ok(sqlite.prepare("SELECT id FROM orgs WHERE id = 'org-acme'").get());
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE org_id = 'org-acme'").get().n, 0);
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    assert.deepEqual(stub.indexNowUrls().sort(), [
      `${SITE_URL}/acme/b-org`, `${SITE_URL}/acme/b-org-plain`, `${SITE_URL}/acme/series/b-org`,
    ].sort());
  });
});

test('cron invalidates a committed transition even when its audit write fails', async () => {
  await withFailure(/INSERT INTO contest_audit_log/, async ({ sqlite, kv }) => {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'offline-review';
    try {
      const now = Math.floor(Date.now() / 1000);
      insertContest(sqlite, 'c-open-review', 'opening-review', {
        status: 'scheduled', starts_at: now - 5, submissions_close_at: now + 3600,
      });
      const response = await runCron(request('/api/cron/contests', { headers: { authorization: 'Bearer offline-review' } }));
      assert.equal(response.status, 500);
      assert.equal(sqlite.prepare("SELECT status FROM contests WHERE id = 'c-open-review'").get().status, 'live');
      assert.ok(kv.deletes.includes(SITEMAP_KEY));
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });
});

test('empty curated entry edits still invalidate the changed parent lastmod', async () => {
  await withFailure(/NEVER_MATCH/, async ({ sqlite, kv }) => {
    await installSession('u-carol', { username: 'carol' });
    sqlite.prepare("UPDATE bookmark_collections SET updated_at = 1 WHERE id = 'bc-public'").run();
    const response = await patchEntries(request('/api/library/collections/bc-public/entries', {
      method: 'PATCH', body: { order: [] },
    }), params('bc-public'));
    assert.equal(response.status, 200);
    assert.ok(sqlite.prepare("SELECT updated_at FROM bookmark_collections WHERE id = 'bc-public'").get().updated_at > 1);
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
  });
});

for (const action of ['publish', 'unpublish', 'restore']) {
  test(`v1 ${action} invalidates and notifies before a post-write response lookup fails`, async () => {
    await withFailure(/^SELECT \* FROM blogs WHERE id = \?$/, async ({ sqlite, kv, stub }) => {
      const id = action === 'publish' ? 'b-draft' : 'b-personal';
      const scope = action === 'restore' ? 'lixblogs:blog:delete' : 'lixblogs:blog:publish';
      if (action === 'restore') {
        sqlite.prepare("UPDATE blogs SET status = 'trashed', deleted_at = 100, pre_delete_status = 'published' WHERE id = ?").run(id);
      }
      const token = await bearerToken('u-alice', [scope]);
      const etag = await blogEntityTag(sqlite.prepare('SELECT * FROM blogs WHERE id = ?').get(id));
      const handler = { publish: publishV1, unpublish: unpublishV1, restore: restoreV1 }[action];
      const response = await handler(request(`/api/v1/blogs/${id}/${action}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'if-match': etag, 'idempotency-key': `review-${action}` },
        ...(action === 'publish' ? { body: { status: 'published' } } : {}),
      }), params(id));
      assert.equal(response.status, 500);
      assert.equal(sqlite.prepare('SELECT status FROM blogs WHERE id = ?').get(id).status, action === 'unpublish' ? 'draft' : 'published');
      assert.ok(kv.deletes.includes(SITEMAP_KEY));
      assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/${id}`]);
    });
  });
}

test('v1 article updates invalidate and notify committed content after tag failure', async () => {
  await withFailure(/DELETE FROM blog_tags/, async ({ sqlite, kv, stub }) => {
    const token = await bearerToken('u-alice', ['lixblogs:blog:write']);
    const etag = await blogEntityTag(sqlite.prepare("SELECT * FROM blogs WHERE id = 'b-personal'").get());
    const response = await patchV1(request('/api/v1/blogs/b-personal', {
      method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'if-match': etag },
      body: { title: 'Partial edit', tags: ['new'] },
    }), params('b-personal'));
    assert.equal(response.status, 500);
    assert.equal(sqlite.prepare("SELECT title FROM blogs WHERE id = 'b-personal'").get().title, 'Partial edit');
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`]);
  });
});
