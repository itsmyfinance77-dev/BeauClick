/**
 * The only configuration the browser bundle needs. NEXT_PUBLIC_* values are
 * embedded in client JS and are therefore PUBLIC by definition -- never put
 * a secret here (JWT signing secrets, OTP HMAC secrets, and DATABASE_URL
 * live exclusively in the API's own server-side environment).
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3099/api';
