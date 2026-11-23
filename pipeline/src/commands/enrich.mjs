import { getMovie, getWatchProviders, mapMovie } from '../tmdb.mjs';
import { one, query, withTransaction } from '../db.mjs';
import { env } from '../env.mjs';

const ROLE_BY_JOB = new Map([
  ['Director', 'director'],
  ['Writer', 'writer'],
  ['Screenplay', 'writer'],
  ['Original Music Composer', 'composer'],
  ['Director of Photography', 'cinematographer'],
  ['Producer', 'producer'],
  ['Editor', 'editor'],
]);

async function upsertPerson(client, person) {
  const { rows } = await client.query(
    `INSERT INTO people (tmdb_id, name)
     VALUES ($1, $2)
     ON CONFLICT (tmdb_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [person.tmdbId, person.name],
  );
  return rows[0].id;
}

async function syncCredits(client, filmId, movie) {
  await client.query('DELETE FROM credits WHERE film_id = $1', [filmId]);

  const crewRoles = new Set();
  for (const member of movie.crew) {
    const role = ROLE_BY_JOB.get(member.job);
    if (!role || crewRoles.has(`${member.tmdbId}:${role}`)) continue;
    crewRoles.add(`${member.tmdbId}:${role}`);
    const personId = await upsertPerson(client, member);
    await client.query(
      `INSERT INTO credits (film_id, person_id, role, job)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (film_id, person_id, role) DO NOTHING`,
      [filmId, personId, role, member.job],
    );
  }

  for (const actor of movie.cast) {
    const personId = await upsertPerson(client, actor);
    await client.query(
      `INSERT INTO credits (film_id, person_id, role, character, billing_order)
       VALUES ($1, $2, 'actor', $3, $4)
       ON CONFLICT (film_id, person_id, role) DO UPDATE
         SET character = EXCLUDED.character, billing_order = EXCLUDED.billing_order`,
      [filmId, personId, actor.character, actor.order],
    );
  }
}

async function syncAvailability(client, filmId, tmdbId) {
  let providers;
  try {
    providers = await getWatchProviders(tmdbId);
  } catch {
    return 0;
  }
  if (!providers) return 0;

  const offers = [];
  for (const [offerType, list] of [
    ['stream', providers.flatrate],
    ['rent', providers.rent],
    ['buy', providers.buy],
  ]) {
    for (const provider of list ?? []) {
      offers.push([filmId, env.tmdbRegion, provider.provider_name, offerType, providers.link ?? null]);
    }
  }

  await client.query('DELETE FROM availability WHERE film_id = $1 AND region = $2', [
    filmId,
    env.tmdbRegion,
  ]);

  for (const offer of offers) {
    await client.query(
      `INSERT INTO availability (film_id, region, platform, offer_type, url, checked_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (film_id, region, platform, offer_type) DO UPDATE
         SET url = EXCLUDED.url, checked_at = now()`,
      offer,
    );
  }
  return offers.length;
}

export async function runEnrich({ limit = 10, force = false, dryRun = false } = {}) {
  const films = await query(
    `SELECT id, tmdb_id, slug, title_zh
     FROM films
     WHERE tmdb_id IS NOT NULL
       AND status IN ('candidate', 'selected', 'published')
       AND (${force ? 'true' : "last_synced_at IS NULL OR last_synced_at < now() - INTERVAL '30 days'"})
     ORDER BY last_synced_at NULLS FIRST
     LIMIT $1`,
    [limit],
  );

  const summary = [];

  for (const film of films.rows) {
    if (dryRun) {
      summary.push({ slug: film.slug, action: 'would-enrich' });
      continue;
    }

    const detail = await getMovie(film.tmdb_id);
    const movie = mapMovie(detail);

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE films SET
           runtime = COALESCE($2, runtime),
           countries = $3,
           languages = $4,
           genres = $5,
           overview_zh = COALESCE($6, overview_zh),
           poster_path = COALESCE($7, poster_path),
           backdrop_path = COALESCE($8, backdrop_path),
           imdb_id = COALESCE($9, imdb_id),
           tmdb_popularity = $10,
           tmdb_vote_average = $11,
           tmdb_vote_count = $12,
           last_synced_at = now(),
           metadata = films.metadata || $13::jsonb
         WHERE id = $1`,
        [
          film.id,
          movie.runtime,
          movie.countries,
          movie.languages,
          movie.genres,
          movie.overviewZh,
          movie.posterPath,
          movie.backdropPath,
          movie.imdbId,
          movie.popularity,
          movie.voteAverage,
          movie.voteCount,
          JSON.stringify({
            originalLanguage: movie.raw?.original_language ?? null,
            ...(movie.overviewEn ? { overviewEn: movie.overviewEn } : {}),
          }),
        ],
      );

      await syncCredits(client, film.id, movie);

      if (movie.voteAverage !== null) {
        await client.query(
          `INSERT INTO ratings (film_id, source, score, vote_count, fetched_at)
           VALUES ($1, 'tmdb', $2, $3, now())
           ON CONFLICT (film_id, source) DO UPDATE
             SET score = EXCLUDED.score, vote_count = EXCLUDED.vote_count, fetched_at = now()`,
          [film.id, movie.voteAverage, movie.voteCount],
        );
      }

      await syncAvailability(client, film.id, film.tmdb_id);
    });

    summary.push({ slug: film.slug, action: 'enriched' });
  }

  return { processed: summary.length, summary };
}

export async function importImdbRating({ slug, score, votes, url }) {
  const film = await one('SELECT id FROM films WHERE slug = $1', [slug]);
  if (!film) throw new Error(`未找到影片：${slug}`);
  await query(
    `INSERT INTO ratings (film_id, source, score, vote_count, url, fetched_at)
     VALUES ($1, 'imdb', $2, $3, $4, now())
     ON CONFLICT (film_id, source) DO UPDATE
       SET score = EXCLUDED.score, vote_count = EXCLUDED.vote_count,
           url = EXCLUDED.url, fetched_at = now()`,
    [film.id, score, votes, url ?? null],
  );
}
