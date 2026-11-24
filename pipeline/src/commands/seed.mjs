import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { CONTENT_DIR } from '../env.mjs';
import { withTransaction } from '../db.mjs';

async function readCollection(name) {
  const dir = path.join(CONTENT_DIR, name);
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((entry) => entry.endsWith('.md')).sort();
  const docs = [];
  for (const file of files) {
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    const parsed = matter(raw);
    docs.push({
      id: path.basename(file, '.md'),
      data: parsed.data,
      body: parsed.content.trim(),
    });
  }
  return docs;
}

async function upsertPerson(client, name) {
  const existing = await client.query('SELECT id FROM people WHERE name = $1 LIMIT 1', [name]);
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await client.query('INSERT INTO people (name) VALUES ($1) RETURNING id', [name]);
  return inserted.rows[0].id;
}

async function importFilm(client, doc) {
  const data = doc.data;
  const row = await client.query(
    `INSERT INTO films (
       slug, title_zh, title_original, year, runtime, countries, languages, genres,
       poster_path, backdrop_path, tmdb_id, imdb_id, status, discovered_from, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'published', 'seed_from_site', $13)
     ON CONFLICT (slug) DO UPDATE SET
       title_zh = EXCLUDED.title_zh,
       title_original = EXCLUDED.title_original,
       year = EXCLUDED.year,
       runtime = EXCLUDED.runtime,
       countries = EXCLUDED.countries,
       languages = EXCLUDED.languages,
       genres = EXCLUDED.genres,
       poster_path = coalesce(EXCLUDED.poster_path, films.poster_path),
       backdrop_path = coalesce(EXCLUDED.backdrop_path, films.backdrop_path),
       tmdb_id = coalesce(EXCLUDED.tmdb_id, films.tmdb_id),
       imdb_id = coalesce(EXCLUDED.imdb_id, films.imdb_id),
       status = 'published',
       metadata = films.metadata || EXCLUDED.metadata,
       updated_at = now()
     RETURNING id`,
    [
      doc.id,
      data.title,
      data.originalTitle ?? null,
      data.year,
      data.runtime ?? null,
      data.countries ?? [],
      data.language ? [data.language] : [],
      data.genres ?? [],
      data.poster ?? null,
      data.backdrop ?? null,
      data.tmdbId ?? null,
      data.imdbId ?? null,
      JSON.stringify({ palette: data.palette }),
    ],
  );
  const filmId = row.rows[0].id;

  if (data.ratings?.imdb !== undefined) {
    await client.query(
      `INSERT INTO ratings (film_id, source, score, vote_count, fetched_at)
       VALUES ($1, 'imdb', $2, $3, now())
       ON CONFLICT (film_id, source) DO UPDATE
         SET score = EXCLUDED.score, vote_count = EXCLUDED.vote_count, fetched_at = now()`,
      [filmId, data.ratings.imdb, data.ratings.votes ?? null],
    );
  }

  const scores = data.scores ?? {};
  await client.query('UPDATE assessments SET is_current = false WHERE film_id = $1 AND is_current', [
    filmId,
  ]);
  await client.query(
    `INSERT INTO assessments (
       film_id, model, prompt_version, rubric_version,
       audience_score, artistic_score, recommendation_score, confidence,
       final_score, dimensions, rationale, is_current
     ) VALUES ($1, 'seed', 'seed-v1', 'q-2026.1', $2, $3, $4, $5, $6, $7, $8, true)`,
    [
      filmId,
      scores.audience ?? null,
      scores.artistic ?? null,
      scores.recommendation ?? null,
      scores.confidence ?? null,
      scores.final ?? null,
      JSON.stringify({
        angle: data.selection?.angle ?? '',
        caveats: [],
      }),
      '由站点样例内容反向导入，评分来自样例数据。',
    ],
  );

  await client.query('DELETE FROM credits WHERE film_id = $1', [filmId]);
  for (const [index, name] of (data.directors ?? []).entries()) {
    const personId = await upsertPerson(client, name);
    await client.query(
      `INSERT INTO credits (film_id, person_id, role, billing_order)
       VALUES ($1, $2, 'director', $3)
       ON CONFLICT (film_id, person_id, role) DO NOTHING`,
      [filmId, personId, index + 1],
    );
  }
  for (const [index, name] of (data.cast ?? []).entries()) {
    const personId = await upsertPerson(client, name);
    await client.query(
      `INSERT INTO credits (film_id, person_id, role, billing_order)
       VALUES ($1, $2, 'actor', $3)
       ON CONFLICT (film_id, person_id, role) DO NOTHING`,
      [filmId, personId, index + 1],
    );
  }

  await client.query(
    `INSERT INTO editorial_articles (
       kind, slug, title, subtitle, body_markdown, film_id, word_count,
       status, model, sources, published_at
     ) VALUES ('film_review', $1, $2, $3, $4, $5, $6, 'published', 'seed', $7, now())
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       body_markdown = EXCLUDED.body_markdown,
       film_id = EXCLUDED.film_id,
       status = 'published',
       sources = EXCLUDED.sources,
       published_at = coalesce(editorial_articles.published_at, now()),
       updated_at = now()`,
    [
      `film-${doc.id}`,
      data.title,
      `${data.originalTitle ?? ''}${data.year ? ` · ${data.year}` : ''}`.trim(),
      doc.body,
      filmId,
      doc.body.length,
      JSON.stringify(data.sources ?? []),
    ],
  );

  return filmId;
}

