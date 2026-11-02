import { createCapacity } from "../capacity.js";
import { builtinControls, controlsBodyLimit, controlChoices, generationControlsAvailable, type GenerationDefaultsService } from '../generation/controls.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildCapabilities, type FeatureId } from '../access/policy.js';
import { LifecycleError } from '../access/lifecycle.js';
import { DriveError, type DriveService } from '../sources/drive/service.js';
import type { DriveFileService } from '../sources/drive/files.js';
import { OperationSupersededError, ProjectError, type ProjectService } from '../projects/service.js';
import { applyGenerationConfiguration, generationBodyLimit, type GenerationService } from '../generation/service.js';
import { SourceError, type SourceAccess } from '../sources/source.js';
import { acknowledgeOperation, streamOperation, type Operation, type OperationObserver } from "./operations.js";
import { parseYouTubeLink } from '../sources/youtube.js';
import { BrandError, brandBodyLimit, brandLanguages, brandLimits, type BrandService } from '../brand/service.js';
import type { RequestIdentity } from '../access/trial-abuse.js';
import { parseDriveFileInput } from '../sources/drive/files.js';

export type Dependencies = {
  verifyToken: (token: string) => Promise<RequestIdentity>;
  prepareTrialWork?: (identity: RequestIdentity, sourceIntake?: boolean) => Promise<void>;
  operations?: OperationObserver;
  streamMaxMilliseconds?: number;
  streamMaxActive?: number;
  streamMaxPerAccount?: number;
  streamHeartbeatMilliseconds?: number;
  shutdown?: AbortSignal;
  loadGrant: (uid: string) => Promise<unknown>;
  brand?: BrandService;
  generationDefaults?: GenerationDefaultsService;
  drive?: DriveService;
  driveFiles?: DriveFileService;
  projects?: ProjectService;
  generation?: GenerationService;
  generationConfigured?: boolean;
  readOutputAsset?: (path: string) => Promise<{ body: ReadableStream<Uint8Array>; contentType: string }>;
  implementedFeatures?: readonly FeatureId[];
  sourceAvailability?: SourceAccess['availability'];
  sourceValidation?: SourceAccess['validate'];
  intakeConfigured?: boolean;
  trialEnabled?: boolean;
  driveSecureCookie?: boolean;
  now?: () => Date;
  onError?: (error: unknown) => void;
};

export class AuthenticationError extends ProjectError {
  constructor(message = 'A valid sign-in token is required.') { super(401, 'unauthenticated', message); }
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(JSON.stringify(body));
}

const callbackPath = '/v1/drive/connection/callback';
const connectionPath = '/v1/drive/connection';

function bindingCookie(request: IncomingMessage) {
  const cookies = request.headers.cookie?.split(';').map((cookie) => cookie.trim()).filter((cookie) => cookie.startsWith('riflo_drive_oauth=')) ?? [];
  return cookies.length === 1 ? cookies[0]!.slice('riflo_drive_oauth='.length) : '';
}

async function readJson(request: IncomingMessage, maxBytes = 4096): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    request.resume();
    throw new DriveError(415, 'unsupported_media_type', 'Send a JSON request body.');
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        chunks.length = 0;
        reject(new DriveError(413, 'request_too_large', 'The request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (bytes > maxBytes) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new DriveError(400, 'invalid_request', 'Send a valid JSON request body.')); }
    });
    request.on('error', () => reject(new DriveError(400, 'invalid_request', 'The request body could not be read.')));
    request.on('aborted', () => reject(new DriveError(400, 'invalid_request', 'The request was interrupted.')));
  });
}

