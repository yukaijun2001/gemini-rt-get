import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { extractRefreshToken } from './extractor.js';

const PORT = Number(process.env.PORT) || 20000;
const HOST = process.env.HOST || '0.0.0.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RECORDINGS_DIR = path.join(ROOT, 'recordings');
const PROFILES_DIR = path.join(ROOT, 'profiles');

const jobs = new Map();
const pendingCodes = new Map();
const earlyCodes = new Map();
const sseClients = new Set();
const queue = [];
let running = false;

function detectUrls() {
  const urls = [];
  const envIp = (process.env.HOST_IP || '').trim();
  if (envIp) urls.push(`http://${envIp}:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(address.address)) continue;
      urls.push(`http://${address.address}:${PORT}`);
    }
  }
  return [...new Set(urls)];
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/recordings', express.static(RECORDINGS_DIR));

function publicJob(job) {
  const { password, twofa, state, ...rest } = job;
  return rest;
}

function broadcast() {
  const payload = JSON.stringify([...jobs.values()].map(publicJob));
  for (const res of sseClients) res.write(`data: ${payload}\n\n`);
}

function update(job, patch) {
  Object.assign(job, patch);
  broadcast();
}

function parseLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(/\s*-{3,}\s*/);
      if (parts.length < 3) return null;
      const [email, password, ...twofaParts] = parts;
      return {
        email: email.trim(),
        password: password.trim(),
        twofa: twofaParts.join('----').trim()
      };
    })
    .filter(item => item && item.email.includes('@') && item.password && item.twofa);
}

function enqueue(job) {
  queue.push(job);
  pump();
}

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  job.status = 'running';
  job.startedAt = Date.now();
  update(job, {});

  try {
    const result = await extractRefreshToken(job, {
      recordingsDir: RECORDINGS_DIR,
      profilesDir: PROFILES_DIR,
      onStage: stage => update(job, { stage }),
      waitForCode: timeout => new Promise((resolve, reject) => {
        const early = earlyCodes.get(job.state);
        if (early) {
          earlyCodes.delete(job.state);
          if (early.error || !early.code) reject(new Error(`Google 返回错误: ${early.error || '缺少 code'}`));
          else resolve(early.code);
          return;
        }
        const timer = setTimeout(() => {
          pendingCodes.delete(job.state);
          reject(new Error('等待授权回调超时（90 秒）'));
        }, timeout);
        pendingCodes.set(job.state, { resolve, timer });
      })
    });
    update(job, {
      status: 'success',
      stage: '完成',
      rt: result.refreshToken,
      scope: result.scope,
      finishedAt: Date.now()
    });
  } catch (error) {
    update(job, {
      status: 'failed',
      stage: '失败',
      error: error?.message || String(error),
      finishedAt: Date.now()
    });
  } finally {
    running = false;
    pump();
  }
}

app.get('/oauth-callback', (req, res) => {
  const { code, state, error } = req.query;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<html><body style="font-family:system-ui;padding:40px"><h2>授权完成</h2><p>可以关闭此页面。</p></body></html>');

  const entry = pendingCodes.get(String(state));
  if (!entry) {
    earlyCodes.set(String(state), { code, error });
    return;
  }
  clearTimeout(entry.timer);
  pendingCodes.delete(String(state));
  if (error || !code) entry.resolve(new Error(`Google 返回错误: ${error || '缺少 code'}`));
  else entry.resolve(code);
});

app.get('/api/jobs', (_req, res) => {
  res.json([...jobs.values()].map(publicJob));
});

app.get('/api/info', (_req, res) => {
  res.json({ port: PORT, urls: detectUrls() });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify([...jobs.values()].map(publicJob))}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.post('/api/jobs', (req, res) => {
  const parsed = parseLines(req.body?.text);
  if (!parsed.length) {
    res.status(400).json({ message: '没有解析到有效账号，格式应为 邮箱----密码----2FA密钥' });
    return;
  }

  const ids = [];
  for (const item of parsed) {
    const existing = [...jobs.values()].find(job => job.email === item.email);
    if (existing) {
      jobs.delete(existing.id);
      const index = queue.indexOf(existing);
      if (index >= 0) queue.splice(index, 1);
    }
    const job = {
      id: randomUUID(),
      email: item.email,
      password: item.password,
      twofa: item.twofa,
      state: `${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
      status: 'queued',
      stage: '排队中',
      rt: null,
      error: null,
      createdAt: Date.now()
    };
    jobs.set(job.id, job);
    ids.push(job.id);
    queue.push(job);
  }

  broadcast();
  pump();
  res.json({ ids });
});

app.delete('/api/jobs', (_req, res) => {
  for (const job of jobs.values()) {
    if (job.status !== 'running') jobs.delete(job.id);
  }
  queue.length = 0;
  broadcast();
  res.json({ ok: true });
});

await fs.mkdir(RECORDINGS_DIR, { recursive: true });
await fs.mkdir(PROFILES_DIR, { recursive: true });

app.listen(PORT, HOST, () => {
  console.log(`gemini-rt-get 已启动: http://localhost:${PORT}`);
  const urls = detectUrls();
  if (urls.length) urls.forEach(url => console.log(`局域网访问: ${url}`));
  else console.log(`未探测到局域网 IP，请用 http://<服务器IP>:${PORT} 访问（页面顶部会显示实际地址）`);
});
