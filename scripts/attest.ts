#!/usr/bin/env tsx
/**
 * Host attestation + owner-TOTP admin CLI.
 *
 *   pnpm exec tsx scripts/attest.ts init
 *   pnpm exec tsx scripts/attest.ts enroll <userId>
 *   pnpm exec tsx scripts/attest.ts sign "<statement>" [slug]
 *   pnpm exec tsx scripts/attest.ts status
 *
 * Run these on the host only. `init` writes a private key that must never be
 * mounted into a container; `enroll` writes a TOTP secret with the same rule.
 */
import fs from 'fs';

import {
  ATTEST_DIR,
  ATTEST_KEY_PATH,
  ATTEST_PUB_PATH,
  ATTESTATIONS_DIR,
  initKeys,
  signAttestation,
  verifyAttestation,
  type Attestation,
} from '../src/attest.js';
import { TOTP_PATH, enroll, readConfig } from '../src/owner-totp.js';

function usage(): void {
  console.error('usage: attest.ts <init|enroll <userId>|sign "<statement>" [slug]|status>');
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'init') {
  const { created, publicKey } = initKeys(rest[0] === '--force');
  console.log(created ? 'Generated a new attestation keypair.' : 'Keypair already exists (use --force to replace).');
  console.log(`  private : ${ATTEST_KEY_PATH}  (0600, never mounted)`);
  console.log(`  public  : ${ATTEST_PUB_PATH}  (mounted read-only)`);
  console.log('\n' + publicKey.trim());
} else if (cmd === 'enroll') {
  const userId = rest[0];
  if (!userId) usage();
  const { uri, secretBase32 } = enroll(userId);
  console.log(`Enrolled ${userId}. Secret stored at ${TOTP_PATH} (0600, never mounted).`);
  console.log('\nAdd to your authenticator app with this URI:\n');
  console.log('  ' + uri);
  console.log('\nOr type the secret manually:  ' + secretBase32);
  console.log('\nThen from the chat channel send:  /verify 123456');
} else if (cmd === 'sign') {
  const statement = rest[0];
  if (!statement) usage();
  const { file, attestation } = signAttestation(statement, rest[1]);
  const pub = fs.readFileSync(ATTEST_PUB_PATH, 'utf8');
  console.log(`Signed. self-check=${verifyAttestation(attestation, pub) ? 'VALID' : 'FAILED'}`);
  console.log(`  ${file}`);
} else if (cmd === 'status') {
  const haveKey = fs.existsSync(ATTEST_KEY_PATH);
  const pub = fs.existsSync(ATTEST_PUB_PATH) ? fs.readFileSync(ATTEST_PUB_PATH, 'utf8') : null;
  const totp = readConfig();
  let files: string[] = [];
  try {
    files = fs.readdirSync(ATTESTATIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }

  console.log(`attest key   : ${haveKey ? 'present' : 'MISSING — run init'}`);
  console.log(`public key   : ${pub ? 'present' : 'MISSING'}`);
  console.log(`mount dir    : ${ATTEST_DIR}`);
  console.log(`attestations : ${files.length}`);
  console.log(`owner TOTP   : ${totp ? `enrolled for ${totp.userId} at ${totp.enrolledAt}` : 'NOT enrolled — run enroll'}`);

  for (const f of files.sort().slice(-5)) {
    const a = JSON.parse(fs.readFileSync(`${ATTESTATIONS_DIR}/${f}`, 'utf8')) as Attestation;
    const ok = pub ? verifyAttestation(a, pub) : false;
    console.log(`  ${ok ? 'VALID  ' : 'INVALID'} ${f}  ${a.statement.split('\n')[0].slice(0, 60)}`);
  }
} else {
  usage();
}
