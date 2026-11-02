import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DriveCodec } from './service.js';

export function createDriveCodec(key: string): DriveCodec {
  const bytes = Buffer.from(key, 'base64');
  return {
    seal(value, owner) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', bytes, iv);
      // A saved secret must fail to open if it is copied to another account.
      cipher.setAAD(Buffer.from(owner));
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
    },
    open(value, owner) {
      const data = Buffer.from(value, 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', bytes, data.subarray(0, 12));
      cipher.setAAD(Buffer.from(owner));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}
