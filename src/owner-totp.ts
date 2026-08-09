/**
 * Owner TOTP — RFC 6238, verified host-side.
 *
 * Answers a question attestation cannot: is this really the owner, on the
 * enrolled device, right now? Signed attestation proves *host origin*; anyone
 * with a shell on the Mac can produce one. TOTP proves *possession of the
 * enrolled authenticator*, which is what defends against someone holding the
 * owner's Telegram account but not their phone — the realistic threat after a
 * device loss.
 *
 * Verification happens in the router, before the message reaches the
 * container. The secret never enters a container, and the agent never sees a
 * code — it only ever sees the signed attestation that results.
 *
 * Implemented on node:crypto alone. No dependency, so nothing to age through
 * the pnpm minimumReleaseAge gate and nothing new in the supply chain.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Never mounted into a container. */
export const TOTP_PATH = path.join(os.homedir(), '.config', 'nanoclaw', 'owner-totp.json');

const DIGITS = 6;
const STEP_SECONDS = 30;
/** Accept the neighbouring steps too, for clock skew between phone and host. */
const WINDOW = 1;

export interface TotpConfig {
  secretBase32: string;
  userId: string;
  enrolledAt: string;
  /** Highest step already consumed — replay protection. */
  lastUsedStep?: number;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP with dynamic truncation. */
export function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

export function readConfig(): TotpConfig | null {
  try {
    return JSON.parse(fs.readFileSync(TOTP_PATH, 'utf8')) as TotpConfig;
  } catch (_err) {
    // Absent or unreadable both mean "not enrolled" to every caller.
    return null;
  }
}

function writeConfig(cfg: TotpConfig): void {
  fs.mkdirSync(path.dirname(TOTP_PATH), { recursive: true });
  fs.writeFileSync(TOTP_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(TOTP_PATH, 0o600);
}

/** Enrol an owner. Returns the otpauth:// URI to feed an authenticator app. */
export function enroll(userId: string, issuer = 'NanoClaw'): { uri: string; secretBase32: string } {
  const secretBase32 = toBase32(crypto.randomBytes(20));
  writeConfig({ secretBase32, userId, enrolledAt: new Date().toISOString() });
  const label = encodeURIComponent(`${issuer}:${userId}`);
  const uri =
    `otpauth://totp/${label}?secret=${secretBase32}` +
    `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
  return { uri, secretBase32 };
}

export type VerifyResult =
  | { ok: true; step: number }
  | { ok: false; reason: 'not-enrolled' | 'wrong-user' | 'bad-format' | 'invalid' | 'replayed' };

/**
 * Verify a code for a user. Consumes the step on success so the same code
 * cannot be replayed inside its 30-second window — which matters here because
 * codes travel over Telegram, where an attacker with account access could
 * otherwise reuse one they can see.
 */
export function verifyCode(code: string, userId: string, nowMs = Date.now()): VerifyResult {
  const cfg = readConfig();
  if (!cfg) return { ok: false, reason: 'not-enrolled' };
  if (cfg.userId !== userId) return { ok: false, reason: 'wrong-user' };

  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return { ok: false, reason: 'bad-format' };

  const secret = fromBase32(cfg.secretBase32);
  const now = currentStep(nowMs);

  for (let drift = -WINDOW; drift <= WINDOW; drift++) {
    const step = now + drift;
    const expected = hotp(secret, step);
    // Constant-time compare — both are fixed-length numeric strings.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(trimmed))) {
      if (cfg.lastUsedStep !== undefined && step <= cfg.lastUsedStep) {
        return { ok: false, reason: 'replayed' };
      }
      writeConfig({ ...cfg, lastUsedStep: step });
      return { ok: true, step };
    }
  }
  return { ok: false, reason: 'invalid' };
}
