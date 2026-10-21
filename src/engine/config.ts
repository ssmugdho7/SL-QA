import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env (see .env.example)`);
  return value;
}

export const config = {
  baseUrl: required('BASE_URL').replace(/\/$/, ''),
  apiUrl: required('API_URL').replace(/\/$/, ''),
  phone: required('LOGIN_PHONE'),
  password: required('LOGIN_PASSWORD'),
  /** Password for the web app (HTTP basic auth). Empty = no login. */
  appPassword: process.env.APP_PASSWORD ?? '',
  port: Number(process.env.PORT ?? 4100),
  authFile: '.auth/state.json',
  runsDir: 'runs',
  dataDir: 'data',
  // Every record the bot creates carries this prefix so it is easy to spot and clean up.
  fixturePrefix: 'BTB',
  /** AI keys are read by src/engine/ai/providers.ts (free providers first, then capped paid ones). */
};
