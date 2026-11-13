import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** TOTP RFC 6238 (SHA-1, 6 digit, 30 detik) — kompatibel dengan Google Authenticator/Authy. */
export const TOTP_STEP_MS = 30_000;
export const TOTP_DRIFT_STEPS = 1;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(value: string): Buffer {
  const normalized = value.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) throw new Error('Invalid TOTP secret');
  let bits = '';
  for (const char of normalized) bits += ALPHABET.indexOf(char).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

export function encodeBase32(buffer: Buffer): string {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let offset = 0; offset < bits.length; offset += 5) {
    out += ALPHABET[Number.parseInt(bits.slice(offset, offset + 5).padEnd(5, '0'), 2)];
  }
  return out;
}

/** Secret baru 160-bit (panjang yang direkomendasikan RFC 4226), dalam base32. */
export function buatSecretTotp(): string {
  return encodeBase32(randomBytes(20));
}

export function kodeTotp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

/** Mengembalikan time-step yang cocok (untuk anti-replay), atau `null` bila OTP salah. */
export function cocokkanTotp(secretBase32: string, otp: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(otp)) return null;
  const secret = decodeBase32(secretBase32);
  const nowStep = Math.floor(nowMs / TOTP_STEP_MS);
  for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift++) {
    const step = nowStep + drift;
    if (timingSafeEqual(Buffer.from(kodeTotp(secret, step)), Buffer.from(otp))) return step;
  }
  return null;
}

export function otpauthUrl(secretBase32: string, akun: string, issuer = 'Denger.in'): string {
  const label = encodeURIComponent(`${issuer}:${akun}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
