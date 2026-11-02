import { DriveError, driveScope, type DriveOAuth } from './service.js';
import type { DriveConfig } from './config.js';

export function createDriveOAuth(config: DriveConfig, request: typeof fetch = fetch): DriveOAuth {
  async function post(url: string, body: URLSearchParams) {
    try {
      return await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
        // A redirect must not forward credentials to a different destination.
        redirect: 'error',
      });
    } catch {
      throw new DriveError(503, 'drive_unavailable', 'Google Drive is temporarily unavailable.');
    }
  }

  return {
    authorizationUrl(state, challenge) {
      const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: driveScope, access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' });
      return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
    },
    async exchange(code, verifier) {
      const response = await post('https://oauth2.googleapis.com/token', new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code', code, code_verifier: verifier }));
      if (!response.ok) throw new DriveError(response.status >= 500 ? 503 : 400, 'drive_authorization_failed', 'Google could not complete this connection. Please try again.');

      let body: Record<string, unknown>;
      try {
        body = await response.json() as Record<string, unknown>;
      } catch {
        throw new DriveError(503, 'drive_unavailable', 'Google Drive is temporarily unavailable.');
      }
      return { refreshToken: typeof body?.refresh_token === 'string' ? body.refresh_token : '', scope: typeof body?.scope === 'string' ? body.scope : '' };
    },
    async revoke(token) {
      const response = await post('https://oauth2.googleapis.com/revoke', new URLSearchParams({ token }));
      if (!response.ok) throw new DriveError(503, 'drive_revocation_failed', 'Google permission could not be revoked.');
    },
  };
}
