import { tokenStorage } from '@/lib/token-storage';

describe('tokenStorage (frontend security)', () => {
  afterEach(() => {
    tokenStorage.clear();
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = 'bc_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('starts unauthenticated', () => {
    expect(tokenStorage.isAuthenticated()).toBe(false);
    expect(tokenStorage.getAccessToken()).toBeNull();
  });

  it('holds the access token in memory after set()', () => {
    tokenStorage.set({ accessToken: 'a', csrfToken: 'c' });
    expect(tokenStorage.isAuthenticated()).toBe(true);
    expect(tokenStorage.getAccessToken()).toBe('a');
    expect(tokenStorage.getCsrfToken()).toBe('c');
  });

  it('NEVER persists the access token to localStorage or sessionStorage', () => {
    // An XSS that can read a durable store can exfiltrate a credential and use
    // it from elsewhere; an in-memory token dies with the tab.
    tokenStorage.set({ accessToken: 'super-secret-access', csrfToken: 'c' });

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(JSON.stringify(localStorage)).not.toContain('super-secret');
    expect(JSON.stringify(sessionStorage)).not.toContain('super-secret');
  });

  it('NEVER writes the access token to document.cookie', () => {
    // A cookie is sent ambiently on every same-origin request, which is what
    // makes CSRF possible. The access token travels as an explicit header.
    tokenStorage.set({ accessToken: 'cookie-check-access', csrfToken: 'c' });
    expect(document.cookie).not.toContain('cookie-check-access');
  });

  it('holds NO refresh token at all — the server owns it as an httpOnly cookie', () => {
    tokenStorage.set({ accessToken: 'a', csrfToken: 'c' });
    // The property that closes Phase 2's disclosed gap: there is no API here
    // that could return a refresh token, because this module never receives
    // one. A page reload recovers the session via the cookie instead.
    expect(tokenStorage).not.toHaveProperty('getRefreshToken');
    expect(JSON.stringify(Object.keys(tokenStorage))).not.toContain('efresh');
  });

  it('recovers the CSRF token from the cookie after a reload wipes memory', () => {
    document.cookie = 'bc_csrf=from-cookie; path=/';
    // In-memory copy is gone (a fresh module state, as after a reload), so the
    // very first refresh must still be able to present a matching header.
    expect(tokenStorage.getCsrfToken()).toBe('from-cookie');
  });

  it('prefers the in-memory CSRF token over a stale cookie', () => {
    document.cookie = 'bc_csrf=stale; path=/';
    tokenStorage.set({ accessToken: 'a', csrfToken: 'fresh' });
    // After a rotation the server sends a new token in both places; the
    // in-memory one is the one this request just received.
    expect(tokenStorage.getCsrfToken()).toBe('fresh');
  });

  it('clear() drops local state', () => {
    tokenStorage.set({ accessToken: 'a', csrfToken: 'c' });
    tokenStorage.clear();

    expect(tokenStorage.isAuthenticated()).toBe(false);
    expect(tokenStorage.getAccessToken()).toBeNull();
  });
});
