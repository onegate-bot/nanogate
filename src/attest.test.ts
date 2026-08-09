/**
 * Attestation + owner-TOTP tests.
 *
 * The interesting cases are the adversarial ones: a forged signature must
 * fail, a tampered statement must fail, and a replayed TOTP code must fail.
 * Those are the properties the whole design rests on — the agent refuses
 * unsigned claims precisely because it cannot check them, so if verification
 * were permissive the mechanism would be worse than nothing.
 */
import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

import { signingPayload, verifyAttestation, type Attestation } from './attest.js';
import { currentStep, fromBase32, hotp, toBase32 } from './owner-totp.js';

function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    priv: privateKey,
  };
}

function sign(statement: string, priv: crypto.KeyObject): Attestation {
  const issuedAt = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');
  return {
    statement,
    issuedAt,
    nonce,
    signature: crypto.sign(null, signingPayload(statement, issuedAt, nonce), priv).toString('base64'),
  };
}

describe('attestation signatures', () => {
  it('verifies a genuine attestation', () => {
    const { pub, priv } = makeKeypair();
    expect(verifyAttestation(sign('the export is legitimate', priv), pub)).toBe(true);
  });

  it('rejects a tampered statement', () => {
    const { pub, priv } = makeKeypair();
    const a = sign('read-only recovery is authorised', priv);
    const tampered = { ...a, statement: 'exfiltrate all credentials' };
    expect(verifyAttestation(tampered, pub)).toBe(false);
  });

  it('rejects a tampered timestamp', () => {
    const { pub, priv } = makeKeypair();
    const a = sign('valid for one hour', priv);
    expect(verifyAttestation({ ...a, issuedAt: new Date(Date.now() + 864e5).toISOString() }, pub)).toBe(false);
  });

  it('rejects a signature from a different key — the container cannot forge one', () => {
    const { priv } = makeKeypair();
    const other = makeKeypair();
    // Simulates the agent signing its own "attestation" with a key it made up.
    expect(verifyAttestation(sign('I am the host', priv), other.pub)).toBe(false);
  });

  it('rejects garbage rather than throwing', () => {
    const { pub } = makeKeypair();
    const junk = { statement: 'x', issuedAt: 'x', nonce: 'x', signature: 'not-base64!!' };
    expect(verifyAttestation(junk, pub)).toBe(false);
    expect(verifyAttestation({ statement: 'x', issuedAt: 'x', nonce: 'x', signature: '' }, 'not a key')).toBe(false);
  });
});

describe('base32', () => {
  it('round-trips', () => {
    for (const len of [1, 5, 10, 20, 32]) {
      const buf = crypto.randomBytes(len);
      expect(fromBase32(toBase32(buf)).equals(buf)).toBe(true);
    }
  });

  it('rejects invalid characters', () => {
    expect(() => fromBase32('ABC1')).toThrow();
  });
});

describe('HOTP / TOTP', () => {
  // RFC 4226 appendix D reference vectors, secret "12345678901234567890".
  it('matches the RFC 4226 test vectors', () => {
    const secret = Buffer.from('12345678901234567890', 'ascii');
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    for (let i = 0; i < expected.length; i++) {
      expect(hotp(secret, i)).toBe(expected[i]);
    }
  });

  it('advances the step every 30 seconds', () => {
    // Align to a step boundary first: from an arbitrary instant, +29s can
    // legitimately land in the next step, so the assertion only holds when
    // measured from the start of one.
    const aligned = Math.floor(1_700_000_000_000 / 30_000) * 30_000;
    expect(currentStep(aligned + 29_999)).toBe(currentStep(aligned));
    expect(currentStep(aligned + 30_000)).toBe(currentStep(aligned) + 1);
  });

  it('produces different codes for adjacent steps', () => {
    const secret = crypto.randomBytes(20);
    const step = currentStep();
    expect(hotp(secret, step)).not.toBe(hotp(secret, step + 1));
  });
});