async function importDaily(client, doc) {
  const data = doc.data;
  const row = await client.query(
    `INSERT INTO daily_editions (
       issue_no, edition_date, title, subtitle, editor_intro, closing, status, published_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'published', now())
     ON CONFLICT (edition_date) DO UPDATE SET
       title = EXCLUDED.title,
       subtitle = EXCLUDED.subtitle,
       editor_intro = EXCLUDED.editor_intro,
       closing = EXCLUDED.closing,
       status = 'published',
       updated_at = now()
     RETURNING id`,
    [
      data.issue,
      data.date,
      data.title,
      data.subtitle ?? '',
      data.editorIntro ?? '',
      data.closing ?? '',
    ],
  );
  const editionId = row.rows[0].id;

  await client.query('DELETE FROM selection_items WHERE edition_id = $1', [editionId]);
  let position = 0;
  for (const item of data.films ?? []) {
    const film = await client.query('SELECT id FROM films WHERE slug = $1', [item.slug]);
    if (!film.rows[0]) {
      console.warn(`  ! 每日 ${data.date} 引用了不存在的影片 ${item.slug}，已跳过`);
      continue;
    }
    position += 1;
    await client.query(
      `INSERT INTO selection_items (edition_id, film_id, position, note, is_lead)
       VALUES ($1, $2, $3, $4, $5)`,
      [editionId, film.rows[0].id, position, item.note ?? '', position === 1],
    );
  }

  await client.query(
    `INSERT INTO editorial_articles (
       kind, slug, title, subtitle, body_markdown, edition_id, status, model, sources, published_at
     ) VALUES ('daily_intro', $1, $2, $3, $4, $5, 'published', 'seed', $6, now())
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       body_markdown = EXCLUDED.body_markdown,
       edition_id = EXCLUDED.edition_id,
       status = 'published',
       sources = EXCLUDED.sources,
       updated_at = now()`,
    [
      `daily-${data.date}`,
      data.title,
      data.subtitle ?? '',
      doc.body,
      editionId,
      JSON.stringify(data.sources ?? []),
    ],
  );

  return editionId;
}

