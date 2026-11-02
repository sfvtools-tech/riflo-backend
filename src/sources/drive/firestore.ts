import type { Firestore } from 'firebase-admin/firestore';
import type { DriveConnection, DriveSession, DriveStore } from './service.js';

export function createFirebaseDriveStore(db: Firestore): DriveStore {
  const connections = db.collection('driveConnections');
  const sessions = db.collection('driveOAuthSessions');
  return {
    async begin(state, session) {
      await db.runTransaction(async (transaction) => {
        const ref = connections.doc(session.uid);
        const prior = (await transaction.get(ref)).data() as DriveConnection | undefined;
        const version = (prior?.version ?? 0) + 1;
        // Keep the working connection until the new permission is safely saved.
        transaction.set(ref, { version, ...(prior?.token ? { token: prior.token } : {}) });
        transaction.create(sessions.doc(state), { ...session, version, cleanupAt: new Date(session.expiresAt) });
      });
    },
    async consume(state, bindingHash, now) {
      return db.runTransaction(async (transaction) => {
        const ref = sessions.doc(state);
        const session = (await transaction.get(ref)).data() as DriveSession | undefined;
        if (!session || session.bindingHash !== bindingHash || session.expiresAt <= now) return null;
        const connection = (await transaction.get(connections.doc(session.uid))).data() as DriveConnection | undefined;
        if (connection?.version !== session.version) return null;
        // Reusing the same response must never exchange the code twice.
        transaction.delete(ref);
        return session;
      });
    },
    async save(uid, version, token) {
      return db.runTransaction(async (transaction) => {
        const ref = connections.doc(uid);
        const connection = (await transaction.get(ref)).data() as DriveConnection | undefined;
        // Disconnect or a newer request may have happened while Google was responding.
        if (connection?.version !== version) return false;
        transaction.set(ref, { version, token });
        return true;
      });
    },
    async read(uid) {
      return (await connections.doc(uid).get()).data() as DriveConnection | undefined ?? null;
    },
    async remove(uid) {
      return db.runTransaction(async (transaction) => {
        const ref = connections.doc(uid);
        const prior = (await transaction.get(ref)).data() as DriveConnection | undefined;
        // Keep the new version so an older response cannot reconnect this account.
        transaction.set(ref, { version: (prior?.version ?? 0) + 1 });
        return prior ?? null;
      });
    },
  };
}
