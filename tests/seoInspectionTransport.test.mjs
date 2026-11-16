import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { defaultTokenProvider, INSPECTION_ENDPOINT, inspectSample } from '../scripts/seo/inspection.mjs';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const SERVICE_ACCOUNT = {
  email: 'seo-audit@example.iam.gserviceaccount.com',
  key: privateKey,
};

const credentialJson = JSON.stringify({
  type: 'service_account',
  client_email: SERVICE_ACCOUNT.email,
  private_key: SERVICE_ACCOUNT.key,
});

const tokenResponse = () =>
  new Response(JSON.stringify({ access_token: 'synthetic-access-token', expires_in: 3600, token_type: 'Bearer' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const statusResponse = () =>
  new Response(
    JSON.stringify({
      inspectionResult: {
        indexStatusResult: {
          verdict: 'PASS',
          robotsTxtState: 'ALLOWED',
          indexingState: 'INDEXING_ALLOWED',
          pageFetchState: 'SUCCESSFUL',
        },
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function captureFetch(factory) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return factory(calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('the pinned JWT transporter bounds, disables retries and blocks redirects at token exchange', async () => {
  const fetchImpl = captureFetch(() => tokenResponse());
  const token = await defaultTokenProvider({
    ...SERVICE_ACCOUNT,
    fetchImplementation: fetchImpl,
  });

  assert.equal(token, 'synthetic-access-token');
  assert.equal(fetchImpl.calls.length, 1);
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, 'https://oauth2.googleapis.com/token');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.timeout, 10000);
  assert.equal(init.retryConfig.retry, 0);
  assert.ok(init.signal instanceof AbortSignal);
  const body = new URLSearchParams(init.body);
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.ok(body.get('assertion'));

  const seen = JSON.stringify(fetchImpl.calls.map((call) => call.init));
  assert.ok(!seen.includes(privateKey.split('\n')[1]));
});

test('credential JSON cannot redirect the token exchange or select an impersonated identity', async () => {
  const fetchImpl = captureFetch(() => tokenResponse());
  await defaultTokenProvider({
    email: SERVICE_ACCOUNT.email,
    key: SERVICE_ACCOUNT.key,
    token_uri: 'https://attacker.example/token',
    universe_domain: 'attacker.example',
    subject: 'admin@example.com',
    scopes: ['https://www.googleapis.com/auth/webmasters'],
    fetchImplementation: fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://oauth2.googleapis.com/token');
  const assertion = new URLSearchParams(fetchImpl.calls[0].init.body).get('assertion');
  const payload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/webmasters.readonly');
  assert.equal(payload.sub, undefined);
});

test('a redirect from the token endpoint is rejected without contacting the target', async () => {
  const fetchImpl = captureFetch(
    () => new Response('', { status: 302, headers: { location: 'https://attacker.example/token' } }),
  );
  await assert.rejects(() => defaultTokenProvider({ ...SERVICE_ACCOUNT, fetchImplementation: fetchImpl }));
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(fetchImpl.calls[0].init.redirect, 'manual');
});

test('a token denial becomes a static auth failure and never issues an inspection request', async () => {
  const tokenFetch = captureFetch(
    () => new Response('', { status: 302, headers: { location: 'https://attacker.example/token' } }),
  );
  const apiFetch = captureFetch(() => {
    throw new Error('inspection must not be called');
  });
  const result = await inspectSample({
    urls: ['https://example.com/blog/a'],
    requested: true,
    env: {
      SEO_SEARCH_CONSOLE_CREDENTIALS: credentialJson,
      SEO_SEARCH_CONSOLE_PROPERTY: 'https://example.com/blog/',
    },
    tokenProvider: (options) => defaultTokenProvider({ ...options, fetchImplementation: tokenFetch }),
    fetchImpl: apiFetch,
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'AUTH_FAILED');
  assert.equal(apiFetch.calls.length, 0);
  assert.equal(tokenFetch.calls.length, 1);
  assert.ok(!JSON.stringify(result).includes('attacker.example'));
});

test('the token request itself terminates on its transporter timeout', async () => {
  let aborted = false;
  const fetchImpl = async (url, init) =>
    new Promise((resolve, reject) => {
      // AbortSignal.timeout is unref'ed, so keep the loop alive like a real socket would.
      const keepAlive = setInterval(() => {}, 100);
      init.signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          clearInterval(keepAlive);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
        { once: true },
      );
    });
  const started = Date.now();
  await assert.rejects(() =>
    defaultTokenProvider({ ...SERVICE_ACCOUNT, fetchImplementation: fetchImpl, timeoutMs: 25 }),
  );
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 3000);
});

test('the inspection endpoint is the only API destination and it is bounded', async () => {
  const tokenFetch = captureFetch(() => tokenResponse());
  const apiFetch = captureFetch(() => statusResponse());
  const result = await inspectSample({
    urls: ['https://example.com/blog/a'],
    requested: true,
    env: {
      SEO_SEARCH_CONSOLE_CREDENTIALS: credentialJson,
      SEO_SEARCH_CONSOLE_PROPERTY: 'https://example.com/blog/',
    },
    tokenProvider: (options) => defaultTokenProvider({ ...options, fetchImplementation: tokenFetch }),
    fetchImpl: apiFetch,
  });

  assert.equal(result.status, 'completed');
  assert.equal(tokenFetch.calls.length, 1);
  assert.equal(apiFetch.calls.length, 1);
  assert.equal(apiFetch.calls[0].url, INSPECTION_ENDPOINT);
  assert.equal(apiFetch.calls[0].init.redirect, 'manual');
  assert.equal(apiFetch.calls[0].init.credentials, 'omit');
});
