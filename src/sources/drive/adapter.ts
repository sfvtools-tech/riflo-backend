import { DriveError, driveScope, type DriveCodec, type DriveStore } from './service.js';
import { parseDriveFileInput, type DriveFilesGoogle, type DriveFileInput } from './files.js';
import { SourceImportError } from '../../projects/source.js';
import type { SourceAdapter } from '../source.js';
import { legacySourceLimits } from '../../access/source-limits.js';

export function createDriveSourceAccess({ store, codec, google, request = fetch }: {
  store: Pick<DriveStore, 'read'>; codec: DriveCodec; google: DriveFilesGoogle; request?: typeof fetch;
}): Pick<SourceAdapter<DriveFileInput>, 'download'> {
  return {
    async download(uid, value, signal, limits = legacySourceLimits) {
      const input = parseDriveFileInput(value);
      const connection = await store.read(uid);
      if (!connection?.token) throw new SourceImportError('drive_reconnect_required', false);
      let refreshToken: string;
      try { refreshToken = codec.open(connection.token, uid); }
      catch { throw new SourceImportError('drive_reconnect_required', false); }
      let token: Awaited<ReturnType<DriveFilesGoogle['refresh']>>;
      try { token = await google.refresh(refreshToken); }
      catch (error) {
        if (error instanceof DriveError && error.status < 500) throw new SourceImportError(error.code, false);
        throw new SourceImportError('drive_unavailable', true);
      }
      if (!token.accessToken || token.scope.trim() !== driveScope) throw new SourceImportError('drive_reconnect_required', false);
      const current = await store.read(uid);
      if (current?.version !== connection.version || current.token !== connection.token) throw new SourceImportError('drive_reconnect_required', false);
      const headers: Record<string, string> = { Authorization: `Bearer ${token.accessToken}` };
      if (input.resourceKey) headers['X-Goog-Drive-Resource-Keys'] = `${input.fileId}/${input.resourceKey}`;
      let response: Response;
      try {
        response = await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}?alt=media&supportsAllDrives=true`, {
          headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
        });
      } catch { throw new SourceImportError('drive_unavailable', true); }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new SourceImportError('drive_file_unavailable', response.status === 429 || response.status >= 500);
      }
      const length = response.headers.get('content-length');
      if (length && Number(length) > limits.maxSourceBytes) {
        await response.body.cancel().catch(() => undefined);
        throw new SourceImportError('source_too_large', false);
      }
      return {
        // fetch may decode compressed bodies, so encoded Content-Length is not a byte total.
        totalBytes: (!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity') && length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) && Number(length) > 0 ? Number(length) : null,
        body: response.body,
        finished: Promise.resolve(),
        cleanup: async () => { if (!response.body!.locked) await response.body!.cancel().catch(() => undefined); },
      };
    },
  };
}

