import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function parseTotpInput(input) {
  let raw = String(input || '').trim();
  if (!raw) return { secret: '', digits: 6, period: 30, algorithm: 'sha1' };

  if (raw.toLowerCase().startsWith('otpauth://')) {
    try {
      const url = new URL(raw);
      raw = url.searchParams.get('secret') || '';
      const digits = Number(url.searchParams.get('digits') || 6);
      const period = Number(url.searchParams.get('period') || 30);
      const algorithm = (url.searchParams.get('algorithm') || 'sha1').toLowerCase();
      return {
        secret: normalizeSecret(raw),
        digits: Number.isFinite(digits) && digits >= 6 && digits <= 8 ? digits : 6,
        period: Number.isFinite(period) && period > 0 ? period : 30,
        algorithm: ['sha1', 'sha256', 'sha512'].includes(algorithm) ? algorithm : 'sha1'
      };
    } catch {
      // 落回普通密钥处理
    }
  }

  return {
    secret: normalizeSecret(raw),
    digits: 6,
    period: 30,
    algorithm: 'sha1'
  };
}

export function normalizeSecret(secret) {
  return String(secret || '')
    .replace(/\s+/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
}

function base32Decode(secret) {
  const clean = normalizeSecret(secret);
  let bits = '';
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`密钥包含非法 Base32 字符: ${char}`);
    bits += index.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(input, now = Date.now()) {
  const { secret, digits, period, algorithm } = parseTotpInput(input);
  if (!secret) throw new Error('缺少 2FA 密钥');

  const counter = Math.floor(now / 1000 / period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac(algorithm, base32Decode(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function secondsRemaining(input, now = Date.now()) {
  const { period } = parseTotpInput(input);
  return period - (Math.floor(now / 1000) % period);
}
