import { discoverMovies, getMovie, mapMovie } from '../tmdb.mjs';
import { query, one } from '../db.mjs';
import { env } from '../env.mjs';

const MIN_VOTE_COUNT = 400;
const MAX_VOTE_COUNT = 10000;
const MIN_VOTE_AVERAGE = 7.6;
const MIN_AGE_YEARS = 3;

export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

export function buildSlug(movie) {
  const base = slugify(movie.titleEn || movie.titleOriginal || '');
  if (!base) return `tmdb-${movie.tmdbId}`;
  return `${base}-${movie.year}`.slice(0, 90);
}

async function alreadyKnown(tmdbId) {
  const row = await one('SELECT id, slug FROM films WHERE tmdb_id = $1', [tmdbId]);
  return row;
}

export async function upsertFilm(movie, discoveredFrom = 'tmdb_discover') {
  const slug = buildSlug(movie);
  const inserted = await one(
    `INSERT INTO films (
       tmdb_id, imdb_id, slug, title_zh, title_original, title_en, year, release_date,
       runtime, countries, languages, genres, overview_zh, poster_path, backdrop_path,
       tmdb_popularity, tmdb_vote_average, tmdb_vote_count, status, discovered_from,
       source_updated_at, last_synced_at, metadata
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, 'candidate', $19,
       now(), NULL, $20
     )
     ON CONFLICT (tmdb_id) DO UPDATE SET
       title_zh = EXCLUDED.title_zh,
       title_original = EXCLUDED.title_original,
       year = EXCLUDED.year,
       release_date = EXCLUDED.release_date,
       runtime = COALESCE(EXCLUDED.runtime, films.runtime),
       countries = EXCLUDED.countries,
       languages = EXCLUDED.languages,
       genres = EXCLUDED.genres,
       overview_zh = COALESCE(EXCLUDED.overview_zh, films.overview_zh),
       poster_path = COALESCE(EXCLUDED.poster_path, films.poster_path),
       backdrop_path = COALESCE(EXCLUDED.backdrop_path, films.backdrop_path),
       tmdb_popularity = EXCLUDED.tmdb_popularity,
       tmdb_vote_average = EXCLUDED.tmdb_vote_average,
       tmdb_vote_count = EXCLUDED.tmdb_vote_count,
       source_updated_at = now()
     RETURNING id, slug`,
    [
      movie.tmdbId,
      movie.imdbId,
      slug,
      movie.titleZh,
      movie.titleOriginal,
      movie.titleEn,
      movie.year,
      movie.releaseDate,
      movie.runtime,
      movie.countries,
      movie.languages,
      movie.genres,
      movie.overviewZh,
      movie.posterPath,
      movie.backdropPath,
      movie.popularity,
      movie.voteAverage,
      movie.voteCount,
      discoveredFrom,
      JSON.stringify({ tmdbStatus: movie.raw?.status ?? null, originalLanguage: movie.raw?.original_language ?? null }),
    ],
  );

  await query(
    `INSERT INTO ratings (film_id, source, score, vote_count, fetched_at)
     VALUES ($1, 'tmdb', $2, $3, now())
     ON CONFLICT (film_id, source) DO UPDATE
       SET score = EXCLUDED.score, vote_count = EXCLUDED.vote_count, fetched_at = now()`,
    [inserted.id, movie.voteAverage, movie.voteCount],
  );

  return inserted;
}

export async function runDiscover({
  limit = 20,
  pages = 2,
  region = env.tmdbRegion,
  language,
  yearFrom,
  yearTo,
  dryRun = false,
} = {}) {
  const picked = [];
  const seen = new Set();

  for (let page = 1; page <= pages && picked.length < limit; page += 1) {
    const data = await discoverMovies({ page, region, language, yearFrom, yearTo });
    for (const item of data.results ?? []) {
      if (seen.has(item.id)) continue;
      if ((item.vote_count ?? 0) < MIN_VOTE_COUNT) continue;
      if ((item.vote_count ?? 0) > MAX_VOTE_COUNT) continue;
      if ((item.vote_average ?? 0) < MIN_VOTE_AVERAGE) continue;
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - MIN_AGE_YEARS);
      if (!item.release_date || item.release_date > cutoff.toISOString().slice(0, 10)) continue;
      seen.add(item.id);
      picked.push(item);
      if (picked.length >= limit) break;
    }
    if ((data.total_pages ?? 1) <= page) break;
  }

  const results = [];
  for (const item of picked) {
    const known = dryRun ? null : await alreadyKnown(item.id);
    if (known) {
      results.push({ tmdbId: item.id, title: item.title, slug: known.slug, action: 'exists' });
      continue;
    }

    if (dryRun) {
      results.push({
        tmdbId: item.id,
        title: item.title,
        year: (item.release_date ?? '').slice(0, 4),
        vote: item.vote_average,
        votes: item.vote_count,
        action: 'would-insert',
      });
      continue;
    }

    const detail = await getMovie(item.id);
    const movie = mapMovie(detail);
    const row = await upsertFilm(movie);
    results.push({ tmdbId: item.id, title: movie.titleZh, slug: row.slug, action: 'inserted' });
  }

  return {
    scanned: picked.length,
    inserted: results.filter((r) => r.action === 'inserted').length,
    results,
  };
}
