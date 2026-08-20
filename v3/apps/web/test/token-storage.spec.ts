import { tokenStorage } from '@/lib/token-storage';

describe('tokenStorage (frontend security)', () => {
  afterEach(() => {
    tokenStorage.clear();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('starts unauthenticated', () => {
    expect(tokenStorage.isAuthenticated()).toBe(false);
    expect(tokenStorage.getAccessToken()).toBeNull();
  });

  it('holds tokens after set()', () => {
    tokenStorage.set({ accessToken: 'a', refreshToken: 'r' });
    expect(tokenStorage.isAuthenticated()).toBe(true);
    expect(tokenStorage.getAccessToken()).toBe('a');
    expect(tokenStorage.getRefreshToken()).toBe('r');
  });

  it('NEVER persists tokens to localStorage or sessionStorage (an XSS must not find a durable credential)', () => {
    tokenStorage.set({ accessToken: 'super-secret-access', refreshToken: 'super-secret-refresh' });

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(JSON.stringify(localStorage)).not.toContain('super-secret');
    expect(JSON.stringify(sessionStorage)).not.toContain('super-secret');
  });

  it('NEVER writes tokens to document.cookie', () => {
    tokenStorage.set({ accessToken: 'cookie-check-access', refreshToken: 'cookie-check-refresh' });
    expect(document.cookie).not.toContain('cookie-check');
  });

  it('clear() fully revokes local access', () => {
    tokenStorage.set({ accessToken: 'a', refreshToken: 'r' });
    tokenStorage.clear();

    expect(tokenStorage.isAuthenticated()).toBe(false);
    expect(tokenStorage.getAccessToken()).toBeNull();
    expect(tokenStorage.getRefreshToken()).toBeNull();
  });
});