export function createHandler(dependencies: Dependencies): RequestListener {
  const acquireStream = createCapacity(dependencies.streamMaxActive ?? 100, dependencies.streamMaxPerAccount ?? 5);
  for (const value of [dependencies.streamMaxMilliseconds, dependencies.streamHeartbeatMilliseconds]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) throw new Error("Stream durations must be positive timer-safe milliseconds.");
  }
  return async (request, response) => {
    let streamReservation: (() => void) | undefined;
    const validation = new AbortController();
    const disconnect = () => validation.abort();
    response.once('close', disconnect);
    const validationSignal = dependencies.shutdown ? AbortSignal.any([validation.signal, dependencies.shutdown]) : validation.signal;
    const fail = (status: number, code: string, message: string, allowance?: ProjectError['allowance'], retryAfterSeconds?: number) => {
      if (status === 401 && code === 'unauthenticated') response.setHeader('WWW-Authenticate', 'Bearer');
      send(response, status, { error: { code, message, ...(allowance ? { allowance } : {}), ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } });
    };
    const cookie = (binding: string, maxAge: number) => `riflo_drive_oauth=${binding}; HttpOnly; SameSite=Lax; Path=${callbackPath}; Max-Age=${maxAge}${dependencies.driveSecureCookie !== false ? '; Secure' : ''}`;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const assetMatch = /^\/v1\/projects\/([A-Za-z0-9_-]{1,128})\/outputs\/([A-Za-z0-9_-]{1,128})\/assets\/([A-Za-z0-9_-]{1,128})\/download$/.exec(url.pathname);
      const generationMatch = /^\/v1\/projects\/([A-Za-z0-9_-]{1,128})\/(generate|generation|outputs)(?:\/([A-Za-z0-9_-]{1,128})(\/download)?)?$/.exec(url.pathname);
      const operationMatch = /^\/v1\/projects\/([A-Za-z0-9_-]{1,128})\/operations\/(import|generation)\/([A-Za-z0-9_-]{1,128})\/events$/.exec(url.pathname);
      const retryMatch = /^\/v1\/projects\/([A-Za-z0-9_-]{1,128})\/retry-import$/.exec(url.pathname);
      const restoreMatch = /^\/v1\/projects\/([A-Za-z0-9_-]{1,128})\/restore-source$/.exec(url.pathname);
      const transcriptionRetryMatch = /^\/v1\/projects\/([A-Za-z0-9_-]{1,128})\/retry-transcription$/.exec(url.pathname);
      const projectMatch = /^\/v1\/projects\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
      const methods: Record<string, string[]> = {
        '/health': ['GET'],
        '/v1/capabilities': ['GET'],
        '/v1/brand': ['GET', 'PUT'],
        '/v1/generation-defaults': ['GET', 'PUT'],
        [connectionPath]: ['GET', 'DELETE'],
        [`${connectionPath}/authorize`]: ['POST'],
        [callbackPath]: ['GET'],
        '/v1/drive/picker-session': ['GET'],
        '/v1/drive/files/validate': ['POST'],
        '/v1/sources/youtube/validate': ['POST'],
        '/v1/projects': ['GET', 'POST'],
        '/v1/usage': ['GET'],
      };

      const allowed = operationMatch ? ["GET"] : retryMatch || restoreMatch || transcriptionRetryMatch ? ['POST'] : assetMatch ? ['GET'] : generationMatch ? (generationMatch[2] === 'generate' && !generationMatch[3] ? ['POST'] : ['GET']) : projectMatch ? ['GET', 'DELETE'] : methods[url.pathname];
      if (!allowed) return fail(404, 'not_found', 'Endpoint not found.');
      if (!allowed.includes(request.method ?? '')) {
        response.setHeader('Allow', allowed.join(', '));
        return fail(405, 'method_not_allowed', `Use ${allowed.join(' or ')} for this endpoint.`);
      }

      if (url.pathname === callbackPath) {
        if (!dependencies.drive) return fail(503, 'drive_not_configured', 'Drive connection is not configured.');

        const state = url.searchParams.get('state');
        const binding = bindingCookie(request);
        const code = url.searchParams.get('code') ?? undefined;
        const error = url.searchParams.get('error') ?? undefined;
        const validState = state !== null && /^[A-Za-z0-9_-]{43}$/.test(state);
        const validBinding = /^[A-Za-z0-9_-]{43}$/.test(binding);
        const duplicateParameters = ['state', 'code', 'error'].some((key) => url.searchParams.getAll(key).length > 1);
        const invalidResult = (code && code.length > 4096) || Boolean(code) === Boolean(error);
        if (!validState || !validBinding || duplicateParameters || invalidResult) {
          return fail(400, 'invalid_request', 'This connection response is invalid.');
        }

        // Google returns without a Firebase token; the saved request and browser cookie prove ownership.
        await dependencies.drive.complete(state, binding, { code, error });
        response.setHeader('Set-Cookie', cookie('', 0));
        return send(response, 200, { data: { connected: true } });
      }
      if (url.search) return fail(400, 'invalid_request', 'Query parameters are not supported.');
      if (url.pathname === '/health') return send(response, 200, { data: { status: 'ok' } });

      const authorization = request.headers.authorization;
      const token = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] : undefined;
      if (!token) return fail(401, 'unauthenticated', 'A valid sign-in token is required.');

      const identity = await dependencies.verifyToken(token);
      if (!identity.uid || identity.uid.includes('/')) return fail(401, 'unauthenticated', 'A valid sign-in token is required.');
      const wantsStream = request.headers.accept?.split(",").some(value => value.trim().split(";")[0] === "text/event-stream") ?? false;
      const reserveStream = () => {
        if (!wantsStream || streamReservation) return;
        const release = acquireStream(identity.uid);
        if (typeof release === 'number') throw new ProjectError(release, "observation_busy", "Progress observation is busy. Try again shortly.", 5);
        streamReservation = release;
      };
      const observe = async (operation: Operation, accepted: boolean) => {
        if (!dependencies.operations) throw new ProjectError(503, "observation_unavailable", "Progress observation is unavailable.");
        const release = streamReservation ?? acquireStream(identity.uid);
        if (typeof release === 'number') {
          if (accepted) return acknowledgeOperation(response, operation, "observation_busy");
          throw new ProjectError(release, "observation_busy", "Progress observation is busy. Try again shortly.", 5);
        }
        try {
          await dependencies.operations.check(identity.uid, operation);
          if (identity.exp !== undefined && identity.exp * 1000 <= Date.now()) throw new AuthenticationError();
          await streamOperation(request, response, { observer: dependencies.operations, uid: identity.uid, operation, accepted,
            verify: async () => {
              const current = await dependencies.verifyToken(token);
              if (current.uid !== identity.uid) throw new AuthenticationError();
            }, expiresAt: identity.exp === undefined ? undefined : identity.exp * 1000,
            maxMilliseconds: dependencies.streamMaxMilliseconds ?? 300_000, heartbeatMilliseconds: dependencies.streamHeartbeatMilliseconds,
            shutdown: dependencies.shutdown, onError: dependencies.onError });
        } finally { release(); }
      };
      if (operationMatch) return await observe({ projectId: operationMatch[1]!, kind: operationMatch[2] as Operation["kind"], id: operationMatch[3]! }, false);
      if (wantsStream && request.method === "POST" && !dependencies.operations) return fail(503, "observation_unavailable", "Progress observation is unavailable.");
      if (url.pathname === '/v1/capabilities') {
        const access = buildCapabilities(await dependencies.loadGrant(identity.uid), dependencies.now?.(), dependencies.implementedFeatures, dependencies.trialEnabled);
        return send(response, 200, {
          data: {
            ...access,
            brand: { available: Boolean(dependencies.brand) && access.subscription.active, languages: brandLanguages, limits: brandLimits },
            services: {
              drive: { configured: Boolean(dependencies.drive && dependencies.driveFiles) },
              intake: { configured: dependencies.intakeConfigured ?? Boolean(dependencies.projects) },
              sources: dependencies.sourceAvailability ?? { drive: { configured: Boolean(dependencies.driveFiles) }, youtube: { configured: false } },
              generation: { configured: dependencies.generationConfigured ?? Boolean(dependencies.generation) },
            },
          },
        });
      }

      if (url.pathname === '/v1/generation-defaults') {
        const defaults = dependencies.generationDefaults;
        if (!defaults) return fail(503, 'generation_defaults_unavailable', 'Generation defaults are temporarily unavailable.');
        if (request.method === 'PUT' && !buildCapabilities(await dependencies.loadGrant(identity.uid), dependencies.now?.(), undefined, dependencies.trialEnabled).subscription.active) {
          return fail(403, 'subscription_required', 'Active access is required to update generation defaults.');
        }
        const result = request.method === 'PUT' ? await defaults.replace(identity.uid, await readJson(request, controlsBodyLimit)) : await defaults.get(identity.uid);
        return send(response, 200, { data: { defaults: result, controls: { version: 1, available: generationControlsAvailable, choices: controlChoices, builtins: builtinControls } } });
      }

      if (url.pathname === '/v1/brand') {
        const brand = dependencies.brand;
        if (!brand) return fail(503, 'brand_unavailable', 'Brand settings are temporarily unavailable.');
        if (request.method === 'PUT' && !buildCapabilities(await dependencies.loadGrant(identity.uid), dependencies.now?.(), undefined, dependencies.trialEnabled).subscription.active) {
          return fail(403, 'subscription_required', 'Active access is required to update brand settings.');
        }
        const result = request.method === 'PUT'
          ? await brand.replace(identity.uid, await readJson(request, brandBodyLimit))
          : await brand.get(identity.uid);
        return send(response, 200, { data: result });
      }

      if (assetMatch) {
        if (!dependencies.generation || !dependencies.readOutputAsset) return fail(503, 'generation_not_configured', 'Output storage is not configured.');
        const asset = await dependencies.generation.asset(identity.uid, assetMatch[1]!, assetMatch[2]!, assetMatch[3]!);
        const file = await dependencies.readOutputAsset(asset.storagePath);
        response.writeHead(200, { 'Content-Type': asset.contentType, 'Content-Disposition': `attachment; filename="${asset.id}.${asset.contentType === 'video/mp4' ? 'mp4' : 'png'}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        try { await pipeline(Readable.fromWeb(file.body as never), response); }
        catch { response.destroy(); }
        return;
      }

      if (transcriptionRetryMatch) {
        if (!dependencies.generation) return fail(503, 'generation_not_configured', 'Transcription is not configured.');
        const body = request.headers['content-length'] === '0' || (!request.headers['content-length'] && !request.headers['transfer-encoding']) ? {} : await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return fail(400, 'invalid_request', 'Retry transcription does not accept settings or output selections.');
        const key = request.headers['idempotency-key'];
        const projectId = transcriptionRetryMatch[1]!;
        const result = await dependencies.generation.retryTranscription(identity.uid, projectId, typeof key === 'string' ? key : '', async () => {
          reserveStream();
          if (dependencies.generationConfigured === false) throw new ProjectError(503, 'generation_not_configured', 'Transcription is not configured.');
          const access = buildCapabilities(await dependencies.loadGrant(identity.uid), dependencies.now?.(), undefined, dependencies.trialEnabled);
          if (!access.subscription.active) throw new ProjectError(403, 'subscription_required', 'An active subscription is required.');
          await dependencies.prepareTrialWork?.(identity);
        });
        if (wantsStream) return await observe({ projectId, kind: 'generation', id: result.id }, true);
        return send(response, result.status === 'completed' ? 200 : 202, { data: result });
      }

      if (generationMatch) {
        const generation = dependencies.generation;
        if (!generation) return fail(503, 'generation_not_configured', 'Generation is not configured.');
        const [, projectId, action, outputId, download] = generationMatch;
        if ((action !== 'outputs' && outputId && !(action === 'generation' && outputId === 'availability' && !download)) || (action === 'generate' && outputId)) return fail(404, 'not_found', 'Endpoint not found.');
        let result;
        if (action === 'generate') {
          const key = request.headers['idempotency-key'];
          result = await generation.start(identity.uid, projectId!, await readJson(request, generationBodyLimit), typeof key === 'string' ? key : '', async () => {
            reserveStream();
            if (dependencies.generationConfigured === false) throw new ProjectError(503, 'generation_not_configured', 'Generation is not configured.');
            const access = buildCapabilities(await dependencies.loadGrant(identity.uid), dependencies.now?.(), undefined, dependencies.trialEnabled);
            if (!access.subscription.active) throw new ProjectError(403, 'subscription_required', 'An active subscription is required.');
            await dependencies.prepareTrialWork?.(identity);
          });
          if (wantsStream) return await observe({ projectId: projectId!, kind: 'generation', id: result.id }, true);
        } else if (action === 'generation' && outputId === 'availability') {
          const availability = applyGenerationConfiguration(await generation.availability(identity.uid, projectId!), {
            configured: dependencies.generationConfigured !== false, implementedFeatures: dependencies.implementedFeatures ?? [],
          });
          const { audience, voice, language, spelling } = brandLimits;
          result = { ...availability, preferences: { languages: brandLanguages, limits: { audience, voice, language, spelling } } };
        } else if (action === 'generation') result = await generation.get(identity.uid, projectId!);
        else if (outputId) result = await generation.output(identity.uid, projectId!, outputId);
        else result = await generation.outputs(identity.uid, projectId!);
        if (download && result && 'text' in result) {
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${outputId}.txt"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return response.end(result.text);
        }
        return send(response, action === 'generate' ? 202 : 200, { data: result });
      }

      if (url.pathname === '/v1/projects' || projectMatch || retryMatch || restoreMatch || url.pathname === '/v1/usage') {
        const projects = dependencies.projects;
        if (!projects) return fail(503, 'intake_not_configured', 'Video intake is not configured.');
        let result: unknown;
        if (restoreMatch) {
          const key = request.headers['idempotency-key'];
          result = await projects.restoreSource(identity.uid, restoreMatch[1]!, typeof key === 'string' ? key : '', async () => {
            reserveStream();
            if (dependencies.intakeConfigured === false) throw new ProjectError(503, 'intake_not_configured', 'Video intake is not configured.');
            const access = buildCapabilities(await dependencies.loadGrant(identity.uid), dependencies.now?.(), undefined, dependencies.trialEnabled);
            if (!access.subscription.active) throw new ProjectError(403, 'subscription_required', 'An active subscription is required.');
          }, identity, validationSignal);
        } else if (retryMatch) {
          const key = request.headers['idempotency-key'];
          result = await projects.retry(identity.uid, retryMatch[1]!, typeof key === 'string' ? key : '', async () => {
            reserveStream();
            if (dependencies.intakeConfigured === false) throw new ProjectError(503, 'intake_not_configured', 'Video intake is not configured.');
            const access = buildCapabilities(await dependencies.loadGrant(identity.uid), dependencies.now?.(), undefined, dependencies.trialEnabled);
            if (!access.subscription.active) throw new ProjectError(403, 'subscription_required', 'An active subscription is required.');
          }, identity, validationSignal);
        } else if (projectMatch) {
          result = request.method === 'DELETE'
            ? await projects.remove(identity.uid, projectMatch[1]!)
            : await projects.get(identity.uid, projectMatch[1]!);
        } else if (url.pathname === '/v1/usage') {
          result = await projects.usage(identity.uid);
        } else if (request.method === 'GET') {
          result = await projects.list(identity.uid);
        } else {
          const key = request.headers['idempotency-key'];
          result = await projects.create(identity.uid, await readJson(request), typeof key === 'string' ? key : '', async () => {
            reserveStream();
            if (dependencies.intakeConfigured === false) throw new ProjectError(503, 'intake_not_configured', 'Video intake is not configured.');
            const access = buildCapabilities(await dependencies.loadGrant(identity.uid), dependencies.now?.(), undefined, dependencies.trialEnabled);
            if (!access.subscription.active && !access.intake?.available) throw new ProjectError(403, 'subscription_required', 'An active subscription is required.');
          }, identity, validationSignal);
        }
        if (wantsStream && request.method === 'POST') {
          const project = result as { id: string; importOperationId?: string | null };
          if (!project.importOperationId) return fail(409, 'legacy_observation_unavailable', 'This legacy import has no operation identity. Read saved project state.');
          return await observe({ projectId: project.id, kind: 'import', id: project.importOperationId }, true);
        }
        return send(response, request.method === 'POST' ? 202 : 200, { data: result });
      }

      if (url.pathname === '/v1/sources/youtube/validate') {
        const access = buildCapabilities(await dependencies.loadGrant(identity.uid), dependencies.now?.(), undefined, dependencies.trialEnabled);
        if (!access.subscription.active && !access.intake?.available) return fail(403, 'subscription_required', 'An active subscription is required.');
        const value = await readJson(request);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'url') || !('url' in value) || typeof value.url !== 'string') {
          return fail(400, 'invalid_request', 'Provide one YouTube video URL.');
        }
        const input = parseYouTubeLink(value.url);
        if (!dependencies.sourceValidation) return fail(503, 'source_not_configured', 'YouTube importing is awaiting setup.');
        if (dependencies.sourceAvailability?.youtube.configured === false) return fail(503, 'source_not_configured', 'YouTube importing is awaiting setup.');
        await dependencies.prepareTrialWork?.(identity, true);
        const source = await dependencies.sourceValidation(identity.uid, input, access.operationalLimits, validationSignal);
        return send(response, 200, { data: { input, source } });
      }

      if (url.pathname === '/v1/drive/picker-session' || url.pathname === '/v1/drive/files/validate') {
        if (!dependencies.driveFiles) return fail(503, 'drive_not_configured', 'Drive connection is not configured.');
        const access = buildCapabilities(await dependencies.loadGrant(identity.uid), dependencies.now?.(), undefined, dependencies.trialEnabled);
        if (!access.subscription.active && !access.intake?.available) return fail(403, 'subscription_required', 'An active subscription is required.');

        const value = url.pathname === '/v1/drive/files/validate' ? parseDriveFileInput(await readJson(request)) : undefined;
        await dependencies.prepareTrialWork?.(identity, true);
        const result = url.pathname === '/v1/drive/picker-session'
          ? await dependencies.driveFiles.pickerSession(identity.uid)
          : await dependencies.driveFiles.validate(identity.uid, value, access.operationalLimits);
        return send(response, 200, { data: result });
      }

      if (!dependencies.drive) {
        if (request.method === 'GET') return send(response, 200, { data: { configured: false, connected: false } });
        return fail(503, 'drive_not_configured', 'Drive connection is not configured.');
      }
      if (url.pathname === connectionPath) {
        // Expired subscribers must still be able to remove their Google permission.
        const result = request.method === 'DELETE'
          ? await dependencies.drive.disconnect(identity.uid)
          : await dependencies.drive.status(identity.uid);
        return send(response, 200, { data: result });
      }

      const access = buildCapabilities(await dependencies.loadGrant(identity.uid), dependencies.now?.(), undefined, dependencies.trialEnabled);
      if (!access.subscription.active && !access.intake?.available) return fail(403, 'subscription_required', 'An active subscription is required.');

      await dependencies.prepareTrialWork?.(identity, true);

      const binding = randomBytes(32).toString('base64url');
      const result = await dependencies.drive.authorize(identity.uid, binding);
      response.setHeader('Set-Cookie', cookie(binding, 600));
      send(response, 200, { data: result });
    } catch (error) {
      if (error instanceof AuthenticationError) return fail(401, 'unauthenticated', 'A valid sign-in token is required.');
      if (error instanceof OperationSupersededError) return send(response, error.status, { error: { code: error.code, message: error.message, accepted: true, operation: error.operation } });
      if ((error instanceof ProjectError || error instanceof SourceError) && error.retryAfterSeconds) response.setHeader('Retry-After', String(error.retryAfterSeconds));
      if (error instanceof ProjectError || error instanceof SourceError) return fail(error.status, error.code, error.message, error instanceof ProjectError ? error.allowance : undefined, error.retryAfterSeconds);
      if (error instanceof DriveError || error instanceof BrandError || error instanceof LifecycleError) return fail(error.status, error.code, error.message);
      dependencies.onError?.(error);
      fail(503, 'service_unavailable', 'The service is temporarily unavailable.');
    } finally {
      streamReservation?.();
      response.off('close', disconnect);
    }
  };
}
