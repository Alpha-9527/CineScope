/**
 * 图片走 wsrv.nl 代理。
 *
 * image.tmdb.org 与 m.media-amazon.com（IMDb）在部分地区加载很慢，
 * wsrv.nl 会把图片缓存在 Cloudflare 边缘并转成 WebP，重复访问直接命中缓存。
 * 只代理这两个图床，站内静态资源与其他域名的图片保持原样。
 */
const PROXIED_HOSTS = new Set(['image.tmdb.org', 'm.media-amazon.com']);
const IMAGE_PROXY = 'https://wsrv.nl/';

export interface ImageOptions {
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'inside' | 'outside';
  quality?: number;
}

export function proxyImage(src: string | undefined, options: ImageOptions = {}): string | undefined {
  if (!src) return undefined;

  let source: URL;
  try {
    source = new URL(src);
  } catch {
    return src;
  }
  if (!PROXIED_HOSTS.has(source.hostname)) return src;

  const params = new URLSearchParams({
    url: src,
    output: 'webp',
    q: String(options.quality ?? 80),
  });

  if (options.width) params.set('w', String(Math.round(options.width)));
  if (options.height) params.set('h', String(Math.round(options.height)));
  if (options.fit) params.set('fit', options.fit);
  // we：原图小于请求尺寸时不放大
  if (options.width || options.height) params.set('we', '');

  return `${IMAGE_PROXY}?${params.toString()}`;
}
