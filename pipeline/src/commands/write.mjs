import { chatJSON, countWords } from '../ai.mjs';
import { PROOFREAD_SYSTEM, proofreadPrompt, WRITE_SYSTEM, writePrompt } from '../prompts.mjs';
import { many, one } from '../db.mjs';
import { env } from '../env.mjs';
import { SQL_CANDIDATES_WITH_ASSESSMENT, SQL_FILM_BY_SLUG, toPromptFilm } from '../queries.mjs';

function filmSources(film) {
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

export async function proofreadArticle({ title, body, sources, film }) {
  const { data } = await chatJSON({
    system: PROOFREAD_SYSTEM,
    user: proofreadPrompt({ title, body, sources, film }),
    temperature: 0.1,
  });

  const issues = Array.isArray(data.issues) ? data.issues : [];
  const hasHigh = issues.some((issue) => issue.severity === 'high');
  return {
    // 是否可发布只看 high 级问题；medium/low 作为修改建议保留。
    passed: !hasHigh && sources.length > 0,
    issues,
    verdict: String(data.verdict ?? ''),
  };
}

async function writeReview(film) {
  const sources = filmSources(film);
  const assessment = {
    audience_score: film.audience_score,
    artistic_score: film.artistic_score,
    recommendation_score: film.recommendation_score,
    confidence: film.confidence,
    rationale: film.rationale,
    angle: film.angle,
    caveats: film.dimensions?.caveats ?? [],
  };

  const { data } = await chatJSON({
    system: WRITE_SYSTEM,
    user: writePrompt({
      film: { ...film, directors: film.directors ?? [] },
      assessment,
      angle: film.angle,
      sources,
    }),
    temperature: 0.65,
    maxTokens: 6000,
  });

  let title = String(data.title ?? '').trim();
  let body = String(data.body ?? '').trim();
  if (!title || countWords(body) < 500) {
    throw new Error(
      `生成的稿件不完整：${film.slug}（标题 ${title.length} 字，正文 ${countWords(body)} 字，字段 ${Object.keys(data).join('/')}）`,
    );
  }

  let check = await proofreadArticle({ title, body, sources, film });

  if (!check.passed) {
    const repair = await chatJSON({
      system: WRITE_SYSTEM,
      user: `上一版文章未通过校对，请根据问题清单重写，保持事实不变，不要新增未经提供的细节。\n\n问题清单：\n${check.issues
        .map((issue) => `- [${issue.type}/${issue.severity}] ${issue.problem}｜建议：${issue.fix}`)
        .join('\n')}\n\n原标题：${title}\n\n原正文：\n${body}`,
      temperature: 0.5,
      maxTokens: 6000,
    });
    title = String(repair.data.title ?? title).trim();
    body = String(repair.data.body ?? body).trim();
    check = await proofreadArticle({ title, body, sources, film });
  }

  const slug = `film-${film.slug}`;
  const articleSources = [
    ...sources,
    { label: 'CineScope 编辑部评估记录', retrieved: new Date().toISOString().slice(0, 10) },
  ];

  const row = await one(
    `INSERT INTO editorial_articles (
       kind, slug, title, subtitle, excerpt, body_markdown, film_id,
       language, word_count, status, model, prompt_version, fact_check, sources, updated_at
     ) VALUES (
       'film_review', $1, $2, $3, $4, $5, $6,
       'zh', $7, $8, $9, 'write-v1', $10, $11, now()
     )
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       subtitle = EXCLUDED.subtitle,
       excerpt = EXCLUDED.excerpt,
       body_markdown = EXCLUDED.body_markdown,
       word_count = EXCLUDED.word_count,
       status = EXCLUDED.status,
       model = EXCLUDED.model,
       fact_check = EXCLUDED.fact_check,
       sources = EXCLUDED.sources,
       updated_at = now()
     RETURNING id, status`,
    [
      slug,
      title,
      String(data.subtitle ?? '').trim(),
      String(data.pull_quote ?? '').trim().slice(0, 160),
      body,
      film.id,
      countWords(body),
      check.passed ? 'approved' : 'review',
      env.deepseekModel,
      JSON.stringify({ ...check, checked_at: new Date().toISOString() }),
      JSON.stringify(articleSources),
    ],
  );

  return {
    slug: film.slug,
    title,
    words: countWords(body),
    status: row.status,
    issues: check.issues.length,
    passed: check.passed,
  };
}

export async function runWrite({ limit = 3, slug, minScore = 66, dryRun = false } = {}) {
  let films;
  if (slug) {
    const film = await one(SQL_FILM_BY_SLUG, [slug]);
    if (!film) throw new Error(`未找到影片：${slug}`);
    const assessment = await one(
      `SELECT * FROM assessments WHERE film_id = $1 AND is_current`,
      [film.id],
    );
    if (!assessment) throw new Error(`影片 ${slug} 尚无评估，请先运行 assess`);
    films = [{ ...toPromptFilm(film), ...assessment, id: film.id }];
  } else {
    films = (await many(SQL_CANDIDATES_WITH_ASSESSMENT, [minScore, limit * 3])).map(toPromptFilm);
  }

  const existing = new Set(
    (
      await many(
        `SELECT film_id FROM editorial_articles WHERE kind = 'film_review' AND status IN ('approved','published')`,
      )
    ).map((row) => String(row.film_id)),
  );

  const todo = films.filter((film) => !existing.has(String(film.id))).slice(0, limit);
  const results = [];

  for (const film of todo) {
    if (dryRun) {
      results.push({ slug: film.slug, action: 'would-write' });
      continue;
    }
    results.push(await writeReview(film));
  }

  return { processed: results.length, results };
}

export async function runProofread({ limit = 5, dryRun = false } = {}) {
  const articles = await many(
    `SELECT a.id, a.slug, a.title, a.body_markdown, a.sources,
            f.title_zh, f.year, f.countries, f.languages, f.runtime, f.genres,
            (SELECT json_agg(p.name ORDER BY c.billing_order)
               FROM credits c JOIN people p ON p.id = c.person_id
              WHERE c.film_id = f.id AND c.role = 'director') AS directors,
            (SELECT json_agg(json_build_object('name', p.name) ORDER BY c.billing_order)
               FROM credits c JOIN people p ON p.id = c.person_id
              WHERE c.film_id = f.id AND c.role = 'actor') AS cast
     FROM editorial_articles a
     LEFT JOIN films f ON f.id = a.film_id
     WHERE a.status IN ('draft', 'review')
     ORDER BY a.updated_at DESC
     LIMIT $1`,
    [limit],
  );

  if (dryRun) {
    return { processed: 0, results: articles.map((article) => ({ slug: article.slug, action: 'would-proofread' })) };
  }

  const results = [];
  for (const article of articles) {
    const check = await proofreadArticle({
      title: article.title,
      body: article.body_markdown,
      sources: article.sources ?? [],
      film: {
        titleZh: article.title_zh,
        year: article.year,
        directors: article.directors ?? [],
        cast: article.cast ?? [],
        countries: article.countries ?? [],
        languages: article.languages ?? [],
        runtime: article.runtime,
        genres: article.genres ?? [],
      },
    });
    await one(
      `UPDATE editorial_articles
       SET status = $2, fact_check = $3, updated_at = now()
       WHERE id = $1 RETURNING id`,
      [
        article.id,
        check.passed ? 'approved' : 'review',
        JSON.stringify({ ...check, checked_at: new Date().toISOString() }),
      ],
    );
    results.push({ slug: article.slug, passed: check.passed, issues: check.issues.length });
  }
  return { processed: results.length, results };
}
