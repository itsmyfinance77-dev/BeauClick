/**
 * Backend foundation requirement: environment configuration is validated at
 * boot, not discovered missing at first request. Fails fast with a clear
 * message rather than booting into a half-configured state.
 */
export interface AppEnv {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL?: string;
  JWT_ACCESS_SECRET?: string;
  OTP_HMAC_SECRET?: string;
}

const REQUIRED_IN_PRODUCTION = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'OTP_HMAC_SECRET'];

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const nodeEnv = (config.NODE_ENV as string) ?? 'development';

  if (nodeEnv === 'production') {
    const missing = REQUIRED_IN_PRODUCTION.filter((key) => !config[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
    }
  }

  return config;
}
