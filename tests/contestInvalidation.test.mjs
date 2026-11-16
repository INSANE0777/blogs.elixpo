import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { useRequestContext } from './support/d1.mjs';

register(new URL('./support/package3Loader.mjs', import.meta.url));

const { PATCH: patchContest, DELETE: deleteContest } = await import('../app/api/contests/[slug]/route.js');
const { POST: postResults } = await import('../app/api/contests/[slug]/results/route.js');
const { PATCH: patchV1Contest } = await import('../app/api/v1/contests/[id]/route.js');
const { GET: runCron } = await import('../app/api/cron/contests/route.js');
const { loadPublicSitemapRows } = await import('../lib/sitemapData.js');
const {
  SITEMAP_KEY, bearerToken, flush, installSession, insertContest, makeD1, makeKV, makeSqlite, request, seedBase,
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

const params = (slug) => ({ params: Promise.resolve({ slug }) });

test('publishing a contest invalidates and adds its URL to the snapshot', async () => {
  await withWorld(async ({ sqlite, kv, context }) => {
    await installSession('u-alice', { username: 'alice' });
    sqlite.prepare("UPDATE contests SET problem_statement = 'p', rules = 'r' WHERE id = 'c-draft'").run();
    const primed = await fresh(context);
    assert.equal(primed.contests.some((row) => row.slug === 'draft-contest'), false);
    await fresh(context);

    const response = await patchContest(request('/api/contests/draft-contest', {
      method: 'PATCH', body: { action: 'publish' },
    }), params('draft-contest'));
    assert.equal(response.status, 200);
    await flush(context);

    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    const rows = await fresh(context);
    assert.ok(rows.contests.some((row) => row.slug === 'draft-contest'));
  });
});

test('editing a non-draft contest invalidates, editing a draft does not', async () => {
  await withWorld(async ({ kv, context }) => {
    await installSession('u-alice', { username: 'alice' });
    await fresh(context);

    const draft = await patchContest(request('/api/contests/draft-contest', {
      method: 'PATCH', body: { title: 'Draft rename' },
    }), params('draft-contest'));
    assert.equal(draft.status, 200);
    await flush(context);
    assert.equal(kv.deletes.includes(SITEMAP_KEY), false);

    const live = await patchContest(request('/api/contests/live-contest', {
      method: 'PATCH', body: { title: 'Live rename' },
    }), params('live-contest'));
    assert.equal(live.status, 200);
    await flush(context);
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
  });
});

test('cancelling a public contest and deleting a draft invalidate only the public change', async () => {
  await withWorld(async ({ kv, context }) => {
    await installSession('u-alice', { username: 'alice' });
    await fresh(context);

    const deleted = await deleteContest(request('/api/contests/draft-contest', { method: 'DELETE' }), params('draft-contest'));
    assert.equal(deleted.status, 200);
    await flush(context);
    assert.equal(kv.deletes.includes(SITEMAP_KEY), false);

    const cancelled = await patchContest(request('/api/contests/live-contest', {
      method: 'PATCH', body: { action: 'cancel' },
    }), params('live-contest'));
    assert.equal(cancelled.status, 200);
    await flush(context);
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
  });
});

test('finalizing results invalidates the completed contest snapshot', async () => {
  await withWorld(async ({ sqlite, kv, context }) => {
    await installSession('u-alice', { username: 'alice' });
    insertContest(sqlite, 'c-judging', 'judging-contest', { status: 'judging' });
    sqlite.prepare(`
      INSERT INTO contest_submissions (id, contest_id, blog_id, author_id, withdrawn_at, created_at)
      VALUES ('s1', 'c-judging', 'b-personal', 'u-alice', NULL, 100)
    `).run();
    await fresh(context);

    const response = await postResults(request('/api/contests/judging-contest/results', {
      method: 'POST', body: { awards: [{ placement: 'winner', submissionId: 's1' }], finalize: true },
    }), params('judging-contest'));
    assert.equal(response.status, 200);
    await flush(context);

    assert.ok(kv.deletes.includes(SITEMAP_KEY));
    assert.equal(sqlite.prepare("SELECT status FROM contests WHERE id = 'c-judging'").get().status, 'completed');
  });
});

test('the v1 contest publish route invalidates the snapshot', async () => {
  await withWorld(async ({ sqlite, kv, context }) => {
    const token = await bearerToken('u-alice', ['lixblogs:blog:write']);
    sqlite.prepare("UPDATE contests SET problem_statement = 'p', rules = 'r' WHERE id = 'c-draft'").run();
    await fresh(context);

    const response = await patchV1Contest(request('/api/v1/contests/c-draft', {
      method: 'PATCH', headers: { authorization: `Bearer ${token}` }, body: { action: 'publish' },
    }), { params: Promise.resolve({ id: 'c-draft' }) });
    assert.equal(response.status, 200);
    await flush(context);
    assert.ok(kv.deletes.includes(SITEMAP_KEY));
  });
});

test('cron contest transitions invalidate once; a quiet run does not', async () => {
  await withWorld(async ({ sqlite, kv, context }) => {
    process.env.CRON_SECRET = 'package3-cron-secret';
    const now = Math.floor(Date.now() / 1000);
    insertContest(sqlite, 'c-open', 'opening-contest', {
      status: 'scheduled', starts_at: now - 10, submissions_close_at: now + 3600, judging_closes_at: now + 7200,
    });
    insertContest(sqlite, 'c-close', 'closing-contest', { status: 'live', submissions_close_at: now - 10 });
    await fresh(context);

    const response = await runCron(request('/api/cron/contests', {
      headers: { authorization: 'Bearer package3-cron-secret' },
    }));
    assert.equal(response.status, 200);
    await flush(context);
    assert.equal(kv.deletes.filter((key) => key === SITEMAP_KEY).length, 1);
    assert.equal(sqlite.prepare("SELECT status FROM contests WHERE id = 'c-open'").get().status, 'live');
    assert.equal(sqlite.prepare("SELECT status FROM contests WHERE id = 'c-close'").get().status, 'judging');

    kv.deletes.length = 0;
    const quiet = await runCron(request('/api/cron/contests', {
      headers: { authorization: 'Bearer package3-cron-secret' },
    }));
    assert.equal(quiet.status, 200);
    await flush(context);
    assert.equal(kv.deletes.filter((key) => key === SITEMAP_KEY).length, 0);
  });
});
