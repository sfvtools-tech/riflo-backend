import { createGenerationDefaultsService, createGenerationDefaultsStore } from './generation/controls.js';
import { resolveSourceLimits } from './access/source-limits.js';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readStorageFile } from './storage/read.js';
import { boundedStorageBucket } from './storage/delete.js';
import { AuthenticationError, type Dependencies } from './http/app.js';
import { firestoreOperations } from './http/operations.js';
import { createDriveService } from './sources/drive/service.js';
import { createDriveCodec } from './sources/drive/tokens.js';
import { createDriveOAuth } from './sources/drive/google.js';
import type { DriveConfig } from './sources/drive/config.js';
import { createFirebaseDriveStore } from './sources/drive/firestore.js';
import { createDriveFileService } from './sources/drive/files.js';
import { createDriveFilesGoogle } from './sources/drive/files-google.js';
import { createProjectService } from './projects/service.js';
import { createProjectStore } from './projects/firestore.js';
import { createIntakeWorker } from './projects/worker.js';
import { createSourceImporter, SourceImportError } from './projects/source.js';
import { createSourceStorage, createSourcePreparer } from './projects/adapters.js';
import { createDriveSourceAccess } from './sources/drive/adapter.js';
import { createGenerationStore } from './generation/firestore.js';
import { createGenerationService, generationFeatures, GenerationError } from './generation/service.js';
import { createGenerationProviders } from './generation/providers.js';
import { createGenerationWorker } from './generation/worker.js';
import { createAudioExtractor } from './generation/audio.js';
import type { GenerationConfig } from './generation/config.js';
import { createVideoRenderer } from './generation/video.js';
import { createCarouselRenderer } from './generation/carousel.js';
import { createOutputStorage } from './generation/assets.js';
import { createSourceAccess, SourceError } from './sources/source.js';
import { createYouTubeSource, type YouTubeConfig } from './sources/youtube.js';
import { createBrandService } from './brand/service.js';
import { createBrandStore } from './brand/firestore.js';
import { createLifecycleStore } from './access/lifecycle-firestore.js';
import { resolveAccess } from './access/lifecycle.js';
import { createTrialAbuseStore, trialSubjectKey } from './access/trial-abuse.js';

function createFirebaseSources(database: () => ReturnType<typeof getFirestore>, driveConfig?: DriveConfig, youtubeConfig?: YouTubeConfig) {
  const drive = driveConfig ? {
    store: { read: (uid: string) => createFirebaseDriveStore(database()).read(uid) },
    codec: createDriveCodec(driveConfig.encryptionKey),
    google: createDriveFilesGoogle(driveConfig),
  } : undefined;
  return createSourceAccess({
    ...(youtubeConfig ? { youtube: createYouTubeSource(youtubeConfig) } : {}),
    ...(drive ? { drive: {
      validate: createDriveFileService(drive).validate,
      ...createDriveSourceAccess(drive),
    } } : {}),
  });
}

