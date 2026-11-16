const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const INSPECTION_TIMEOUT_MS = 10_000;
const INSPECTION_MAX_BYTES = 256 * 1024;
const MIN_INSPECTION_INTERVAL_MS = 1_000;

const VERDICTS = new Set(['VERDICT_UNSPECIFIED', 'PASS', 'PARTIAL', 'FAIL', 'NEUTRAL']);
const ROBOTS_TXT_STATES = new Set(['ROBOTS_TXT_STATE_UNSPECIFIED', 'ALLOWED', 'DISALLOWED']);
const INDEXING_STATES = new Set([
  'INDEXING_STATE_UNSPECIFIED',
  'INDEXING_ALLOWED',
  'BLOCKED_BY_META_TAG',
  'BLOCKED_BY_HTTP_HEADER',
  'BLOCKED_BY_ROBOTS_TXT',
]);
const PAGE_FETCH_STATES = new Set([
  'PAGE_FETCH_STATE_UNSPECIFIED',
  'SUCCESSFUL',
  'SOFT_404',
  'BLOCKED_ROBOTS_TXT',
  'NOT_FOUND',
  'ACCESS_DENIED',
  'SERVER_ERROR',
  'REDIRECT_ERROR',
  'ACCESS_FORBIDDEN',
  'BLOCKED_4XX',
  'INTERNAL_CRAWL_ERROR',
  'INVALID_URL',
]);

const FATAL_CODES = new Set(['UNAUTHORIZED', 'FORBIDDEN', 'RATE_LIMITED']);

class InspectionFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function skipped(reason) {
  return { status: 'skipped', reason };
}

function invalid(code, reason) {
  return { status: 'invalid-configuration', code, reason };
}

function failed(url, code) {
  return { url, status: 'failed', code };
}

function parseCredential(raw) {
  if (typeof raw !== 'string' || raw.length > 128 * 1024) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.type !== 'service_account') return null;
  const email = parsed.client_email;
  const key = parsed.private_key;
  if (typeof email !== 'string' || email.trim() === '' || email.length > 320) return null;
  if (typeof key !== 'string' || key.trim() === '' || key.length > 64 * 1024) return null;
  return { email: email.trim(), key };
}

function isDnsName(value) {
  if (value.length < 3 || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function parseProperty(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.toLowerCase().startsWith('sc-domain:')) {
    const domain = value.slice('sc-domain:'.length).toLowerCase();
    if (!isDnsName(domain)) return null;
    return { kind: 'domain', value: `sc-domain:${domain}`, domain };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!url.pathname.endsWith('/')) return null;
  return { kind: 'prefix', value: url.href, url };
}

function isWithinProperty(property, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  if (property.kind === 'domain') {
    const host = url.hostname.toLowerCase();
    return host === property.domain || host.endsWith(`.${property.domain}`);
  }
  return url.origin === property.url.origin && url.pathname.startsWith(property.url.pathname);
}

function enumValue(values, value) {
  return typeof value === 'string' && values.has(value) ? value : 'UNKNOWN';
}

function pickIndexStatus(indexStatus) {
  const result = {
    verdict: enumValue(VERDICTS, indexStatus.verdict),
    robotsTxtState: enumValue(ROBOTS_TXT_STATES, indexStatus.robotsTxtState),
    indexingState: enumValue(INDEXING_STATES, indexStatus.indexingState),
    pageFetchState: enumValue(PAGE_FETCH_STATES, indexStatus.pageFetchState),
  };
  if (typeof indexStatus.lastCrawlTime === 'string' && indexStatus.lastCrawlTime.length <= 64) {
    const crawl = new Date(indexStatus.lastCrawlTime);
    if (Number.isFinite(crawl.getTime())) result.lastCrawlTime = crawl.toISOString();
  }
  return result;
}

function mediaType(response) {
  const value = response.headers?.get?.('content-type') ?? '';
  return value.split(';')[0].trim().toLowerCase();
}

async function readBoundedText(response, maxBytes, controller) {
  if (!response.body) throw new InspectionFailure('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(new InspectionFailure('TIMEOUT'));
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new InspectionFailure('TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof InspectionFailure) throw error;
    if (controller.signal.aborted) throw new InspectionFailure('TIMEOUT');
    throw new InspectionFailure('NETWORK');
  } finally {
    controller.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InspectionFailure('INVALID_RESPONSE');
  }
}

async function inspectOne({ url, token, property, fetchImpl, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    try {
      response = await fetchImpl(INSPECTION_ENDPOINT, {
        method: 'POST',
        redirect: 'manual',
        credentials: 'omit',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ inspectionUrl: url, siteUrl: property }),
        signal: controller.signal,
      });
    } catch {
      throw new InspectionFailure(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK');
    }
    if (response.status >= 300 && response.status < 400) throw new InspectionFailure('REDIRECT');
    if (response.status === 401) throw new InspectionFailure('UNAUTHORIZED');
    if (response.status === 403) throw new InspectionFailure('FORBIDDEN');
    if (response.status === 429) throw new InspectionFailure('RATE_LIMITED');
    if (response.status !== 200) throw new InspectionFailure('HTTP_STATUS');
    if (mediaType(response) !== 'application/json') throw new InspectionFailure('INVALID_RESPONSE');
    const text = await readBoundedText(response, maxBytes, controller);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new InspectionFailure('INVALID_RESPONSE');
    }
    const indexStatus = body?.inspectionResult?.indexStatusResult;
    if (!indexStatus || typeof indexStatus !== 'object' || Array.isArray(indexStatus)) {
      throw new InspectionFailure('INVALID_RESPONSE');
    }
    if (typeof indexStatus.verdict !== 'string' || indexStatus.verdict.trim() === '') {
      throw new InspectionFailure('INVALID_RESPONSE');
    }
    return { result: { url, status: 'inspected', ...pickIndexStatus(indexStatus) }, fatal: null };
  } catch (error) {
    const code = error instanceof InspectionFailure ? error.code : controller.signal.aborted ? 'TIMEOUT' : 'NETWORK';
    return { result: failed(url, code), fatal: FATAL_CODES.has(code) ? code : null };
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.bodyUsed) {
      void response.body.cancel().catch(() => {});
    }
    controller.abort();
  }
}

