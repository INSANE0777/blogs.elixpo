import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseArgs } from '../scripts/audit-seo.mjs';

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const SECRET_MARKER = 'SYNTHETIC_SECRET_MARKER_DO_NOT_ECHO';

const credentialJson = JSON.stringify({
  type: 'service_account',
  client_email: 'seo-audit@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----\n',
  client_secret: SECRET_MARKER,
});

const servers = new Set();
after(() => {
  for (const server of servers) server.close();
});

function collector() {
  let text = '';
  return {
    write(chunk) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

test('an unexpected optional inspection error still writes a technically passing report', async (t) => {
  const { fixture } = await healthyFixture();
  t.after(() => fixture.close());
  const temp = await mkdtemp(join(tmpdir(), 'seo-inspect-cli-fallback-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const jsonPath = join(temp, 'report.json');
  const markdownPath = join(temp, 'report.md');
  const stdout = collector();
  const stderr = collector();
  const code = await main([
    '--sitemap', `${fixture.base}/sitemap.xml`, '--inspect',
    '--json', jsonPath, '--markdown', markdownPath,
  ], {
    stdout, stderr,
    env: new Proxy({}, { get() { throw new Error(SECRET_MARKER); } }),
  });
  assert.equal(code, 0);
  const report = JSON.parse(await readFile(jsonPath, 'utf8'));
  const markdown = await readFile(markdownPath, 'utf8');
  assert.equal(report.technicalStatus, 'passed');
  assert.equal(report.inspection.status, 'unavailable');
  assert.equal(report.inspection.code, 'INSPECTION_FAILED');
  assert.match(markdown, /Google inspection: unavailable/);
  for (const output of [stdout.text, stderr.text, JSON.stringify(report), markdown]) {
    assert.ok(!output.includes(SECRET_MARKER));
  }
});

async function startFixtureServer() {
  const routes = new Map();
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const route = routes.get(request.url);
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': route.type });
    response.end(route.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.add(server);
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    routes,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const sitemapXml = (base, paths) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="${SITEMAP_NS}">` +
  paths.map((path) => `<url><loc>${base}${path}</loc></url>`).join('') +
  `</urlset>`;

const healthyDocument = (url) =>
  `<!doctype html><html><head>` +
  `<link rel="canonical" href="${url}">` +
  `<script type="application/ld+json">${JSON.stringify({ '@type': 'BlogPosting', url })}</script>` +
  `</head><body><article>Healthy</article></body></html>`;

const collisionDocument = () =>
  '<!doctype html><html><head><meta name="robots" content="noindex"></head><body></body></html>';

async function healthyFixture() {
  const fixture = await startFixtureServer();
  const healthy = `${fixture.base}/@writer/healthy`;
  fixture.routes.set('/sitemap.xml', {
    type: 'application/xml',
    body: sitemapXml(fixture.base, ['/@writer/healthy']),
  });
  fixture.routes.set('/robots.txt', { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' });
  fixture.routes.set('/@writer/healthy', { type: 'text/html', body: healthyDocument(healthy) });
  return { fixture, healthy };
}

async function failingFixture() {
  const fixture = await startFixtureServer();
  const healthy = `${fixture.base}/@writer/healthy`;
  const collision = `${fixture.base}/@writer/namespace-collision-543`;
  fixture.routes.set('/sitemap.xml', {
    type: 'application/xml',
    body: sitemapXml(fixture.base, ['/@writer/healthy', '/@writer/namespace-collision-543']),
  });
  fixture.routes.set('/robots.txt', { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' });
  fixture.routes.set('/@writer/healthy', { type: 'text/html', body: healthyDocument(healthy) });
  fixture.routes.set('/@writer/namespace-collision-543', {
    type: 'text/html',
    body: collisionDocument(),
  });
  return { fixture, healthy, collision };
}

const inspectionResponse = (fields = {}) =>
  new Response(
    JSON.stringify({
      inspectionResult: {
        indexStatusResult: {
          verdict: 'PASS',
          robotsTxtState: 'ALLOWED',
          indexingState: 'INDEXING_ALLOWED',
          pageFetchState: 'SUCCESSFUL',
          ...fields,
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function inspectionFetch(factory = () => inspectionResponse()) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return factory(calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const tokenProvider = (token = 'synthetic-access-token') => {
  const calls = [];
  const provider = async (options) => {
    calls.push(options);
    return token;
  };
  provider.calls = calls;
  return provider;
};

test('--inspect parses as a boolean and is rejected when repeated', () => {
  assert.equal(
    parseArgs(['--sitemap', 'https://example.com/blog-sitemap.xml', '--inspect']).inspect,
    true,
  );
  assert.equal(parseArgs(['--sitemap', 'https://example.com/blog-sitemap.xml']).inspect, false);
  assert.throws(() =>
    parseArgs(['--sitemap', 'https://example.com/blog-sitemap.xml', '--inspect', '--inspect']),
  );
  assert.throws(() =>
    parseArgs(['--sitemap', 'https://example.com/blog-sitemap.xml', '--inspect=true']),
  );
  assert.equal(parseArgs(['--help', '--inspect']).help, true);
});

test('a default CLI run ignores inspection credentials and never reads the environment', async (t) => {
  const { fixture } = await healthyFixture();
  t.after(() => fixture.close());
  const temp = await mkdtemp(join(tmpdir(), 'seo-inspect-cli-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const jsonPath = join(temp, 'report.json');
  const markdownPath = join(temp, 'report.md');
  const stdout = collector();
  const stderr = collector();
  const env = new Proxy(
    {},
    {
      get() {
        throw new Error('environment must not be read when inspection is not requested');
      },
    },
  );
  const provider = tokenProvider();

  const code = await main(
    ['--sitemap', `${fixture.base}/sitemap.xml`, '--json', jsonPath, '--markdown', markdownPath],
    { stdout, stderr, env, inspectionAdapters: { tokenProvider: provider } },
  );

  assert.equal(code, 0);
  assert.equal(provider.calls.length, 0);
  const report = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.deepEqual(report.inspection, { status: 'skipped', reason: 'inspection not requested' });
  assert.equal(report.technicalStatus, 'passed');
  assert.match(stdout.text, /Google inspection: skipped — inspection not requested/);
  assert.equal(stderr.text, '');
});

test('--inspect without a secret skips before reading the property', async (t) => {
  const { fixture } = await healthyFixture();
  t.after(() => fixture.close());
  const temp = await mkdtemp(join(tmpdir(), 'seo-inspect-cli-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const jsonPath = join(temp, 'report.json');
  const stdout = collector();
  const stderr = collector();
  const env = {};
  Object.defineProperty(env, 'SEO_SEARCH_CONSOLE_PROPERTY', {
    get() {
      throw new Error('property must not be read without a secret');
    },
  });
  const provider = tokenProvider();

  const code = await main([ '--sitemap', `${fixture.base}/sitemap.xml`, '--inspect', '--json', jsonPath], {
    stdout,
    stderr,
    env,
    inspectionAdapters: { tokenProvider: provider },
  });

  assert.equal(code, 0);
  assert.equal(provider.calls.length, 0);
  const report = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.deepEqual(report.inspection, { status: 'skipped', reason: 'credentials not configured' });
  assert.equal(report.technicalStatus, 'passed');
  assert.equal(stderr.text, '');
});

test('a nonblank secret with an invalid property is a separate exit 2 that keeps the technical report', async (t) => {
  const { fixture } = await healthyFixture();
  t.after(() => fixture.close());
  const temp = await mkdtemp(join(tmpdir(), 'seo-inspect-cli-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const jsonPath = join(temp, 'report.json');
  const markdownPath = join(temp, 'report.md');
  const stdout = collector();
  const stderr = collector();
  const provider = tokenProvider();

  const code = await main(
    [
      '--sitemap',
      `${fixture.base}/sitemap.xml`,
      '--inspect',
      '--json',
      jsonPath,
      '--markdown',
      markdownPath,
    ],
    {
      stdout,
      stderr,
      env: {
        SEO_SEARCH_CONSOLE_CREDENTIALS: credentialJson,
        SEO_SEARCH_CONSOLE_PROPERTY: 'not a property',
      },
      inspectionAdapters: { tokenProvider: provider },
    },
  );

  assert.equal(code, 2);
  assert.equal(provider.calls.length, 0);
  const report = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.equal(report.technicalStatus, 'passed');
  assert.equal(report.inspection.status, 'invalid-configuration');
  assert.equal(report.inspection.code, 'INVALID_PROPERTY');
  const markdown = await readFile(markdownPath, 'utf8');
  assert.match(markdown, /Technical status: \*\*passed\*\*/);
  assert.match(markdown, /Google inspection: \*\*invalid configuration\*\*/);
  for (const output of [stdout.text, stderr.text, markdown, JSON.stringify(report)]) {
    assert.ok(!output.includes(SECRET_MARKER));
  }
});

test('a complete configuration renders separate inspection results without changing the technical exit', async (t) => {
  const { fixture, healthy } = await healthyFixture();
  t.after(() => fixture.close());
  const temp = await mkdtemp(join(tmpdir(), 'seo-inspect-cli-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const jsonPath = join(temp, 'report.json');
  const markdownPath = join(temp, 'report.md');
  const stdout = collector();
  const stderr = collector();
  const inspection = inspectionFetch();
  const provider = tokenProvider('synthetic-access-token');

  const code = await main(
    [
      '--sitemap',
      `${fixture.base}/sitemap.xml`,
      '--inspect',
      '--json',
      jsonPath,
      '--markdown',
      markdownPath,
    ],
    {
      stdout,
      stderr,
      env: {
        SEO_SEARCH_CONSOLE_CREDENTIALS: credentialJson,
        SEO_SEARCH_CONSOLE_PROPERTY: `${fixture.base}/`,
      },
      inspectionAdapters: { tokenProvider: provider, fetchImpl: inspection, wait: async () => {} },
    },
  );

  assert.equal(code, 0);
  assert.equal(provider.calls.length, 1);
  assert.equal(inspection.calls.length, 1);
  assert.equal(inspection.calls[0].init.headers.authorization, 'Bearer synthetic-access-token');
  const report = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.equal(report.technicalStatus, 'passed');
  assert.equal(report.inspection.status, 'completed');
  assert.deepEqual(report.inspection.results, [
    {
      url: healthy,
      status: 'inspected',
      verdict: 'PASS',
      robotsTxtState: 'ALLOWED',
      indexingState: 'INDEXING_ALLOWED',
      pageFetchState: 'SUCCESSFUL',
    },
  ]);
  const markdown = await readFile(markdownPath, 'utf8');
  assert.match(markdown, /## Google URL inspection/);
  assert.match(markdown, /— PASS/);
  assert.match(markdown, /not a live page test/);
  for (const output of [stdout.text, stderr.text, markdown, JSON.stringify(report)]) {
    assert.ok(!output.includes(SECRET_MARKER));
  }
});

test('Google unavailability never changes a technically clean exit', async (t) => {
  const { fixture } = await healthyFixture();
  t.after(() => fixture.close());
  const temp = await mkdtemp(join(tmpdir(), 'seo-inspect-cli-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const jsonPath = join(temp, 'report.json');
  const stdout = collector();
  const stderr = collector();

  const code = await main(
    ['--sitemap', `${fixture.base}/sitemap.xml`, '--inspect', '--json', jsonPath],
    {
      stdout,
      stderr,
      env: {
        SEO_SEARCH_CONSOLE_CREDENTIALS: credentialJson,
        SEO_SEARCH_CONSOLE_PROPERTY: `${fixture.base}/`,
      },
      inspectionAdapters: {
        tokenProvider: tokenProvider(),
        fetchImpl: inspectionFetch(() =>
          new Response(JSON.stringify({ error: 'quota' }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      },
    },
  );

  assert.equal(code, 0);
  const report = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.equal(report.technicalStatus, 'passed');
  assert.equal(report.inspection.status, 'unavailable');
  assert.equal(report.inspection.code, 'RATE_LIMITED');
  assert.match(stdout.text, /Google inspection: unavailable/);
  assert.match(stdout.text, /Technical status: \*\*passed\*\*/);
  assert.equal(stderr.text, '');
});

test('a Google PASS never repairs a failed technical audit', async (t) => {
  const { fixture, collision } = await failingFixture();
  t.after(() => fixture.close());
  const temp = await mkdtemp(join(tmpdir(), 'seo-inspect-cli-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const jsonPath = join(temp, 'report.json');
  const stdout = collector();
  const stderr = collector();
  const inspection = inspectionFetch();

  const code = await main(
    ['--sitemap', `${fixture.base}/sitemap.xml`, '--inspect', '--json', jsonPath],
    {
      stdout,
      stderr,
      env: {
        SEO_SEARCH_CONSOLE_CREDENTIALS: credentialJson,
        SEO_SEARCH_CONSOLE_PROPERTY: `${fixture.base}/`,
      },
      inspectionAdapters: {
        tokenProvider: tokenProvider(),
        fetchImpl: inspection,
        wait: async () => {},
      },
    },
  );

  assert.equal(code, 1);
  const report = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.equal(report.technicalStatus, 'failed');
  assert.equal(report.results[1].url, collision);
  assert.ok(report.results[1].issues.length > 0);
  assert.equal(report.inspection.status, 'completed');
  assert.ok(report.inspection.results.every((result) => result.verdict === 'PASS'));
  assert.match(stdout.text, /Technical status: \*\*failed\*\*/);
});

test('authentication and provider bodies never leak into any CLI output', async (t) => {
  const { fixture } = await healthyFixture();
  t.after(() => fixture.close());
  const temp = await mkdtemp(join(tmpdir(), 'seo-inspect-cli-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const jsonPath = join(temp, 'report.json');
  const markdownPath = join(temp, 'report.md');
  const stdout = collector();
  const stderr = collector();

  const code = await main(
    [
      '--sitemap',
      `${fixture.base}/sitemap.xml`,
      '--inspect',
      '--json',
      jsonPath,
      '--markdown',
      markdownPath,
    ],
    {
      stdout,
      stderr,
      env: {
        SEO_SEARCH_CONSOLE_CREDENTIALS: credentialJson,
        SEO_SEARCH_CONSOLE_PROPERTY: `${fixture.base}/`,
      },
      inspectionAdapters: {
        tokenProvider: async () => {
          throw new Error(`refused ${SECRET_MARKER}`);
        },
      },
    },
  );

  assert.equal(code, 0);
  const report = JSON.parse(await readFile(jsonPath, 'utf8'));
  const markdown = await readFile(markdownPath, 'utf8');
  assert.equal(report.inspection.code, 'AUTH_FAILED');
  for (const output of [stdout.text, stderr.text, markdown, JSON.stringify(report)]) {
    assert.ok(!output.includes(SECRET_MARKER));
  }
});
