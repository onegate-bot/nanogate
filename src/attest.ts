/**
 * Host attestation — Ed25519-signed statements the container can verify but
 * cannot forge.
 *
 * WHY THIS EXISTS
 *
 * The agent correctly refused an attestation placed in CLAUDE.local.md: that
 * path is mounted `readonly: false` (container-runner.ts), so the agent can
 * author it itself and content there cannot self-attest. An `on_wake` message
 * is no better — it arrives through the same inbound.db pipeline as any user
 * message, with no structural distinction.
 *
 * The fix is asymmetric. The private key never enters the container; only the
 * public key does, inside a read-only mount. The agent can verify a signature
 * it has no way to produce.
 *
 * Note what this does and does not prove. It proves a statement was signed by
 * the holder of the host private key — i.e. host origin. It does NOT prove
 * which human asked for it. Pair it with owner-totp for that: TOTP
 * authenticates the person, this carries the result to the agent unforgeably.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Private key lives outside the mounted directory. Never mount this path. */
export const ATTEST_KEY_PATH = path.join(os.homedir(), '.config', 'nanoclaw', 'attest-ed25519.key');

/** Mounted read-only into containers. Public material only. */
export const ATTEST_DIR = path.join(os.homedir(), '.nanoclaw-attest');
export const ATTEST_PUB_PATH = path.join(ATTEST_DIR, 'attest-ed25519.pub');
export const ATTESTATIONS_DIR = path.join(ATTEST_DIR, 'attestations');

export interface Attestation {
  statement: string;
  issuedAt: string;
  nonce: string;
  signature: string;
}

/**
 * Bytes that get signed. Field order is fixed here rather than relying on
 * JSON.stringify key order, so a verifier in another language can reproduce it.
 */
export function signingPayload(statement: string, issuedAt: string, nonce: string): Buffer {
  return Buffer.from(JSON.stringify({ statement, issuedAt, nonce }), 'utf8');
}

/** Generate the keypair. Private key 0600 outside the mount, public key inside it. */
export function initKeys(force = false): { created: boolean; publicKey: string } {
  if (fs.existsSync(ATTEST_KEY_PATH) && !force) {
    return { created: false, publicKey: fs.readFileSync(ATTEST_PUB_PATH, 'utf8') };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  fs.mkdirSync(path.dirname(ATTEST_KEY_PATH), { recursive: true });
  fs.writeFileSync(ATTEST_KEY_PATH, privPem, { mode: 0o600 });
  fs.chmodSync(ATTEST_KEY_PATH, 0o600);

  fs.mkdirSync(ATTESTATIONS_DIR, { recursive: true });
  fs.writeFileSync(ATTEST_PUB_PATH, pubPem, { mode: 0o644 });

  return { created: true, publicKey: pubPem };
}

/** Sign a statement and persist it into the read-only-mounted attestations dir. */
export function signAttestation(statement: string, slug?: string): { file: string; attestation: Attestation } {
  const privPem = fs.readFileSync(ATTEST_KEY_PATH, 'utf8');
  const key = crypto.createPrivateKey(privPem);

  const issuedAt = new Date().toISOString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.sign(null, signingPayload(statement, issuedAt, nonce), key).toString('base64');

  const attestation: Attestation = { statement, issuedAt, nonce, signature };

  fs.mkdirSync(ATTESTATIONS_DIR, { recursive: true });
  const name = `${issuedAt.replace(/[:.]/g, '-')}-${slug ?? 'attestation'}.json`;
  const file = path.join(ATTESTATIONS_DIR, name);
  fs.writeFileSync(file, JSON.stringify(attestation, null, 2) + '\n', { mode: 0o644 });

  return { file, attestation };
}

/**
 * Verify against a public key. Exported so the host can self-test; the
 * container runs the standalone verify.mjs, which reimplements this with no
 * imports from this tree (the agent must not have to trust our code either).
 */
export function verifyAttestation(attestation: Attestation, publicKeyPem: string): boolean {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(
      null,
      signingPayload(attestation.statement, attestation.issuedAt, attestation.nonce),
      key,
      Buffer.from(attestation.signature, 'base64'),
    );
  } catch (_err) {
    // A malformed key or signature is a verification failure, not a crash —
    // the caller only ever needs the boolean.
    return false;
  }
}
