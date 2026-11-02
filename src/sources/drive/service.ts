import { createHash, randomBytes } from 'node:crypto';

export const driveScope = 'https://www.googleapis.com/auth/drive.file';

export class DriveError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export type DriveSession = { uid: string; bindingHash: string; verifier: string; expiresAt: number; version: number };
export type DriveConnection = { version: number; token?: string };
export type DriveStore = {
  begin: (state: string, session: Omit<DriveSession, 'version'>) => Promise<void>;
  consume: (state: string, bindingHash: string, now: number) => Promise<DriveSession | null>;
  save: (uid: string, version: number, token: string) => Promise<boolean>;
  read: (uid: string) => Promise<DriveConnection | null>;
  remove: (uid: string) => Promise<DriveConnection | null>;
};
export type DriveOAuth = {
  authorizationUrl: (state: string, challenge: string) => string;
  exchange: (code: string, verifier: string) => Promise<{ refreshToken: string; scope: string }>;
  revoke: (token: string) => Promise<void>;
};
export type DriveCodec = { seal: (value: string, owner: string) => string; open: (value: string, owner: string) => string };
export const hash = (value: string) => createHash('sha256').update(value).digest('base64url');

export function createDriveService({ store, oauth, codec, now = Date.now }: { store: DriveStore; oauth: DriveOAuth; codec: DriveCodec; now?: () => number }) {
  return {
    async authorize(uid: string, binding: string) {
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      await store.begin(state, { uid, bindingHash: hash(binding), verifier: codec.seal(verifier, uid), expiresAt: now() + 600_000 });
      return { authorizationUrl: oauth.authorizationUrl(state, hash(verifier)) };
    },
    async complete(state: string, binding: string, result: { code?: string; error?: string }) {
      const session = await store.consume(state, hash(binding), now());
      if (!session) throw new DriveError(400, 'invalid_oauth_state', 'This connection request is invalid or expired.');
      if (result.error) throw new DriveError(400, 'drive_consent_denied', 'Drive permission was not granted.');
      if (!result.code) throw new DriveError(400, 'invalid_request', 'An authorization code is required.');

      const tokens = await oauth.exchange(result.code, codec.open(session.verifier, session.uid));
      if (!tokens.refreshToken || !tokens.scope.split(/\s+/).includes(driveScope)) {
        throw new DriveError(400, 'drive_permission_required', 'Offline Drive permission is required. Please connect again.');
      }

      const encryptedToken = codec.seal(tokens.refreshToken, session.uid);
      const saved = await store.save(session.uid, session.version, encryptedToken);
      if (!saved) throw new DriveError(409, 'stale_connection', 'This connection request has been replaced.');
    },
    async status(uid: string) {
      return { configured: true as const, connected: Boolean((await store.read(uid))?.token) };
    },
    async disconnect(uid: string) {
      // Remove local access first, even if Google cannot be reached afterward.
      const connection = await store.remove(uid);
      let revocation: 'not_needed' | 'revoked' | 'failed' = 'not_needed';
      if (connection?.token) {
        try {
          await oauth.revoke(codec.open(connection.token, uid));
          revocation = 'revoked';
        } catch {
          revocation = 'failed';
        }
      }
      return { connected: false as const, revocation };
    },
  };
}

export type DriveService = ReturnType<typeof createDriveService>;
