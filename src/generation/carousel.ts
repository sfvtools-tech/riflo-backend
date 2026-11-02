import { assetPath } from './asset-paths.js';
import sharp from 'sharp';
import { carouselLimits } from './config.js';
import { validateCarousel } from './validation.js';
import { GenerationError, type CarouselContent, type GenerationClaim, type OutputAsset } from './service.js';

export type CarouselStorage = {
  uploadBytes: (path: string, bytes: Buffer, signal: AbortSignal) => Promise<void>;
  remove: (path: string) => Promise<void>;
};
const escapeText = (text: string) => text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
export const carouselThemes = {
  dark: { background: '#111827', title: '#f9fafb', body: '#d1d5db', accent: '#a78bfa' },
  light: { background: '#f9fafb', title: '#111827', body: '#374151', accent: '#6d28d9' },
};

async function fitText(text: string, colour: string, maximum: number, minimum: number, height: number, bold = false) {
  // Fixed DPI and measured output avoid Pango's height-based auto-fit shrinking text without a floor.
  for (let size = maximum; size >= minimum; size -= 2) {
    const rendered = await sharp({ text: { text: `<span foreground="${colour}">${escapeText(text)}</span>`, font: `sans-serif ${bold ? 'Bold ' : ''}${size}`, dpi: 72, width: 900, rgba: true, wrap: 'word-char' } }).png().toBuffer({ resolveWithObject: true });
    if (rendered.info.width <= 900 && rendered.info.height <= height) return rendered.data;
  }
  throw new GenerationError(502, 'carousel_render_failed', 'The slide copy does not fit at a readable size.');
}

export function createCarouselRenderer({ storage }: { storage: CarouselStorage }) {
  return async (value: CarouselContent, claim: GenerationClaim, signal: AbortSignal): Promise<OutputAsset[]> => {
    const controls = claim.batch?.controls;
    const plan = validateCarousel(value, controls).content;
    const theme = controls?.formats.carousels?.theme === 'light' ? carouselThemes.light : carouselThemes.dark;
    const uploaded: string[] = [];
    try {
      const assets: OutputAsset[] = [];
      for (let index = 0; index < plan.slides.length; index++) {
        signal.throwIfAborted();
        const slide = plan.slides[index]!;
        // Model text is escaped before the local text renderer sees it.
        const title = await fitText(slide.title, theme.title, 56, 44, 250, true);
        const body = await fitText(slide.body, theme.body, 42, 38, 500);
        const counter = await sharp({ text: { text: `<span foreground="${theme.accent}">Riflo · ${index + 1}/${carouselLimits.slides}</span>`, font: 'sans-serif 28', dpi: 72, rgba: true } }).png().toBuffer();
        const image = await sharp({ create: { width: carouselLimits.width, height: carouselLimits.height, channels: 4, background: theme.background } })
          .composite([{ input: title, top: 120, left: 90 }, { input: body, top: 420, left: 90 }, { input: counter, top: 980, left: 90 }])
          .png().toBuffer();
        if (image.length > carouselLimits.maxImageBytes) throw new GenerationError(502, 'carousel_render_failed', 'The rendered image exceeds its size bound.');
        signal.throwIfAborted();
        const path = assetPath(claim.project.uid, claim.project.id, claim.slot!.id, claim.attempt, index + 1);
        try { await storage.uploadBytes(path, image, signal); }
        catch (error) {
          // A rejected creation must not delete an object another attempt already owns.
          if ((error as { code?: unknown })?.code !== 412) uploaded.push(path);
          throw error;
        }
        uploaded.push(path);
        assets.push({ id: `slide-${index + 1}`, storagePath: path, contentType: 'image/png', bytes: image.length, width: carouselLimits.width, height: carouselLimits.height });
      }
      return assets;
    } catch {
      await Promise.all(uploaded.map((path) => storage.remove(path).catch(() => undefined)));
      throw new GenerationError(502, 'carousel_render_failed', 'The carousel images could not be prepared.', signal.aborted);
    }
  };
}
