function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
}

export const config: Config = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: positiveInt('PORT', 8080),
  databaseUrl: required('DATABASE_URL'),
});
