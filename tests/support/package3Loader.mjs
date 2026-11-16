// Package-3 test loader: reuses the inherited platform stubs and replaces only
// next/headers cookies so a real signed session cookie can be installed.
import { resolve as baseResolve, load as baseLoad } from './platformLoader.mjs';

const SESSION_STUB = 'stub:package3-session-headers';

const SESSION_SOURCE = `
const KEY = Symbol.for('lixblogs.test.sessionCookie');
export async function cookies() {
  const value = globalThis[KEY];
  return {
    get(name) { return name === 'lixblogs_session' && value ? { value } : undefined; },
    set() {},
    delete() {},
  };
}
export async function headers() {
  return new Headers(globalThis[Symbol.for('lixblogs.test.headers')]
    ?? { 'x-forwarded-proto': 'https', host: 'blogs.elixpo.com' });
}
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/headers') {
    return { url: SESSION_STUB, format: 'module', shortCircuit: true };
  }
  return baseResolve(specifier, context, nextResolve);
}

export async function load(url, context, nextLoad) {
  if (url === SESSION_STUB) {
    return { format: 'module', shortCircuit: true, source: SESSION_SOURCE };
  }
  return baseLoad(url, context, nextLoad);
}
