import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { useRequestContext } from './support/d1.mjs';

register(new URL('./support/package3Loader.mjs', import.meta.url));

const { POST: publishWeb } = await import('../app/api/blogs/publish/route.js');
const { PATCH: manageBlog } = await import('../app/api/blogs/[slugid]/manage/route.js');
const { DELETE: deleteWebBlog } = await import('../app/api/blogs/[slugid]/route.js');
const { POST: reportBlog } = await import('../app/api/blogs/[slugid]/report/route.js');
const { POST: moderate } = await import('../app/api/moderation/action/route.js');
const { POST: publishV1 } = await import('../app/api/v1/blogs/[id]/publish/route.js');
const { POST: unpublishV1 } = await import('../app/api/v1/blogs/[id]/unpublish/route.js');
const { POST: restoreV1 } = await import('../app/api/v1/blogs/[id]/restore/route.js');
const { PATCH: patchV1, DELETE: deleteV1 } = await import('../app/api/v1/blogs/[id]/route.js');
const { blogEntityTag } = await import('../lib/api/v1/entityTag.js');
const { MODERATION_AUTOHIDE_THRESHOLD } = await import('../lib/limits.js');
const {
  SITE_URL, bearerToken, flush, insertBlog, installSession, makeD1, makeKV, makeSqlite, request, seedBase,
  stubDiscoveryFetch,
} = await import('./support/package3Fixture.mjs');

const blocks = (count = 25) => [{
  id: 'block-1',
  type: 'paragraph',
  content: [{ type: 'text', text: Array.from({ length: count }, (_, index) => `word${index}`).join(' ') }],
}];

