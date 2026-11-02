import { legacySourceLimits, type SourceLimits } from '../../access/source-limits.js';
import { DriveError, driveScope, type DriveCodec, type DriveStore } from './service.js';

export type DriveFileInput = { fileId: string; resourceKey?: string };
export type DriveFilesGoogle = {
  refresh: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number; scope: string }>;
  metadata: (accessToken: string, input: DriveFileInput) => Promise<unknown>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDriveFileInput(value: unknown): DriveFileInput {
  if (!record(value) || Object.keys(value).some((key) => !['fileId', 'resourceKey'].includes(key)) || typeof value.fileId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.fileId)) {
    throw new DriveError(400, 'invalid_request', 'A valid Drive file ID is required.');
  }
  if (value.resourceKey !== undefined && (typeof value.resourceKey !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.resourceKey))) {
    throw new DriveError(400, 'invalid_request', 'The Drive resource key is invalid.');
  }
  return { fileId: value.fileId, ...(value.resourceKey ? { resourceKey: value.resourceKey as string } : {}) };
}

function positiveInteger(value: unknown) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function createDriveFileService({ store, codec, google, now = Date.now }: {
  store: Pick<DriveStore, 'read'>;
  codec: DriveCodec;
  google: DriveFilesGoogle;
  now?: () => number;
}) {
  async function access(uid: string) {
    const connection = await store.read(uid);
    if (!connection?.token) throw new DriveError(409, 'drive_reconnect_required', 'Connect Google Drive to continue.');
    const token = await google.refresh(codec.open(connection.token, uid));
    if (!token.accessToken || !Number.isSafeInteger(token.expiresIn) || token.expiresIn < 1 || token.expiresIn > 86_400 || token.scope.trim() !== driveScope) {
      throw new DriveError(409, 'drive_reconnect_required', 'Connect Google Drive again with file permission.');
    }
    return { ...token, version: connection.version, encryptedToken: connection.token };
  }

  async function checkConnection(uid: string, original: { version: number; encryptedToken: string }) {
    const current = await store.read(uid);
    // A disconnect during Google's response must not hand out a fresh browser token.
    if (current?.version !== original.version || current.token !== original.encryptedToken) {
      throw new DriveError(409, 'stale_connection', 'The Drive connection changed. Please try again.');
    }
  }

  return {
    async pickerSession(uid: string) {
      const token = await access(uid);
      await checkConnection(uid, token);
      return { accessToken: token.accessToken, expiresAt: new Date(now() + token.expiresIn * 1000).toISOString() };
    },
    async validate(uid: string, value: unknown, limits: SourceLimits = legacySourceLimits) {
      const input = parseDriveFileInput(value);
      const token = await access(uid);
      const metadata = await google.metadata(token.accessToken, input);
      await checkConnection(uid, token);
      if (!record(metadata) || metadata.id !== input.fileId || typeof metadata.name !== 'string' || !metadata.name || metadata.name.length > 4096 || typeof metadata.mimeType !== 'string' || typeof metadata.trashed !== 'boolean' || !record(metadata.capabilities) || typeof metadata.capabilities.canDownload !== 'boolean') {
        throw new DriveError(502, 'drive_invalid_response', 'Google returned incomplete file details.');
      }
      if (metadata.trashed || !metadata.mimeType.startsWith('video/') || !metadata.capabilities.canDownload) {
        throw new DriveError(422, 'unsupported_video', 'Choose a downloadable video that is not in the trash.');
      }
      const bytes = positiveInteger(metadata.size);
      if (bytes === null) throw new DriveError(502, 'drive_invalid_response', 'Google did not provide a valid video size.');
      if (bytes > limits.maxSourceBytes) throw new DriveError(422, 'source_too_large', 'The video exceeds the source size limit.');

      const video = metadata.videoMediaMetadata;
      if (video !== undefined && !record(video)) throw new DriveError(502, 'drive_invalid_response', 'Google returned invalid video details.');
      const duration = record(video) ? video.durationMillis : undefined;
      const durationMillis = duration === undefined ? null : positiveInteger(duration);
      if (duration !== undefined && durationMillis === null) throw new DriveError(502, 'drive_invalid_response', 'Google returned an invalid video duration.');
      if (durationMillis !== null && durationMillis > limits.maxSourceSeconds * 1000) throw new DriveError(422, 'source_too_long', 'The video exceeds the source duration limit.');

      // File details are a pre-check; the imported bytes still need inspection.
      return {
        fileId: input.fileId,
        name: metadata.name,
        mimeType: metadata.mimeType,
        bytes,
        durationSeconds: durationMillis === null ? null : durationMillis / 1000,
        canDownload: true as const,
        requiresProbe: true as const,
      };
    },
  };
}

export type DriveFileService = ReturnType<typeof createDriveFileService>;
