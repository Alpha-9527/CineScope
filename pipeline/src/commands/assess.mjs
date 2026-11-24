import { chatJSON } from '../ai.mjs';
import { ASSESS_SYSTEM, assessPrompt } from '../prompts.mjs';
import { computeScore, decideStatus, clamp, RUBRIC_VERSION } from '../score.mjs';
import { env } from '../env.mjs';
import { many, one, withTransaction } from '../db.mjs';
import { SQL_FILM_BY_ID, toPromptFilm } from '../queries.mjs';

function buildSources(film) {
  const sources = [];
  if (film.tmdb_id) {
    sources.push({
      label: 'TMDb 影片资料',
      url: `https://www.themoviedb.org/movie/${film.tmdb_id}`,
      retrieved: new Date().toISOString().slice(0, 10),
    });
  }
  if (film.imdb_id) {
    sources.push({
      label: 'IMDb 影片页面',
      url: `https://www.imdb.com/title/${film.imdb_id}/`,
      retrieved: new Date().toISOString().slice(0, 10),
    });
  }
  return sources;
}

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function normalizeAssessment(data) {
  return {
    audience: clamp(Math.round(num(data.audience, 60))),
    artistic: clamp(Math.round(num(data.artistic, 60))),
    recommendation: clamp(Math.round(num(data.recommendation, 60))),
    confidence: Math.min(1, Math.max(0, num(data.confidence, 0.5))),
    dimensions: data.dimensions ?? {},
    rationale: String(data.rationale ?? '').slice(0, 800),
    evidence: Array.isArray(data.evidence) ? data.evidence.slice(0, 5) : [],
    caveats: Array.isArray(data.caveats) ? data.caveats.slice(0, 5) : [],
    angle: String(data.angle ?? '').slice(0, 120),
  };
}

export async function assessFilm(filmId, { dryRun = false } = {}) {
  const film = toPromptFilm(await one(SQL_FILM_BY_ID, [filmId]));
  if (!film) throw new Error(`未找到影片 id=${filmId}`);

  const ratings = await many(
    'SELECT source, score, vote_count FROM ratings WHERE film_id = $1',
    [filmId],
  );
  const normalizedRatings = ratings.map((row) => ({
    source: row.source,
    score: row.score,
    voteCount: row.vote_count,
  }));
  const sources = buildSources(film);

  if (dryRun) {
    return { slug: film.slug, action: 'would-assess', sources: sources.length };
  }

  const { data } = await chatJSON({
    system: ASSESS_SYSTEM,
    user: assessPrompt({
      film,
      ratings: normalizedRatings,
      sources,
    }),
    temperature: 0.2,
  });

  const normalized = normalizeAssessment(data);
  const scores = computeScore({
    audience: normalized.audience,
    artistic: normalized.artistic,
    recommendation: normalized.recommendation,
    confidence: normalized.confidence,
  });
  const status = decideStatus(scores);

  await withTransaction(async (client) => {
    await client.query('UPDATE assessments SET is_current = false WHERE film_id = $1 AND is_current', [
      filmId,
    ]);

    await client.query(
      `INSERT INTO assessments (
         film_id, model, prompt_version, rubric_version,
         audience_score, artistic_score, recommendation_score, confidence,
         quality_score, final_score, dimensions, evidence, rationale, is_current
       ) VALUES ($1, $2, 'assess-v1', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)`,
      [
        filmId,
        env.deepseekModel,
        RUBRIC_VERSION,
        normalized.audience,
        normalized.artistic,
        normalized.recommendation,
        normalized.confidence,
        scores.quality,
        scores.final,
        JSON.stringify({ ...normalized.dimensions, caveats: normalized.caveats, angle: normalized.angle }),
        JSON.stringify(normalized.evidence),
        normalized.rationale,
      ],
    );

    if (film.status !== 'published' && film.status !== 'archived') {
      await client.query('UPDATE films SET status = $2 WHERE id = $1', [filmId, status]);
    }
  });

  return {
    slug: film.slug,
    title: film.title_zh,
    scores,
    status,
    rationale: normalized.rationale,
  };
}

export async function runAssess({ limit = 10, slug, dryRun = false } = {}) {
  let films;
  if (slug) {
    const film = await one('SELECT id FROM films WHERE slug = $1', [slug]);
    if (!film) throw new Error(`未找到影片：${slug}`);
    films = [{ id: film.id }];
  } else {
    films = await many(
      `SELECT f.id
       FROM films f
       LEFT JOIN assessments a ON a.film_id = f.id AND a.is_current
       WHERE f.status IN ('candidate', 'selected') AND a.id IS NULL
       ORDER BY f.tmdb_popularity DESC NULLS LAST
       LIMIT $1`,
      [limit],
    );
  }

  const results = [];
  for (const film of films) {
    results.push(await assessFilm(film.id, { dryRun }));
  }
  return { processed: results.length, results };
}