export async function defaultTokenProvider({
  email,
  key,
  timeoutMs = INSPECTION_TIMEOUT_MS,
  fetchImplementation,
} = {}) {
  const { JWT } = await import('google-auth-library');
  const transporterOptions = {
    timeout: timeoutMs,
    retryConfig: { retry: 0 },
    redirect: 'manual',
  };
  if (fetchImplementation) transporterOptions.fetchImplementation = fetchImplementation;
  const client = new JWT({
    email,
    key,
    scopes: [SEARCH_CONSOLE_SCOPE],
    transporterOptions,
  });
  const { token } = await client.getAccessToken();
  if (typeof token !== 'string' || token.trim() === '') throw new Error('Access token missing.');
  return token;
}

export async function inspectSample({
  urls = [],
  requested = false,
  env = process.env,
  tokenProvider = defaultTokenProvider,
  fetchImpl = fetch,
  wait = defaultWait,
  timeoutMs = INSPECTION_TIMEOUT_MS,
  maxBytes = INSPECTION_MAX_BYTES,
} = {}) {
  if (!requested) return skipped('inspection not requested');
  const rawCredential = env?.SEO_SEARCH_CONSOLE_CREDENTIALS;
  if (typeof rawCredential !== 'string' || rawCredential.trim() === '') {
    return skipped('credentials not configured');
  }
  const credential = parseCredential(rawCredential);
  if (!credential) {
    return invalid('INVALID_CREDENTIALS', 'The Search Console credential is invalid.');
  }
  const rawProperty = env?.SEO_SEARCH_CONSOLE_PROPERTY;
  if (typeof rawProperty !== 'string' || rawProperty.trim() === '') {
    return invalid('INVALID_PROPERTY', 'The Search Console property is invalid.');
  }
  const property = parseProperty(rawProperty);
  if (!property) {
    return invalid('INVALID_PROPERTY', 'The Search Console property is invalid.');
  }
  const sampled = Array.isArray(urls) ? urls.filter((url) => typeof url === 'string') : [];
  if (sampled.length === 0) return skipped('no sampled URLs');
  if (!sampled.every((url) => isWithinProperty(property, url))) {
    return invalid('URL_OUTSIDE_PROPERTY', 'A sampled URL is outside the configured Search Console property.');
  }

  let token;
  try {
    token = await tokenProvider({ email: credential.email, key: credential.key, timeoutMs });
  } catch {
    return {
      status: 'unavailable',
      code: 'AUTH_FAILED',
      reason: 'Google authentication failed.',
      results: [],
      notInspected: sampled,
    };
  }
  if (typeof token !== 'string' || token.trim() === '') {
    return {
      status: 'unavailable',
      code: 'AUTH_FAILED',
      reason: 'Google authentication failed.',
      results: [],
      notInspected: sampled,
    };
  }

  const results = [];
  const notInspected = [];
  let fatal = null;
  for (let index = 0; index < sampled.length; index += 1) {
    if (index > 0) await wait(MIN_INSPECTION_INTERVAL_MS);
    const outcome = await inspectOne({
      url: sampled[index],
      token,
      property: property.value,
      fetchImpl,
      timeoutMs,
      maxBytes,
    });
    results.push(outcome.result);
    if (outcome.fatal) {
      fatal = outcome.fatal;
      notInspected.push(...sampled.slice(index + 1));
      break;
    }
  }

  if (fatal) {
    return {
      status: results.some((result) => result.status === 'inspected') ? 'partial' : 'unavailable',
      code: fatal,
      property: property.value,
      results,
      notInspected,
    };
  }
  const hasFailures = results.some((result) => result.status === 'failed');
  const hasInspected = results.some((result) => result.status === 'inspected');
  return {
    status: hasFailures ? (hasInspected ? 'partial' : 'unavailable') : 'completed',
    ...(hasFailures ? { code: 'INSPECTION_FAILED' } : {}),
    property: property.value,
    results,
    notInspected: [],
  };
}

export {
  INSPECTION_ENDPOINT,
  INSPECTION_MAX_BYTES,
  INSPECTION_TIMEOUT_MS,
  MIN_INSPECTION_INTERVAL_MS,
  SEARCH_CONSOLE_SCOPE,
};
