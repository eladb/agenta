import { describe, expect, test } from 'bun:test';
import { generateKeypair } from './keys';

const hasSshKeygen = Bun.which('ssh-keygen') !== null;

describe.skipIf(!hasSshKeygen)('generateKeypair', () => {
  test('produces a usable OpenSSH ed25519 keypair + SHA256 fingerprint', async () => {
    const kp = await generateKeypair();
    expect(kp.private.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true);
    expect(kp.public.startsWith('ssh-ed25519 ')).toBe(true);
    expect(kp.fingerprint.startsWith('SHA256:')).toBe(true);
  });

  test('successive calls produce different keys', async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.public).not.toBe(b.public);
  });
});
