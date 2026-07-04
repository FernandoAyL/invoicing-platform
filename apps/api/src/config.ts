export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Object.freeze({
    nodeEnv: env.NODE_ENV ?? 'development',
    port: positiveInt(env, 'PORT', 8080),
    databaseUrl: required(env, 'DATABASE_URL'),
  });
}

export const config: Config = loadConfig();
