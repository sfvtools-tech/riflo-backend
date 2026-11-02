export type DriveConfig = { clientId: string; clientSecret: string; redirectUri: string; encryptionKey: string; secureCookie: boolean };

export function readDriveConfig(env: NodeJS.ProcessEnv): DriveConfig | undefined {
  const values = [env.GOOGLE_DRIVE_CLIENT_ID, env.GOOGLE_DRIVE_CLIENT_SECRET, env.GOOGLE_DRIVE_REDIRECT_URI, env.DRIVE_TOKEN_ENCRYPTION_KEY];
  if (values.every((value) => !value)) return undefined;
  if (values.some((value) => !value?.trim())) throw new Error('Drive configuration must include all four settings.');

  const [clientId, clientSecret, redirectUri, encryptionKey] = values as [string, string, string, string];
  const uri = new URL(redirectUri);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname) && ['development', 'test'].includes(env.NODE_ENV ?? '');
  if ((uri.protocol !== 'https:' && !(local && uri.protocol === 'http:')) || uri.username || uri.password || uri.search || uri.hash || uri.pathname !== '/v1/drive/connection/callback') {
    throw new Error('Drive callback must use HTTPS and the fixed callback path (local development may use HTTP).');
  }

  if (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey) || Buffer.from(encryptionKey, 'base64').length !== 32) {
    throw new Error('Drive encryption key must be 32 bytes encoded as base64.');
  }
  return { clientId, clientSecret, redirectUri, encryptionKey, secureCookie: uri.protocol === 'https:' };
}
