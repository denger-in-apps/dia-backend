const password = process.env.DEV_AUTH_PASSWORD;
if (!password) throw new Error('DEV_AUTH_PASSWORD wajib diisi');

const baseUrl = process.env.AUTH_SMOKE_BASE_URL || 'http://127.0.0.1:3000/api/v1/auth';
const accounts = [
  { role: 'DOSEN_ADMIN', email: 'admin.test@denger.local' },
  { role: 'PSIKOLOG', email: 'psikolog.test@denger.local' },
];

async function expectStatus(response, expected, operation) {
  if (response.status !== expected) {
    throw new Error(`${operation}: expected HTTP ${expected}, received ${response.status}: ${await response.text()}`);
  }
}

function cookieFrom(response) {
  const header = response.headers.get('set-cookie') || '';
  const match = header.match(/(?:^|,\s*)refresh_token=([^;]+)/);
  if (!match) throw new Error('Response tidak menyetel refresh_token cookie');
  return `refresh_token=${match[1]}`;
}

for (const account of accounts) {
  const loginResponse = await fetch(`${baseUrl}/staff/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...account, password }),
  });
  await expectStatus(loginResponse, 200, `${account.role} login`);
  const login = await loginResponse.json();
  if (login.user?.role !== account.role || typeof login.accessToken !== 'string') {
    throw new Error(`${account.role} login returned an invalid session`);
  }

  const profileResponse = await fetch(`${baseUrl}/me`, {
    headers: { authorization: `Bearer ${login.accessToken}` },
  });
  await expectStatus(profileResponse, 200, `${account.role} /me`);
  const profile = await profileResponse.json();
  if (profile.role !== account.role || profile.email !== account.email) {
    throw new Error(`${account.role} /me returned the wrong profile`);
  }

  const refreshResponse = await fetch(`${baseUrl}/refresh`, {
    method: 'POST',
    headers: { origin: 'https://localhost', cookie: cookieFrom(loginResponse) },
  });
  await expectStatus(refreshResponse, 200, `${account.role} refresh`);
  const refreshed = await refreshResponse.json();
  if (refreshed.user?.role !== account.role || typeof refreshed.accessToken !== 'string') {
    throw new Error(`${account.role} refresh returned an invalid session`);
  }

  const logoutResponse = await fetch(`${baseUrl}/logout`, {
    method: 'POST',
    headers: { origin: 'https://localhost', cookie: cookieFrom(refreshResponse) },
  });
  await expectStatus(logoutResponse, 204, `${account.role} logout`);
  console.log(`${account.role}: login, /me, refresh, logout OK`);
}