function world() {
  const sqlite = makeSqlite();
  seedBase(sqlite);
  return { sqlite, db: makeD1(sqlite), kv: makeKV() };
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

function etagFor(sqlite, id) {
  return blogEntityTag(sqlite.prepare('SELECT * FROM blogs WHERE id = ?').get(id));
}

const params = (value) => ({ params: Promise.resolve(value) });

function bearer(scopes) {
  return bearerToken('u-alice', scopes);
}

test('web publishing a public article announces only its new URL', async () => {
  await withWorld(async ({ stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    const response = await publishWeb(request('/api/blogs/publish', {
      method: 'POST',
      body: { slugid: 'fresh-post', title: 'Fresh Post', status: 'published', editorContent: blocks() },
    }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/fresh-post`]);
    assert.deepEqual(stub.unexpected(), []);
  });
});

test('private-from-birth and secret publications are never announced', async () => {
  await withWorld(async ({ stub, context }) => {
    await installSession('u-bob', { username: 'bob' });
    const privateOrg = await publishWeb(request('/api/blogs/publish', {
      method: 'POST',
      body: {
        slugid: 'private-post', title: 'Private Post', status: 'published',
        publishAs: 'org:org-private', editorContent: blocks(),
      },
    }));
    assert.equal(privateOrg.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), []);

    await installSession('u-alice', { username: 'alice' });
    const secret = await publishWeb(request('/api/blogs/publish', {
      method: 'POST',
      body: { slugid: 'secret-post', title: 'Secret Post', status: 'published', secret: true, editorContent: blocks() },
    }));
    assert.equal(secret.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), []);
  });
});

test('unlisted publications are not announced', async () => {
  await withWorld(async ({ stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    const response = await publishWeb(request('/api/blogs/publish', {
      method: 'POST',
      body: { slugid: 'unlisted-post', title: 'Unlisted Post', status: 'unlisted', editorContent: blocks() },
    }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), []);
  });
});

test('an eligible web rename announces the old and the new URL in order', async () => {
  await withWorld(async ({ stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    const response = await publishWeb(request('/api/blogs/publish', {
      method: 'POST',
      body: {
        slugid: 'b-personal', title: 'Renamed', slug: 'renamed-post', status: 'published', editorContent: blocks(),
      },
    }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [
      `${SITE_URL}/alice/b-personal`,
      `${SITE_URL}/alice/renamed-post`,
    ]);
  });
});

test('unlisting a published article keeps its former URL as the removal notice', async () => {
  await withWorld(async ({ stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    const response = await manageBlog(request('/api/blogs/b-personal/manage', {
      method: 'PATCH', body: { action: 'unlist' },
    }), params({ slugid: 'b-personal' }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`]);
  });
});

test('deleting a public article announces removal; a private-org deletion announces nothing', async () => {
  await withWorld(async ({ stub, context }) => {
    await installSession('u-alice', { username: 'alice' });
    const response = await deleteWebBlog(request('/api/blogs/b-personal', { method: 'DELETE' }), params({ slugid: 'b-personal' }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`]);

    stub.calls.length = 0;
    await installSession('u-bob', { username: 'bob' });
    const privateDelete = await deleteWebBlog(request('/api/blogs/b-private', { method: 'DELETE' }), params({ slugid: 'b-private' }));
    assert.equal(privateDelete.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), []);
  });
});

test('the report threshold announces the formerly public URL', async () => {
  await withWorld(async ({ sqlite, stub, context }) => {
    for (let index = 0; index < MODERATION_AUTOHIDE_THRESHOLD - 1; index += 1) {
      const id = `u-reporter-${index}`;
      sqlite.prepare('INSERT INTO users (id, username, updated_at) VALUES (?, ?, 1)').run(id, `reporter${index}`);
      sqlite.prepare("INSERT INTO reports (id, blog_id, reporter_id, reason, status) VALUES (?, 'b-personal', ?, 'spam', 'open')")
        .run(`r-${index}`, id);
    }
    await installSession('u-bob', { username: 'bob' });
    const response = await reportBlog(request('/api/blogs/b-personal/report', {
      method: 'POST', body: { reason: 'spam' },
    }), params({ slugid: 'b-personal' }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.equal(sqlite.prepare("SELECT status FROM blogs WHERE id = 'b-personal'").get().status, 'under_review');
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`]);
  });
});

test('moderation dismiss announces the restored URL and takedown the removed one', async () => {
  await withWorld(async ({ sqlite, stub, context }) => {
    process.env.MODERATION_SECRET = 'package3-moderation-secret';
    sqlite.prepare("UPDATE blogs SET status = 'under_review' WHERE id = 'b-personal'").run();
    const dismiss = await moderate(request('/api/moderation/action', {
      method: 'POST', headers: { 'x-moderation-secret': 'package3-moderation-secret' },
      body: { action: 'dismiss', blogId: 'b-personal' },
    }));
    assert.equal(dismiss.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`]);

    stub.calls.length = 0;
    const takedown = await moderate(request('/api/moderation/action', {
      method: 'POST', headers: { 'x-moderation-secret': 'package3-moderation-secret' },
      body: { action: 'takedown', blogId: 'b-private' },
    }));
    assert.equal(takedown.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [], 'a private-org takedown was never public');
  });
});

test('a denied moderation call writes and announces nothing', async () => {
  await withWorld(async ({ stub, context }) => {
    const response = await moderate(request('/api/moderation/action', {
      method: 'POST', headers: { 'x-moderation-secret': 'wrong' },
      body: { action: 'takedown', blogId: 'b-personal' },
    }));
    assert.equal(response.status, 401);
    await flush(context);
    assert.equal(stub.calls.length, 0);
  });
});

test('a failing notification transport does not change the mutation response', async () => {
  await withWorld(async ({ stub }) => {
    await installSession('u-alice', { username: 'alice' });
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('transport down'); };
    try {
      const response = await publishWeb(request('/api/blogs/publish', {
        method: 'POST',
        body: { slugid: 'resilient-post', title: 'Resilient', status: 'published', editorContent: blocks() },
      }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(stub.unexpected(), []);
  });
});

test('v1 publishing a draft announces the new URL', async () => {
  await withWorld(async ({ sqlite, stub, context }) => {
    const token = await bearer(['lixblogs:blog:publish']);
    const response = await publishV1(request('/api/v1/blogs/b-draft/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'publish-draft-key', 'if-match': await etagFor(sqlite, 'b-draft') },
      body: { status: 'published' },
    }), params({ id: 'b-draft' }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-draft`]);
  });
});

test('v1 private-org and secret drafts are not announced', async () => {
  await withWorld(async ({ sqlite, stub, context }) => {
    insertBlog(sqlite, 'b-private-draft', {
      author_id: 'u-bob', published_as: 'org:org-private', status: 'draft',
    });
    const token = await bearerToken('u-bob', ['lixblogs:blog:publish']);
    const response = await publishV1(request('/api/v1/blogs/b-private-draft/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'publish-private-key', 'if-match': await etagFor(sqlite, 'b-private-draft') },
      body: { status: 'published' },
    }), params({ id: 'b-private-draft' }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), []);

    const secretToken = await bearerToken('u-alice', ['lixblogs:blog:publish']);
    sqlite.prepare("UPDATE blogs SET secret = 1 WHERE id = 'b-draft'").run();
    const secret = await publishV1(request('/api/v1/blogs/b-draft/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${secretToken}`, 'idempotency-key': 'publish-secret-key', 'if-match': await etagFor(sqlite, 'b-draft') },
      body: { status: 'published' },
    }), params({ id: 'b-draft' }));
    assert.equal(secret.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), []);
  });
});

