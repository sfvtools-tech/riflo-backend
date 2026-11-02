import { readStorageFile } from '../storage/read.js';
import type { VideoStorage } from './video.js';
import { finished } from 'node:stream/promises';
import type { App } from 'firebase-admin/app';
import { boundedStorageBucket, deleteStorageObject, uploadStorageObject } from '../storage/delete.js';
import type { CarouselStorage } from './carousel.js';

export function createOutputStorage(app: App, bucketName: string): CarouselStorage & VideoStorage & { read: (path: string) => Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> } {
  const bucket = boundedStorageBucket(app, bucketName);
  return {
    async uploadBytes(path, bytes, signal) {
      await uploadStorageObject(bucket, path, bytes, { contentType: 'image/png', cacheControl: 'private, no-store' }, signal);
    },
    async uploadFile(path, localPath, signal) {
      await uploadStorageObject(bucket, path, { localPath }, { contentType: 'video/mp4', cacheControl: 'private, no-store' }, signal);
    },
    async remove(path) { await deleteStorageObject(bucket, path); },
    async read(path) {
      const source = readStorageFile(bucket, path, { maxBytes: path.endsWith('.mp4') ? 100_000_000 : 5_000_000 });
      const iterator = source[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await iterator.next();
          if (done) { await finished(source); controller.close(); }
          else controller.enqueue(value);
        },
        async cancel() { source.destroy(); await finished(source).catch(() => undefined); },
      });
      return { body, contentType: path.endsWith('.mp4') ? 'video/mp4' : 'image/png' };
    },
  };
}
