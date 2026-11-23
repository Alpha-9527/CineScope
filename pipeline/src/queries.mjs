/**
 * 数据库列是 snake_case，提示词使用 camelCase。统一在进入 AI 前转换，
 * 避免把 undefined 带进提示词。
 */
export function toPromptFilm(film) {
  if (!film) return film;
  return {
    ...film,
    titleZh: film.title_zh ?? film.titleZh ?? null,
    titleOriginal: film.title_original ?? film.titleOriginal ?? null,
    overviewZh: film.overview_zh ?? film.overviewZh ?? null,
    overviewEn: film.metadata?.overviewEn ?? film.overviewEn ?? null,
    directors: film.directors ?? [],
    cast: film.cast ?? [],
  };
}

export const FILM_PROMPT_FIELDS = `
  f.*,
  coalesce(
    (SELECT json_agg(json_build_object('name', p.name, 'character', c.character) ORDER BY c.billing_order)
     FROM credits c JOIN people p ON p.id = c.person_id
     WHERE c.film_id = f.id AND c.role = 'actor'),
    '[]'::json
  ) AS cast,
  coalesce(
    (SELECT json_agg(p.name ORDER BY c.billing_order)
     FROM credits c JOIN people p ON p.id = c.person_id
     WHERE c.film_id = f.id AND c.role = 'director'),
    '[]'::json
  ) AS directors,
  r.score AS imdb_score,
  r.vote_count AS imdb_votes
`;

export const FILM_FROM = `
  FROM films f
  LEFT JOIN ratings r ON r.film_id = f.id AND r.source = 'imdb'
`;

export const SQL_FILM_BY_ID = `SELECT ${FILM_PROMPT_FIELDS} ${FILM_FROM} WHERE f.id = $1`;
export const SQL_FILM_BY_SLUG = `SELECT ${FILM_PROMPT_FIELDS} ${FILM_FROM} WHERE f.slug = $1`;

export const SQL_CANDIDATES = `
  SELECT ${FILM_PROMPT_FIELDS}
  ${FILM_FROM}
  WHERE f.status IN ('candidate', 'selected')
  ORDER BY f.tmdb_popularity DESC NULLS LAST, f.year DESC
  LIMIT $1
`;

export const SQL_CANDIDATES_WITH_ASSESSMENT = `
  SELECT ${FILM_PROMPT_FIELDS},
         a.audience_score, a.artistic_score, a.recommendation_score,
         a.confidence, a.final_score, a.rationale, a.dimensions, a.evidence,
         a.dimensions->>'angle' AS angle
  ${FILM_FROM}
  JOIN assessments a ON a.film_id = f.id AND a.is_current
  WHERE f.status IN ('candidate', 'selected')
    AND a.final_score >= $1
  ORDER BY a.final_score DESC
  LIMIT $2
`;

/**
 * 最近 N 天未被每日刊物使用过的影片，避免短时间内重复推荐。
 */
export const SQL_DAILY_POOL = `
  SELECT ${FILM_PROMPT_FIELDS},
         a.audience_score, a.artistic_score, a.recommendation_score,
         a.confidence, a.final_score, a.rationale,
         a.dimensions->>'angle' AS angle
  ${FILM_FROM}
  JOIN assessments a ON a.film_id = f.id AND a.is_current
  WHERE f.status IN ('selected', 'published')
    AND a.final_score >= $1
    AND NOT EXISTS (
      SELECT 1
      FROM selection_items s
      JOIN daily_editions d ON d.id = s.edition_id
      WHERE s.film_id = f.id
        AND d.edition_date > (CURRENT_DATE - ($2::int * INTERVAL '1 day'))
    )
  ORDER BY a.final_score DESC, f.tmdb_popularity ASC NULLS LAST
  LIMIT $3
`;
