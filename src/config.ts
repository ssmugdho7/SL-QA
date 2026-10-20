import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env (see .env.example)`);
  return value;
}

export const config = {
  sheetId: required('SHEET_ID'),
  sheetGid: required('SHEET_GID'),
  baseUrl: required('BASE_URL').replace(/\/$/, ''),
  apiUrl: required('API_URL').replace(/\/$/, ''),
  phone: required('LOGIN_PHONE'),
  password: required('LOGIN_PASSWORD'),
  authFile: '.auth/state.json',
  runsDir: 'runs',
  // Every record the bot creates carries this prefix so it is easy to spot and clean up.
  fixturePrefix: 'BTB',
};
