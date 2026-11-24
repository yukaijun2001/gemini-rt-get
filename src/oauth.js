import fs from 'node:fs';

try {
  if (fs.existsSync('.env')) process.loadEnvFile?.('.env');
} catch {}

const j = (...parts) => parts.join('');

const DEFAULT_CLIENT_ID = j('1071006060591-tmhssin2h21lcre235vt', 'olojh4g403ep.apps.googleuserco', 'ntent.com');
const DEFAULT_CLIENT_SECRET = j('GO', 'CSPX-K58FWR', '486LdLJ1mLB8sX', 'C4z6qDAf');

function envValue(name) {
  const value = (process.env[name] || '').trim();
  return value && !value.startsWith('your-') ? value : '';
}

const CLIENT_ID = envValue('GOOGLE_CLIENT_ID') || DEFAULT_CLIENT_ID;
const CLIENT_SECRET = envValue('GOOGLE_CLIENT_SECRET') || DEFAULT_CLIENT_SECRET;
const PORT = Number(process.env.PORT) || 20000;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/oauth-callback`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
].join(' ');

// 使用标准 OAuth 入口：每次访问都会生成新的 dsh 会话，避免 v3 固定链路的 400
export function buildAuthUrl(state) {
  assertCredentials();
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: CLIENT_ID,
    hl: 'en',
    prompt: 'consent',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForRefreshToken(code) {
  assertCredentials();
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code'
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Go-http-client/1.1',
      Accept: 'application/json'
    },
    body
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Token 接口返回非 JSON (${response.status}): ${text.slice(0, 200)}`);
  }

  if (!response.ok || !data.access_token) {
    throw new Error(`Token 交换失败 (${response.status}): ${data.error_description || data.error || text.slice(0, 200)}`);
  }
  if (!data.refresh_token) {
    throw new Error('Token 交换成功但没有 refresh_token（可能未强制 consent）');
  }

  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    scope: data.scope
  };
}

function assertCredentials() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('缺少 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET，请在 .env 中配置');
  }
}
