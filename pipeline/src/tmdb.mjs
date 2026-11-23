import { env, requireEnv } from './env.mjs';

const TMDB_BASE = 'https://api.themoviedb.org/3';
export const IMAGE_BASE = 'https://image.tmdb.org/t/p';

// 国家/语言使用 CLDR 中文名（日本、日语），TMDb 默认返回英文。
const displayNames = {
  region: new Intl.DisplayNames(['zh-CN'], { type: 'region' }),
  language: new Intl.DisplayNames(['zh-CN'], { type: 'language' }),
};

function localize(type, code, fallback) {
  if (!code) return fallback;
  try {
    return displayNames[type].of(code) ?? fallback;
  } catch {
    return fallback;
  }
}

let lastCall = 0;
const MIN_INTERVAL_MS = 260;

function authHeaders() {
  const headers = { accept: 'application/json' };
  if (env.tmdbToken) headers.authorization = `Bearer ${env.tmdbToken}`;
  return headers;
}

function withKey(url) {
  if (env.tmdbToken) return url;
  if (!env.tmdbApiKey) requireEnv('tmdbToken');
  const u = new URL(url);
  u.searchParams.set('api_key', env.tmdbApiKey);
  return u.toString();
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function tmdbGet(pathname, params = {}, { retries = 3 } = {}) {
  const url = new URL(`${TMDB_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCall));
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    const response = await fetch(withKey(url.toString()), { headers: authHeaders() });
    if (response.ok) return response.json();

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 0);
      await sleep(Math.max(retryAfter * 1000, 800 * attempt));
      continue;
    }

    const body = await response.text();
    throw new Error(`TMDb ${response.status} ${pathname}: ${body.slice(0, 300)}`);
  }

  throw new Error(`TMDb 请求失败（已重试 ${retries} 次）：${pathname}`);
}

export async function discoverMovies({
  page = 1,
  region = env.tmdbRegion,
  language,
  yearFrom,
  yearTo,
  voteCountGte = 400,
  voteCountLte = 10000,
  voteAverageGte = 7.6,
  sortBy = 'vote_average.desc',
  minAgeYears = 3,
} = {}) {
  // 只纳入已上映且经过时间检验的作品：新片评分样本小、热度波动大。
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - minAgeYears);
  const releasedBefore = cutoff.toISOString().slice(0, 10);
  return tmdbGet('/discover/movie', {
    page,
    region,
    sort_by: sortBy,
    'vote_count.gte': voteCountGte,
    'vote_count.lte': voteCountLte,
    'vote_average.gte': voteAverageGte,
    'primary_release_date.gte': yearFrom ? `${yearFrom}-01-01` : undefined,
    'primary_release_date.lte': yearTo ? `${yearTo}-12-31` : releasedBefore,
    with_original_language: language,
    without_genres: '99,10770',
    include_adult: false,
    include_video: false,
    language: env.tmdbLanguage,
  });
}

export async function getMovie(tmdbId) {
  return tmdbGet(`/movie/${tmdbId}`, {
    append_to_response: 'credits,external_ids,release_dates,translations,images',
    include_image_language: 'zh,en,null',
    language: env.tmdbLanguage,
  });
}

export async function getWatchProviders(tmdbId, region = env.tmdbRegion) {
  const data = await tmdbGet(`/movie/${tmdbId}/watch/providers`);
  return data.results?.[region] ?? null;
}

export function imageUrl(path, size = 'w780') {
  if (!path) return null;
  return `${IMAGE_BASE}/${size}${path}`;
}

function uniqueNames(list) {
  return [...new Set(list.filter(Boolean).map((item) => item.name).filter(Boolean))];
}

/**
 * 把 TMDb 详情归一化为数据库字段。
 * 注意：中文标题缺失时回退到原始标题，绝不自行翻译。
 */
export function mapMovie(detail) {
  const original = detail.original_title ?? detail.title ?? '';
  const zh = detail.title && detail.title !== original ? detail.title : '';
  const crew = detail.credits?.crew ?? [];
  const cast = [...(detail.credits?.cast ?? [])].sort((a, b) => a.order - b.order);
  const directors = uniqueNames(crew.filter((person) => person.job === 'Director'));
  const writers = uniqueNames(
    crew.filter((person) => ['Writer', 'Screenplay', 'Story'].includes(person.job)),
  );
  const composers = uniqueNames(crew.filter((person) => person.job === 'Original Music Composer'));
  const releaseDate = detail.release_date || null;
  const imdbId = detail.external_ids?.imdb_id || null;
  const translations = detail.translations?.translations ?? [];
  const englishTitle =
    translations.find((item) => item.iso_639_1 === 'en' && item.data?.title)?.data.title ?? null;
  const englishOverview =
    translations.find((item) => item.iso_639_1 === 'en' && item.data?.overview)?.data.overview ?? null;

  return {
    tmdbId: detail.id,
    imdbId,
    slug: imdbId ? imdbId : `tmdb-${detail.id}`,
    titleZh: zh || original,
    titleOriginal: original,
    titleEn: detail.original_language === 'en' ? original : englishTitle,
    year: Number((releaseDate ?? '').slice(0, 4)) || new Date().getFullYear(),
    releaseDate,
    runtime: detail.runtime ?? null,
    countries: (detail.production_countries ?? [])
      .map((c) => localize('region', c.iso_3166_1, c.name))
      .filter(Boolean),
    languages: (detail.spoken_languages ?? [])
      .map((l) => localize('language', l.iso_639_1, l.name))
      .filter(Boolean),
    genres: (detail.genres ?? []).map((g) => g.name),
    overviewZh: detail.overview || null,
    overviewEn: englishOverview,
    posterPath: imageUrl(detail.poster_path, 'w500'),
    backdropPath: imageUrl(detail.backdrop_path, 'w1280'),
    popularity: detail.popularity ?? null,
    voteAverage: detail.vote_average ?? null,
    voteCount: detail.vote_count ?? null,
    directors,
    writers,
    composers,
    cast: cast.slice(0, 10).map((person) => ({
      tmdbId: person.id,
      name: person.name,
      character: person.character ?? null,
      order: person.order,
    })),
    crew: crew
      .filter((person) => ['Director', 'Writer', 'Screenplay', 'Original Music Composer'].includes(person.job))
      .map((person) => ({ tmdbId: person.id, name: person.name, job: person.job })),
    raw: detail,
  };
}