async function importMagazine(client, doc) {
  const data = doc.data;
  const cover = data.leadFilm
    ? await client.query('SELECT id FROM films WHERE slug = $1', [data.leadFilm])
    : { rows: [] };

  const row = await client.query(
    `INSERT INTO weekly_magazines (
       year, week, magazine_date, title, subtitle, theme, editor_intro, closing,
       cover_film_id, cover_palette, status, published_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'published', now())
     ON CONFLICT (year, week) DO UPDATE SET
       title = EXCLUDED.title,
       subtitle = EXCLUDED.subtitle,
       theme = EXCLUDED.theme,
       editor_intro = EXCLUDED.editor_intro,
       closing = EXCLUDED.closing,
       cover_film_id = EXCLUDED.cover_film_id,
       cover_palette = EXCLUDED.cover_palette,
       status = 'published',
       updated_at = now()
     RETURNING id`,
    [
      data.year,
      data.week,
      data.date,
      data.title,
      data.subtitle ?? '',
      data.theme ?? data.title,
      data.editorIntro ?? '',
      data.closing ?? '',
      cover.rows[0]?.id ?? null,
      data.coverPalette ?? 'ash',
    ],
  );
  const magazineId = row.rows[0].id;

  await client.query('DELETE FROM weekly_items WHERE magazine_id = $1', [magazineId]);
  const insertItems = async (list, section) => {
    let position = 0;
    for (const item of list ?? []) {
      const film = await client.query('SELECT id FROM films WHERE slug = $1', [item.slug]);
      if (!film.rows[0]) {
        console.warn(`  ! 周刊 ${data.year}-W${data.week} 引用了不存在的影片 ${item.slug}，已跳过`);
        continue;
      }
      position += 1;
      await client.query(
        `INSERT INTO weekly_items (magazine_id, film_id, section, position, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [magazineId, film.rows[0].id, section, position, item.note ?? ''],
      );
    }
  };
  await insertItems(data.picks, 'pick');
  await insertItems(data.specialFinds, 'special_find');

  await client.query(
    `INSERT INTO editorial_articles (
       kind, slug, title, subtitle, body_markdown, magazine_id, status, model, sources, published_at
     ) VALUES ('weekly_editorial', $1, $2, $3, $4, $5, 'published', 'seed', $6, now())
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       body_markdown = EXCLUDED.body_markdown,
       magazine_id = EXCLUDED.magazine_id,
       status = 'published',
       sources = EXCLUDED.sources,
       updated_at = now()`,
    [
      `weekly-${data.year}-w${data.week}`,
      data.title,
      data.subtitle ?? '',
      doc.body,
      magazineId,
      JSON.stringify(data.sources ?? []),
    ],
  );

  return magazineId;
}

async function importFeature(client, doc) {
  const data = doc.data;
  await client.query(
    `INSERT INTO editorial_articles (
       kind, slug, title, subtitle, body_markdown, status, model, fact_check, sources, published_at
     ) VALUES ('feature', $1, $2, $3, $4, 'published', 'seed', $5, $6, $7)
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       subtitle = EXCLUDED.subtitle,
       body_markdown = EXCLUDED.body_markdown,
       status = 'published',
       fact_check = EXCLUDED.fact_check,
       sources = EXCLUDED.sources,
       updated_at = now()`,
    [
      doc.id,
      data.title,
      data.subtitle ?? '',
      doc.body,
      JSON.stringify({
        topic: data.topic ?? '',
        films: data.films ?? [],
        palette: data.palette ?? 'ash',
      }),
      JSON.stringify(data.sources ?? []),
      `${data.date ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`,
    ],
  );
}

/**
 * 把站点现有 Markdown 反向导入数据库，便于在无外部密钥时先跑通
 * 「数据库 → 发布」链路，也方便把手工修订的内容重新纳入工作流。
 */
export async function runSeed({ dryRun = false } = {}) {
  const films = await readCollection('films');
  const daily = await readCollection('daily');
  const magazine = await readCollection('magazine');
  const features = await readCollection('features');

  if (dryRun) {
    return {
      action: 'dry-run',
      films: films.length,
      daily: daily.length,
      magazine: magazine.length,
      features: features.length,
    };
  }

  await withTransaction(async (client) => {
    for (const doc of films) await importFilm(client, doc);
    for (const doc of daily) await importDaily(client, doc);
    for (const doc of magazine) await importMagazine(client, doc);
    for (const doc of features) await importFeature(client, doc);
  });

  return {
    action: 'seeded',
    films: films.length,
    daily: daily.length,
    magazine: magazine.length,
    features: features.length,
  };
}
