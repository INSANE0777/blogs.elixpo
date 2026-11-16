import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSample } from '../scripts/seo/inspection.mjs';

const SECRET_MARKER = 'SYNTHETIC_SECRET_MARKER_DO_NOT_ECHO';

const credentialJson = (overrides = {}) =>
  JSON.stringify({
    type: 'service_account',
    client_email: 'seo-audit@example.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----\n',
    ...overrides,
  });

const envFor = ({ credential, property } = {}) => {
  const env = {};
  if (credential !== undefined) env.SEO_SEARCH_CONSOLE_CREDENTIALS = credential;
  if (property !== undefined) env.SEO_SEARCH_CONSOLE_PROPERTY = property;
  return env;
};

const statusResult = (fields = {}) => ({
  inspectionResult: {
    indexStatusResult: {
      verdict: 'PASS',
      robotsTxtState: 'ALLOWED',
      indexingState: 'INDEXING_ALLOWED',
      pageFetchState: 'SUCCESSFUL',
      lastCrawlTime: '2026-11-01T10:00:00.123456789Z',
      ...fields,
    },
  },
});

const jsonResponse = (body, { status = 200, type = 'application/json' } = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': type },
  });

function captureFetch(factory) {
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
  const provider = async (args) => {
    calls.push(args);
    return token;
  };
  provider.calls = calls;
  return provider;
};

test('nonfatal provider failures report unavailable or partial rather than completed', async () => {
  for (const partial of [false, true]) {
    const urls = partial ? ['https://example.com/blog/a', 'https://example.com/blog/b'] : ['https://example.com/blog/a'];
    const result = await inspectSample({
      urls, requested: true,
      env: envFor({ credential: credentialJson(), property: 'https://example.com/blog/' }),
      tokenProvider: tokenProvider(),
      fetchImpl: captureFetch((count) => partial && count === 1
        ? jsonResponse(statusResult()) : jsonResponse({ error: SECRET_MARKER }, { status: 500 })),
      wait: async () => {},
    });
    assert.equal(result.status, partial ? 'partial' : 'unavailable');
    assert.equal(result.results.at(-1).code, 'HTTP_STATUS');
    assert.deepEqual(result.notInspected, []);
    assert.ok(!JSON.stringify(result).includes(SECRET_MARKER));
  }
});

test('an empty index status object is unavailable rather than a usable inspection', async () => {
  const result = await inspectSample({
    urls: ['https://example.com/blog/a'], requested: true,
    env: envFor({ credential: credentialJson(), property: 'https://example.com/blog/' }),
    tokenProvider: tokenProvider(),
    fetchImpl: captureFetch(() => jsonResponse({ inspectionResult: { indexStatusResult: {} } })),
  });
  assert.equal(result.results[0].status, 'failed');
  assert.equal(result.results[0].code, 'INVALID_RESPONSE');
  assert.equal(result.status, 'unavailable');
});

test('a default run skips without reading any optional environment value', async () => {
  const env = new Proxy(
    {},
    {
      get() {
        throw new Error('environment must not be read');
      },
    },
  );
  const provider = tokenProvider();
  const result = await inspectSample({ urls: ['https://example.com/a/'], requested: false, env, tokenProvider: provider });
  assert.deepEqual(result, { status: 'skipped', reason: 'inspection not requested' });
  assert.equal(provider.calls.length, 0);
});

