import { assetUrl } from './tauri';

const images = new Map<string, { image?: HTMLImageElement; promise: Promise<HTMLImageElement> }>();

export function preloadImage(path?: string | null): Promise<HTMLImageElement | null> {
  if (!path) return Promise.resolve(null);
  const key = assetUrl(path);
  const cached = images.get(key);
  if (cached) return cached.promise;
  const request = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const entry = images.get(key);
      if (entry) entry.image = image;
      resolve(image);
    };
    image.onerror = () => reject(new Error(`Unable to load image: ${path}`));
    image.src = key;
  }).catch((error) => {
    images.delete(key);
    throw error;
  });
  images.set(key, { promise: request });
  return request;
}

export function cachedImage(path?: string | null): HTMLImageElement | null {
  if (!path) return null;
  const key = assetUrl(path);
  return images.get(key)?.image ?? null;
}