export function createFirebaseDependencies(projectId: string, driveConfig?: DriveConfig, storageBucket?: string, generationConfig?: GenerationConfig, youtubeConfig?: YouTubeConfig, trialEnabled = false, retentionEnabled = false, trialAbuseKey?: Buffer): Dependencies {
  let services: { auth: ReturnType<typeof getAuth>; db: ReturnType<typeof getFirestore> } | undefined;

  // Public health checks do not need credentials or a database connection.
  function firebase() {
    if (!services) {
      const app = initializeApp({ projectId, credential: applicationDefault() }, 'riflo-backend');
      services = { auth: getAuth(app), db: getFirestore(app) };
    }
    return services;
  }

  const drive = driveConfig ? createDriveService({
    store: {
      begin: (...args) => createFirebaseDriveStore(firebase().db).begin(...args),
      consume: (...args) => createFirebaseDriveStore(firebase().db).consume(...args),
      save: (...args) => createFirebaseDriveStore(firebase().db).save(...args),
      read: (...args) => createFirebaseDriveStore(firebase().db).read(...args),
      remove: (...args) => createFirebaseDriveStore(firebase().db).remove(...args),
    },
    oauth: createDriveOAuth(driveConfig),
    codec: createDriveCodec(driveConfig.encryptionKey),
  }) : undefined;

  const driveFiles = driveConfig ? createDriveFileService({
    store: { read: (...args) => createFirebaseDriveStore(firebase().db).read(...args) },
    codec: createDriveCodec(driveConfig.encryptionKey),
    google: createDriveFilesGoogle(driveConfig),
  }) : undefined;

  const sources = createFirebaseSources(() => firebase().db, driveConfig, youtubeConfig);

  return {
    get generationDefaults() { return createGenerationDefaultsService(createGenerationDefaultsStore(firebase().db)); },
    get brand() { return createBrandService(createBrandStore(firebase().db)); },
    get operations() { return firestoreOperations(firebase().db); },
    trialEnabled,
    async prepareTrialWork(identity, sourceIntake) {
      if (sourceIntake) await createProjectStore(firebase().db).preflight?.(identity.uid, Date.now());
      await createTrialAbuseStore(firebase().db, trialAbuseKey).prepare(identity, Date.now(), !sourceIntake);
    },
    sourceAvailability: sources.availability,
    sourceValidation: sources.validate,
    intakeConfigured: Boolean(storageBucket && Object.values(sources.availability).some(source => source.configured)),
    implementedFeatures: generationConfig && storageBucket ? generationFeatures : [],
    generationConfigured: Boolean(generationConfig && storageBucket),
    get generation() {
      return createGenerationService({ readDefaults: uid => createGenerationDefaultsService(createGenerationDefaultsStore(firebase().db)).get(uid), readBrand: uid => createBrandService(createBrandStore(firebase().db)).get(uid), store: createGenerationStore(firebase().db, storageBucket ? createOutputStorage(firebase().auth.app, storageBucket) : undefined), processingConfigured: Boolean(generationConfig && storageBucket) });
    },
    async readOutputAsset(path) {
      if (!storageBucket) throw new Error('Output storage is not configured.');
      return createOutputStorage(firebase().auth.app, storageBucket).read(path);
    },
    get projects() {
      return createProjectService({
        store: createProjectStore(firebase().db),
        beforeValidateSource: async (uid, input, identity) => {
          if (identity && identity.uid !== uid) throw new AuthenticationError();
          if (!storageBucket) throw new SourceError(503, 'intake_not_configured', 'Video storage is awaiting setup.');
          const source = 'source' in input ? input.source : 'drive';
          if (!sources.availability[source].configured) throw new SourceError(503, 'source_not_configured', 'This video source is awaiting setup.');
          const raw = await createLifecycleStore(firebase().db).get(uid);
          if (!trialEnabled && resolveAccess(raw, Date.now()).lifecycle?.trial.state === 'eligible') return;
          await createTrialAbuseStore(firebase().db, trialAbuseKey).prepare(identity ?? { uid }, Date.now(), true);
        },
        ...(trialEnabled ? { startTrial: async (uid, now, _input, identity) => {
          const lifecycle = createLifecycleStore(firebase().db, { retentionEnabled });
          const raw = await lifecycle.get(uid);
          // Legacy/manual and paid accounts never acquire an automatic trial.
          if (resolveAccess(raw, now).lifecycle?.trial.state === 'eligible') await lifecycle.startTrial(uid, now, trialSubjectKey(identity ?? { uid }, trialAbuseKey));
        } } : {}),
        validateSource: async (uid, input, signal) => {
          if (!storageBucket) throw new SourceError(503, 'intake_not_configured', 'Video storage is awaiting setup.');
          return sources.validate(uid, input, resolveSourceLimits(await createLifecycleStore(firebase().db).get(uid), Date.now()), signal);
        },
      });
    },
    drive,
    driveFiles,
    driveSecureCookie: driveConfig?.secureCookie,
    async verifyToken(token) {
      try {
        return await firebase().auth.verifyIdToken(token, true);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code && ['auth/argument-error', 'auth/invalid-id-token', 'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found'].includes(code)) throw new AuthenticationError();
        throw error;
      }
    },
    async loadGrant(uid) {
      return createLifecycleStore(firebase().db).get(uid);
    },
    onError(error) {
      // Provider error messages can contain credentials or private response details.
      console.error('Backend request failed.', error instanceof Error ? error.name : 'Unknown error');
    },
  };
}

