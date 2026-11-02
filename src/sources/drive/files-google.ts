import { DriveError, driveScope } from './service.js';
import type { DriveConfig } from './config.js';
import { parseDriveFileInput, type DriveFilesGoogle } from './files.js';

export function createDriveFilesGoogle(config: DriveConfig, request: typeof fetch = fetch): DriveFilesGoogle {
  async function call(url: string, init: RequestInit) {
    try {
      return await request(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: 'error' });
    } catch {
      throw new DriveError(503, 'drive_unavailable', 'Google Drive is temporarily unavailable.');
    }
  }

  async function json(response: Response): Promise<unknown> {
    try { return await response.json(); }
    catch { throw new DriveError(502, 'drive_invalid_response', 'Google returned an invalid response.'); }
  }

  return {
    async refresh(refreshToken) {
      const response = await call('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken, scope: driveScope }),
      });
      if (!response.ok) {
        if (response.status === 400 || response.status === 401) throw new DriveError(409, 'drive_reconnect_required', 'Connect Google Drive again to continue.');
        throw new DriveError(503, 'drive_unavailable', 'Google Drive is temporarily unavailable.');
      }
      const body = await json(response) as Record<string, unknown> | null;
      return {
        accessToken: typeof body?.access_token === 'string' ? body.access_token : '',
        expiresIn: typeof body?.expires_in === 'number' ? body.expires_in : 0,
        scope: typeof body?.scope === 'string' ? body.scope : '',
      };
    },
    async metadata(accessToken, value) {
      const input = parseDriveFileInput(value);
      const fields = 'id,name,mimeType,size,trashed,capabilities(canDownload),videoMediaMetadata(durationMillis)';
      const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(input.fileId)}?${new URLSearchParams({ fields, supportsAllDrives: 'true' })}`;
      const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
      if (input.resourceKey) headers['X-Goog-Drive-Resource-Keys'] = `${input.fileId}/${input.resourceKey}`;
      const response = await call(url, { method: 'GET', headers });
      if (!response.ok) {
        if (response.status === 401) throw new DriveError(409, 'drive_reconnect_required', 'Connect Google Drive again to continue.');
        if (response.status === 403 || response.status === 404) throw new DriveError(404, 'drive_file_unavailable', 'Select an accessible video through Google Picker.');
        throw new DriveError(503, 'drive_unavailable', 'Google Drive is temporarily unavailable.');
      }
      return json(response);
    },
  };
}
