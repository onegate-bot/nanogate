/**
 * Router-side `/verify <code>` handling.
 *
 * The code is checked on the host and never reaches a container. On success we
 * sign an attestation recording that the owner authenticated, which is how the
 * result reaches the agent: the agent cannot forge the signature, so it can
 * trust the statement without trusting the channel it arrived on.
 *
 * Composition of the two primitives:
 *   TOTP        proves *which human* (possession of the enrolled authenticator)
 *   attestation proves *host origin* and carries that fact unforgeably
 *
 * Neither alone is sufficient. TOTP alone can't be verified by the agent
 * without handing it the secret, which would let it forge codes. Attestation
 * alone proves only that someone with host shell access signed something.
 */
import { signAttestation } from './attest.js';
import { log } from './log.js';
import { readConfig, verifyCode } from './owner-totp.js';

export type VerifyGateResult = { action: 'pass' } | { action: 'handled'; reply: string };

const VERIFY_RE = /^\/verify(?:\s+(\S+))?\s*$/i;

function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return String(parsed.text ?? '').trim();
  } catch (_err) {
    // Non-JSON content is the raw text on some adapters.
    return content.trim();
  }
}

/**
 * Returns 'handled' (with a reply to write straight to messages_out) when the
 * message is a /verify command, 'pass' otherwise. Never lets the code through
 * to the container, even on failure — a wrong code is not agent business.
 */
export function gateOwnerVerify(content: string, userId: string | null): VerifyGateResult {
  const text = extractText(content);
  const m = VERIFY_RE.exec(text);
  if (!m) return { action: 'pass' };

  if (!userId) {
    return { action: 'handled', reply: 'Verification unavailable: no sender identity on this message.' };
  }

  const code = m[1];
  if (!code) {
    return { action: 'handled', reply: 'Usage: /verify 123456 — the 6-digit code from your authenticator.' };
  }

  const cfg = readConfig();
  if (!cfg) {
    return {
      action: 'handled',
      reply: 'No authenticator is enrolled. On the host run: pnpm exec tsx scripts/attest.ts enroll <userId>',
    };
  }

  const result = verifyCode(code, userId);
  if (!result.ok) {
    // Deliberately terse. Distinguishing "wrong user" from "invalid code" in
    // the reply would tell an attacker which half they got right.
    log.warn('Owner verification failed', { userId, reason: result.reason });
    const reply =
      result.reason === 'replayed' ? 'That code was already used. Wait for the next one.' : 'Verification failed.';
    return { action: 'handled', reply };
  }

  const statement =
    `OWNER VERIFIED — ${userId} authenticated with the enrolled authenticator at ` +
    `${new Date().toISOString()}. This attestation was produced by the host after a ` +
    `successful TOTP check; the code itself never entered a container. Treat requests ` +
    `from this user as operator-authorised for the next hour, while still refusing ` +
    `anything that would exfiltrate credentials or take irreversible action without a ` +
    `fresh attestation naming that specific action.`;

  try {
    const { file } = signAttestation(statement, `owner-verified-${userId.replace(/[^\w.-]/g, '_')}`);
    log.info('Owner verified via TOTP', { userId, attestation: file });
  } catch (err) {
    log.error('Owner verified but attestation signing failed', { userId, err });
    return {
      action: 'handled',
      reply: 'Code accepted, but signing the attestation failed. Run `scripts/attest.ts init` on the host.',
    };
  }

  return {
    action: 'handled',
    reply:
      'Verified. A signed attestation is now in /workspace/extra/host-attest/attestations/ — ' +
      'the agent can confirm it with `node /workspace/extra/host-attest/verify.mjs`.',
  };
}