export function createFirebaseIntakeWorker(projectId: string, driveConfig: DriveConfig | undefined, bucket: string, probePath: string, youtubeConfig?: YouTubeConfig, ffmpegPath = youtubeConfig?.ffmpegPath, generationConfig?: GenerationConfig) {
  const app = initializeApp({ projectId, credential: applicationDefault() }, 'riflo-worker');
  const db = getFirestore(app);
  const storage = createSourceStorage(app, bucket);
  const files = createFirebaseSources(() => db, driveConfig, youtubeConfig);
  const store = createProjectStore(db);
  const generationStore = createGenerationStore(db);
  const sourceBucket = boundedStorageBucket(app, bucket);
  const unavailable = async (): Promise<never> => { throw new GenerationError(503, 'transcription_configuration_failed', 'Transcript preparation is not configured.'); };
  const transcription = createGenerationWorker({
    store: generationStore,
    providers: generationConfig ? createGenerationProviders({ config: generationConfig, audio: createAudioExtractor({ ffmpegPath: generationConfig.ffmpegPath, readSource: path => readStorageFile(sourceBucket, path) }) }) : { transcribe: unavailable, generate: unavailable },
    ...(generationConfig ? { stageTimeoutMilliseconds: generationConfig.stageTimeoutMilliseconds } : {}),
  });
  return { ...createIntakeWorker({
    store,
    importSource: createSourceImporter({
      files, storage, prepare: createSourcePreparer(probePath, ffmpegPath),
      async transcribe(claim, result, signal, localSource) {
        if (!claim.project.preparation || claim.project.importIntent === 'source_restore') return;
        const generationClaim = await generationStore.claimImport!(claim, result, Date.now());
        if (generationClaim) await transcription.runClaim(generationClaim, signal, localSource);
      },
      async checkpoint(claim, result) {
        try {
          if (await store.checkpointSource!(claim, result, Date.now())) return;
        } catch {
          // A lost reply may hide a committed receipt. Never delete its source.
          const current = await store.get(claim.project.uid, claim.project.id);
          if (current?.importUpload && current.importUpload.operationId === claim.project.importOperationId && current.importUpload.storagePath === result.storagePath && current.importUpload.sourceSha256 === result.sourceSha256 && current.importUpload.bytes === result.bytes && current.importUpload.durationSeconds === result.durationSeconds) return;
        }
        throw new SourceImportError('stale_import', true, result.bytes);
      },
    }),
    deleteSource: (path) => storage.remove(path),
  }), sources: files.availability };
}

export function createFirebaseGenerationCleanup(projectId: string, bucketName: string) {
  const app = initializeApp({ projectId, credential: applicationDefault() }, 'riflo-output-cleanup');
  const store = createGenerationStore(getFirestore(app), createOutputStorage(app, bucketName));
  return { cleanup: () => store.cleanup(Date.now()) };
}

export function createFirebaseGenerationWorker(projectId: string, config: GenerationConfig, bucketName: string, ffprobePath: string) {
  const app = initializeApp({ projectId, credential: applicationDefault() }, 'riflo-generation-worker');
  const bucket = boundedStorageBucket(app, bucketName);
  const assets = createOutputStorage(app, bucketName);
  return createGenerationWorker({
    store: createGenerationStore(getFirestore(app), assets),
    renderCarousel: createCarouselRenderer({ storage: assets }),
    renderVideo: createVideoRenderer({ storage: assets, readSource: (path) => readStorageFile(bucket, path), ffmpegPath: config.ffmpegPath, ffprobePath }),
    deleteAsset: (path) => assets.remove(path),
    providers: createGenerationProviders({
      config,
      audio: createAudioExtractor({ ffmpegPath: config.ffmpegPath, readSource: (path) => readStorageFile(bucket, path) }),
    }),
    stageTimeoutMilliseconds: config.stageTimeoutMilliseconds,
  });
}
