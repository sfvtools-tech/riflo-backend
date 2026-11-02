export type BrandProfile = {
  name?: string;
  description?: string;
  audience?: string;
  voice?: string;
  language?: string;
  spelling?: string;
  writingExample?: string;
  avoidPhrases?: string[];
  colours?: string[];
  fonts?: string[];
};

export type BrandStore = {
  read: (uid: string) => Promise<BrandProfile | null>;
  save: (uid: string, profile: BrandProfile) => Promise<void>;
};

export class BrandError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export const brandLanguages = ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Hindi'] as const;

export const brandLimits = {
  name: 120, description: 2000, audience: 1000, voice: 1000,
  language: 80, spelling: 80, writingExample: 8000,
  avoidPhrases: { count: 30, length: 120 },
  colours: { count: 8, length: 7 },
  fonts: { count: 5, length: 100 },
} as const;

// JSON can encode one string character as six bytes (\\uXXXX), including field names.
export const brandBodyLimit = 2 + Object.entries(brandLimits).reduce((bytes, [field, limit]) => {
  const valueBytes = typeof limit === 'number' ? limit * 6 + 2 : 2 + limit.count * (limit.length * 6 + 3);
  return bytes + field.length * 6 + 4 + valueBytes;
}, 0);

function invalid(field?: string): never {
  throw new BrandError(400, 'invalid_request', field ? `Check the brand setting: ${field}.` : 'Send a brand profile with supported settings.');
}

function text(value: unknown, length: number, field: string, multiline = false) {
  if (typeof value !== 'string' || value.length > length || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) || (!multiline && /[\t\r\n]/u.test(value))) invalid(field);
  return value.trim();
}

export function parseBrandProfile(input: unknown): BrandProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const result: Record<string, string | string[]> = {};
  for (const [field, value] of Object.entries(input)) {
    if (!Object.hasOwn(brandLimits, field)) invalid();
    const limit = brandLimits[field as keyof typeof brandLimits];
    if (typeof limit === 'number') {
      const cleaned = text(value, limit, field, ['description', 'audience', 'voice', 'writingExample'].includes(field));
      if (cleaned) result[field] = cleaned;
    } else {
      if (!Array.isArray(value) || value.length > limit.count) invalid(field);
      result[field] = value.map(item => {
        const cleaned = text(item, limit.length, field);
        if (!cleaned || (field === 'colours' && !/^#[0-9a-f]{6}$/i.test(cleaned))) invalid(field);
        return cleaned;
      });
    }
  }
  return result;
}

export function createBrandService(store: BrandStore) {
  return {
    async get(uid: string) {
      const saved = await store.read(uid);
      if (saved === null) return null;
      // Only profile settings belong in the response, even if storage gains private fields.
      const profile = Object.fromEntries(Object.entries(saved).filter(([key]) => Object.hasOwn(brandLimits, key)));
      try { return parseBrandProfile(profile); }
      catch { throw new BrandError(503, 'brand_unavailable', 'Your brand settings are temporarily unavailable.'); }
    },
    async replace(uid: string, input: unknown) {
      const profile = parseBrandProfile(input);
      await store.save(uid, profile);
      return profile;
    },
  };
}

export type BrandService = ReturnType<typeof createBrandService>;
