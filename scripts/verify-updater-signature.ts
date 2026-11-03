/*
 * Checks a Tauri updater artifact's .sig against the app's pubkey, PR_QUEST_UPDATER_PUBKEY in a
 * release build and src-tauri/tauri.conf.json's otherwise, as tauri-plugin-updater does before it
 * installs an update (minisign, prehashed Ed25519). A release job runs it before publishing, so
 * a wrong key never reaches users.
 *
 *   node scripts/verify-updater-signature.ts <artifact> [artifact.sig]
 */
import { createPublicKey, hash, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const ConfigSchema = z.object({ plugins: z.object({ updater: z.object({ pubkey: z.string() }) }) });
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const [artifact, sigFile = `${artifact}.sig`] = process.argv.slice(2);
if (artifact === undefined) {
  throw new Error('Usage: node scripts/verify-updater-signature.ts <artifact> [artifact.sig]');
}

/** The base64 payload line of a minisign key or signature file, after its comment line. */
function payload(text: string, line: number): Buffer {
  const value = text.split('\n')[line];
  if (value === undefined) {
    throw new Error('Not a minisign file');
  }
  return Buffer.from(value, 'base64');
}

const pubkey =
  process.env.PR_QUEST_UPDATER_PUBKEY ??
  ConfigSchema.parse(JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))).plugins.updater
    .pubkey;
const keyText = Buffer.from(pubkey, 'base64').toString('utf8');
const key = payload(keyText, 1);
const sigText = Buffer.from(readFileSync(sigFile, 'utf8'), 'base64').toString('utf8');
const signature = payload(sigText, 1);
const trustedComment = sigText.split('\n')[2]?.replace(/^trusted comment: /, '') ?? '';
const globalSignature = payload(sigText, 3);

if (key.subarray(0, 2).toString() !== 'Ed' || signature.subarray(0, 2).toString() !== 'ED') {
  throw new Error('Expected an Ed25519 key and a prehashed (ED) signature');
}
if (!key.subarray(2, 10).equals(signature.subarray(2, 10))) {
  throw new Error("The signature was made with another key than the app's pubkey");
}
const publicKey = createPublicKey({
  key: Buffer.concat([ED25519_SPKI_PREFIX, key.subarray(10)]),
  format: 'der',
  type: 'spki',
});
const digest = hash('blake2b512', readFileSync(artifact), 'buffer');
const fileSignature = signature.subarray(10);
if (!verify(null, digest, publicKey, fileSignature)) {
  throw new Error(`${artifact} doesn't match its signature`);
}
if (
  !verify(
    null,
    Buffer.concat([fileSignature, Buffer.from(trustedComment)]),
    publicKey,
    globalSignature,
  )
) {
  throw new Error(`The trusted comment in ${sigFile} was changed`);
}
process.stdout.write(`${artifact}: signature valid (${trustedComment})\n`);
