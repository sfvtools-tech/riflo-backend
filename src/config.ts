// Keep public trial intake disabled until retention and abuse release gates are met.
function readSwitch(env: Record<string, string | undefined>, name: string): boolean {
  const value = env[name];
  if (value !== undefined && value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false.`);
  return value === 'true';
}
export const readTrialConfig = (env: Record<string, string | undefined>) => readSwitch(env, 'TRIAL_ENABLED');
export const readRetentionConfig = (env: Record<string, string | undefined>) => readSwitch(env, 'RETENTION_ENABLED');
export function readTrialAbuseKey(env: Record<string, string | undefined>): Buffer | undefined {
  const value = env.TRIAL_ABUSE_HMAC_KEY;
  if (value === undefined) return undefined;
  if (!/^[a-fA-F0-9]{64,}$/.test(value) || value.length % 2) throw new Error('TRIAL_ABUSE_HMAC_KEY must contain at least 32 bytes encoded as hexadecimal.');
  return Buffer.from(value, 'hex');
}