test('v1 publishing an eligible post as unlisted announces only the old URL', async () => {
  await withWorld(async ({ sqlite, stub, context }) => {
    const token = await bearer(['lixblogs:blog:publish']);
    const response = await publishV1(request('/api/v1/blogs/b-personal/publish', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': 'publish-unlisted-key',
        'if-match': await etagFor(sqlite, 'b-personal'),
      },
      body: { status: 'unlisted' },
    }), params({ id: 'b-personal' }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`]);
  });
});

test('v1 unpublishing a public post announces removal; a secret post announces nothing', async () => {
  await withWorld(async ({ sqlite, stub, context }) => {
    const token = await bearer(['lixblogs:blog:publish']);
    const response = await unpublishV1(request('/api/v1/blogs/b-personal/unpublish', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'if-match': await etagFor(sqlite, 'b-personal') },
    }), params({ id: 'b-personal' }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`]);

    stub.calls.length = 0;
    const secret = await unpublishV1(request('/api/v1/blogs/b-secret/unpublish', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'if-match': await etagFor(sqlite, 'b-secret') },
    }), params({ id: 'b-secret' }));
    assert.equal(secret.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), []);
  });
});

test('v1 trash and permanent delete keep the former public URL only once', async () => {
  await withWorld(async ({ sqlite, stub, context }) => {
    const token = await bearer(['lixblogs:blog:delete', 'lixblogs:blog:delete:permanent']);
    const trash = await deleteV1(request('/api/v1/blogs/b-personal', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'if-match': await etagFor(sqlite, 'b-personal') },
    }), params({ id: 'b-personal' }));
    assert.equal(trash.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`]);

    stub.calls.length = 0;
    const permanent = await deleteV1(request('/api/v1/blogs/b-personal?permanent=true', {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${token}`,
        'x-confirm-permanent-delete': 'b-personal',
        'if-match': await etagFor(sqlite, 'b-personal'),
      },
    }), params({ id: 'b-personal' }));
    assert.equal(permanent.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [], 'a trashed article was already ineligible');
  });
});

test('v1 restore announces the URL of a restored published post', async () => {
  await withWorld(async ({ sqlite, stub, context }) => {
    const token = await bearer(['lixblogs:blog:delete']);
    await deleteV1(request('/api/v1/blogs/b-personal', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'if-match': await etagFor(sqlite, 'b-personal') },
    }), params({ id: 'b-personal' }));
    await flush(context);
    stub.calls.length = 0;

    const restored = await restoreV1(request('/api/v1/blogs/b-personal/restore', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'if-match': await etagFor(sqlite, 'b-personal') },
    }), params({ id: 'b-personal' }));
    assert.equal(restored.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [`${SITE_URL}/alice/b-personal`]);
  });
});

test('a v1 target change announces the old and the new canonical URL', async () => {
  await withWorld(async ({ sqlite, stub, context }) => {
    const token = await bearer(['lixblogs:blog:write']);
    const response = await patchV1(request('/api/v1/blogs/b-personal', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'if-match': await etagFor(sqlite, 'b-personal') },
      body: { publishedAs: 'org:org-acme' },
    }), params({ id: 'b-personal' }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.deepEqual(stub.indexNowUrls(), [
      `${SITE_URL}/alice/b-personal`,
      `${SITE_URL}/acme/b-personal`,
    ]);
  });
});