test('property-only configuration never turns an unconfigured audit into an error', async () => {
  const result = await inspectSample({
    urls: ['https://example.com/a/'],
    requested: false,
    env: envFor({ property: 'sc-domain:example.com' }),
    tokenProvider: tokenProvider(),
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'inspection not requested');
});

test('absent, blank and whitespace-only secrets skip before the property is read', async () => {
  for (const credential of [undefined, '', '   ', '\n\t ']) {
    const env = envFor({ credential });
    Object.defineProperty(env, 'SEO_SEARCH_CONSOLE_PROPERTY', {
      get() {
        throw new Error('property must not be read without a secret');
      },
    });
    const provider = tokenProvider();
    const result = await inspectSample({
      urls: ['https://example.com/a/'],
      requested: true,
      env,
      tokenProvider: provider,
    });
    assert.deepEqual(result, { status: 'skipped', reason: 'credentials not configured' });
    assert.equal(provider.calls.length, 0);
  }
});

test('valid configuration without sampled URLs skips without authentication', async () => {
  const provider = tokenProvider();
  const fetchImpl = captureFetch(() => jsonResponse(statusResult()));
  const result = await inspectSample({
    urls: [],
    requested: true,
    env: envFor({ credential: credentialJson(), property: 'sc-domain:example.com' }),
    tokenProvider: provider,
    fetchImpl,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no sampled URLs');
  assert.equal(provider.calls.length, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('credential shapes other than a minimal service account are rejected generically', async () => {
  for (const credential of [
    'not json ' + SECRET_MARKER,
    JSON.stringify({ type: 'authorized_user', client_email: 'a@example.com', private_key: 'k' }),
    credentialJson({ client_email: '' }),
    credentialJson({ private_key: '   ' }),
    credentialJson({ client_email: 42 }),
    '[]',
  ]) {
    const provider = tokenProvider();
    const result = await inspectSample({
      urls: ['https://example.com/a/'],
      requested: true,
      env: envFor({ credential, property: 'sc-domain:example.com' }),
      tokenProvider: provider,
    });
    assert.equal(result.status, 'invalid-configuration');
    assert.equal(result.code, 'INVALID_CREDENTIALS');
    assert.equal(provider.calls.length, 0);
    assert.ok(!JSON.stringify(result).includes(SECRET_MARKER));
  }
});

test('only explicit credential fields reach the token provider', async () => {
  const provider = tokenProvider();
  const result = await inspectSample({
    urls: ['https://example.com/a/'],
    requested: true,
    env: envFor({
      credential: JSON.stringify({
        type: 'service_account',
        client_email: 'seo-audit@example.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----\n',
        token_uri: 'https://attacker.example/token',
        universe_domain: 'attacker.example',
        subject: 'admin@example.com',
        client_secret: SECRET_MARKER,
      }),
      property: 'sc-domain:example.com',
    }),
    tokenProvider: provider,
    fetchImpl: captureFetch(() => jsonResponse(statusResult())),
  });
  assert.equal(result.status, 'completed');
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(Object.keys(provider.calls[0]).sort(), ['email', 'key', 'timeoutMs']);
  assert.equal(provider.calls[0].email, 'seo-audit@example.iam.gserviceaccount.com');
  assert.ok(!JSON.stringify(provider.calls[0]).includes('attacker.example'));
  assert.ok(!JSON.stringify(result).includes(SECRET_MARKER));
});

test('property forms are validated before any authentication', async () => {
  for (const property of [
    undefined,
    '',
    '   ',
    'example.com',
    'sc-domain:',
    'sc-domain:bad_domain',
    'http://example.com/blog',
    'https://example.com/blog',
    'https://example.com/blog/?q=1',
    'https://example.com/blog/#top',
    'https://user:pass@example.com/blog/',
  ]) {
    const provider = tokenProvider();
    const env = envFor({ credential: credentialJson() });
    if (property !== undefined) env.SEO_SEARCH_CONSOLE_PROPERTY = property;
    const result = await inspectSample({
      urls: ['https://example.com/blog/a'],
      requested: true,
      env,
      tokenProvider: provider,
    });
    assert.equal(result.status, 'invalid-configuration', `property: ${String(property)}`);
    assert.equal(result.code, 'INVALID_PROPERTY');
    assert.equal(provider.calls.length, 0);
  }
});

test('domain properties use label boundaries', async () => {
  const provider = tokenProvider();
  const result = await inspectSample({
    urls: ['https://example.com/a/', 'https://notes.example.com/b/'],
    requested: true,
    env: envFor({ credential: credentialJson(), property: 'sc-domain:example.com' }),
    tokenProvider: provider,
    fetchImpl: captureFetch(() => jsonResponse(statusResult())),
    wait: async () => {},
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.results.length, 2);

  for (const url of ['https://evil-example.com/a/', 'https://example.com.evil/a/']) {
    const outside = await inspectSample({
      urls: [url],
      requested: true,
      env: envFor({ credential: credentialJson(), property: 'sc-domain:example.com' }),
      tokenProvider: tokenProvider(),
      fetchImpl: captureFetch(() => jsonResponse(statusResult())),
    });
    assert.equal(outside.status, 'invalid-configuration');
    assert.equal(outside.code, 'URL_OUTSIDE_PROPERTY');
  }
});

test('URL-prefix properties use origin and path boundaries', async () => {
  const base = {
    requested: true,
    env: envFor({ credential: credentialJson(), property: 'https://example.com/blog/' }),
    tokenProvider: tokenProvider(),
  };
  const inside = await inspectSample({
    ...base,
    urls: ['https://example.com/blog/post', 'https://example.com/blog/'],
    fetchImpl: captureFetch(() => jsonResponse(statusResult())),
    wait: async () => {},
  });
  assert.equal(inside.status, 'completed');

  for (const url of [
    'https://example.com/blogger/post',
    'https://example.com/Blog/post',
    'http://example.com/blog/post',
    'https://example.com:8443/blog/post',
    'https://other.example/blog/post',
  ]) {
    const outside = await inspectSample({
      ...base,
      urls: [url],
      fetchImpl: captureFetch(() => jsonResponse(statusResult())),
    });
    assert.equal(outside.status, 'invalid-configuration', `url: ${url}`);
    assert.equal(outside.code, 'URL_OUTSIDE_PROPERTY');
  }
});

test('successful inspection sends only the fixed endpoint and a readonly bearer token', async () => {
  const fetchImpl = captureFetch(() =>
    jsonResponse(
      statusResult({
        coverageState: 'Submitted and indexed',
        inspectionResultLink: 'https://search.google.com/search-console/inspect?x=1',
        googleCanonical: 'https://example.com/a/',
      }),
    ),
  );
  const provider = tokenProvider('synthetic-access-token');
  const result = await inspectSample({
    urls: ['https://example.com/blog/a'],
    requested: true,
    env: envFor({ credential: credentialJson(), property: 'https://example.com/blog/' }),
    tokenProvider: provider,
    fetchImpl,
    wait: async () => {},
  });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers.authorization, 'Bearer synthetic-access-token');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), {
    inspectionUrl: 'https://example.com/blog/a',
    siteUrl: 'https://example.com/blog/',
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.property, 'https://example.com/blog/');
  assert.deepEqual(result.results, [
    {
      url: 'https://example.com/blog/a',
      status: 'inspected',
      verdict: 'PASS',
      robotsTxtState: 'ALLOWED',
      indexingState: 'INDEXING_ALLOWED',
      pageFetchState: 'SUCCESSFUL',
      lastCrawlTime: '2026-11-01T10:00:00.123Z',
    },
  ]);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('Submitted and indexed'));
  assert.ok(!serialized.includes('inspectionResultLink'));
  assert.ok(!serialized.includes('googleCanonical'));
});

test('unknown enum values and malformed crawl times fall back to static values', async () => {
  const result = await inspectSample({
    urls: ['https://example.com/blog/a'],
    requested: true,
    env: envFor({ credential: credentialJson(), property: 'https://example.com/blog/' }),
    tokenProvider: tokenProvider(),
    fetchImpl: captureFetch(() =>
      jsonResponse(
        statusResult({
          verdict: 'SOMETHING_NEW',
          robotsTxtState: 'UNEXPECTED',
          indexingState: 'UNEXPECTED',
          pageFetchState: 'UNEXPECTED',
          lastCrawlTime: 'not-a-date',
        }),
      ),
    ),
  });
  assert.deepEqual(result.results[0], {
    url: 'https://example.com/blog/a',
    status: 'inspected',
    verdict: 'UNKNOWN',
    robotsTxtState: 'UNKNOWN',
    indexingState: 'UNKNOWN',
    pageFetchState: 'UNKNOWN',
  });
});

test('responses without an index status result are optional failures, not technical failures', async () => {
  const result = await inspectSample({
    urls: ['https://example.com/blog/a'],
    requested: true,
    env: envFor({ credential: credentialJson(), property: 'https://example.com/blog/' }),
    tokenProvider: tokenProvider(),
    fetchImpl: captureFetch(() => jsonResponse({ inspectionResult: {} })),
  });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.results, [
    { url: 'https://example.com/blog/a', status: 'failed', code: 'INVALID_RESPONSE' },
  ]);
});

test('requests are sequential, rate limited and stop cleanly on quota denial', async () => {
  const urls = ['https://example.com/blog/a', 'https://example.com/blog/b', 'https://example.com/blog/c'];
  const waits = [];
  let calls = 0;
  const fetchImpl = captureFetch(() => {
    calls += 1;
    if (calls === 2) return jsonResponse({ error: 'quota' }, { status: 429 });
    return jsonResponse(statusResult());
  });
  const result = await inspectSample({
    urls,
    requested: true,
    env: envFor({ credential: credentialJson(), property: 'https://example.com/blog/' }),
    tokenProvider: tokenProvider(),
    fetchImpl,
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(fetchImpl.calls.map((call) => JSON.parse(call.init.body).inspectionUrl), urls.slice(0, 2));
  assert.equal(result.status, 'partial');
  assert.equal(result.code, 'RATE_LIMITED');
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[1], { url: urls[1], status: 'failed', code: 'RATE_LIMITED' });
  assert.deepEqual(result.notInspected, [urls[2]]);
});

test('authorization denial stops before further inspections', async () => {
  const urls = ['https://example.com/blog/a', 'https://example.com/blog/b'];
  const fetchImpl = captureFetch(() => jsonResponse({ error: 'denied' }, { status: 401 }));
  const result = await inspectSample({
    urls,
    requested: true,
    env: envFor({ credential: credentialJson(), property: 'https://example.com/blog/' }),
    tokenProvider: tokenProvider(),
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'UNAUTHORIZED');
  assert.deepEqual(result.results, [{ url: urls[0], status: 'failed', code: 'UNAUTHORIZED' }]);
  assert.deepEqual(result.notInspected, [urls[1]]);
});

test('authentication errors never echo provider text', async () => {
  const provider = async () => {
    throw new Error(`token failed ${SECRET_MARKER}`);
  };
  const result = await inspectSample({
    urls: ['https://example.com/blog/a'],
    requested: true,
    env: envFor({ credential: credentialJson(), property: 'https://example.com/blog/' }),
    tokenProvider: provider,
    fetchImpl: captureFetch(() => jsonResponse(statusResult())),
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'AUTH_FAILED');
  assert.deepEqual(result.notInspected, ['https://example.com/blog/a']);
  assert.ok(!JSON.stringify(result).includes(SECRET_MARKER));
});

test('redirects, oversized bodies, non-JSON and raw errors stay sanitized', async () => {
  const cases = [
    {
      response: new Response('', { status: 302, headers: { location: 'https://attacker.example/' } }),
      code: 'REDIRECT',
    },
    {
      response: jsonResponse({ padding: 'x'.repeat(2048) }),
      code: 'TOO_LARGE',
      options: { maxBytes: 256 },
    },
    {
      response: new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      code: 'INVALID_RESPONSE',
    },
    {
      response: jsonResponse('{not json ' + SECRET_MARKER),
      code: 'INVALID_RESPONSE',
    },
    {
      response: jsonResponse({ error: SECRET_MARKER }, { status: 500 }),
      code: 'HTTP_STATUS',
    },
  ];

  for (const { response, code, options = {} } of cases) {
    const result = await inspectSample({
      urls: ['https://example.com/blog/a'],
      requested: true,
      env: envFor({ credential: credentialJson(), property: 'https://example.com/blog/' }),
      tokenProvider: tokenProvider(),
      fetchImpl: captureFetch(() => response.clone()),
      ...options,
    });
    assert.equal(result.results[0].code, code, `expected ${code}`);
    assert.ok(!JSON.stringify(result).includes(SECRET_MARKER));
  }
});

test('the request deadline aborts the actual request instead of racing a promise', async () => {
  let aborted = false;
  const fetchImpl = async (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
        { once: true },
      );
    });
  const started = Date.now();
  const result = await inspectSample({
    urls: ['https://example.com/blog/a'],
    requested: true,
    env: envFor({ credential: credentialJson(), property: 'https://example.com/blog/' }),
    tokenProvider: tokenProvider(),
    fetchImpl,
    timeoutMs: 25,
  });
  assert.equal(result.results[0].code, 'TIMEOUT');
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 3000);
});
