import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { CONTENT_DIR, REPO_ROOT, SITE_DIR, env } from '../env.mjs';
import { many, query, logPublish } from '../db.mjs';

const PALETTES = ['dusk', 'ember', 'moss', 'sand', 'ash', 'ink', 'rust', 'sea', 'paper'];

/** 同一条目稳定映射到同一套配色，避免每次发布视觉跳动。 */
function paletteFor(input, preferred) {
  if (PALETTES.includes(preferred)) return preferred;
  let hash = 0;
  for (const char of String(input)) hash = (hash * 31 + char.codePointAt(0)) % 997;
  return PALETTES[hash % PALETTES.length];
}

function toISODate(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toMarkdown(frontmatter, body) {
  const head = yaml.dump(frontmatter, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd();
  return `---\n${head}\n---\n\n${String(body ?? '').trim()}\n`;
}

async function writeIfChanged(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let previous = null;
  try {
    previous = await fs.readFile(filePath, 'utf8');
  } catch {
    previous = null;
  }
  if (previous === content) return 'unchanged';
  await fs.writeFile(filePath, content, 'utf8');
  return previous === null ? 'created' : 'updated';
}

function tmdbSources(film) {
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

function normalizeSources(raw, fallback = []) {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = list
    .filter((item) => item && item.label)
    .map((item) => ({
      label: String(item.label),
      ...(item.url ? { url: String(item.url) } : {}),
      ...(item.retrieved ? { retrieved: toISODate(item.retrieved) } : {}),
    }));
  return cleaned.length > 0 ? cleaned : fallback;
}

function filmFrontmatter(film) {
  const directors = (film.directors ?? []).filter(Boolean);
  const cast = (film.cast ?? []).map((person) => person?.name).filter(Boolean);
  const angle = film.dimensions?.angle ?? film.selection_angle ?? undefined;
  return {
    title: film.title_zh,
    originalTitle: film.title_original || film.title_en || film.title_zh,
    year: film.year,
    countries: film.countries ?? [],
    language: (film.languages ?? [])[0] ?? '—',
    runtime: film.runtime ?? 0,
    directors: directors.length > 0 ? directors : ['未知'],
    cast: [...new Set(cast)],
    genres: film.genres ?? [],
    palette: paletteFor(film.slug, film.metadata?.palette),
    ...(film.poster_path ? { poster: film.poster_path } : {}),
    ...(film.backdrop_path ? { backdrop: film.backdrop_path } : {}),
    ...(film.tmdb_id ? { tmdbId: film.tmdb_id } : {}),
    ...(film.imdb_id ? { imdbId: film.imdb_id } : {}),
    ratings: {
      ...(film.imdb_score !== null && film.imdb_score !== undefined
        ? { imdb: Number(film.imdb_score) }
        : {}),
      ...(film.imdb_votes ? { votes: film.imdb_votes } : {}),
      source: film.imdb_score ? 'IMDb 官方数据集' : 'TMDb 用户评分',
    },
    scores: {
      audience: Math.round(Number(film.audience_score ?? 0)),
      artistic: Math.round(Number(film.artistic_score ?? 0)),
      recommendation: Math.round(Number(film.recommendation_score ?? 0)),
      confidence: Number(Number(film.confidence ?? 0).toFixed(2)),
      final: Math.round(Number(film.final_score ?? 0)),
    },
    selection: {
      ...(film.issue_date ? { issue: toISODate(film.issue_date) } : {}),
      ...(angle ? { angle: String(angle) } : {}),
    },
    dataStatus: 'verified',
    sources: normalizeSources(film.article_sources, tmdbSources(film)),
  };
}

async function exportFilms({ dryRun }) {
  const films = await many(
    `SELECT f.*,
            ar.id AS article_id, ar.title AS article_title, ar.subtitle AS article_subtitle,
            ar.body_markdown, ar.sources AS article_sources,
            a.audience_score, a.artistic_score, a.recommendation_score,
            a.confidence, a.final_score, a.dimensions,
            r.score AS imdb_score, r.vote_count AS imdb_votes,
            (SELECT json_agg(json_build_object('name', p.name, 'character', c.character)
                             ORDER BY c.billing_order)
               FROM credits c JOIN people p ON p.id = c.person_id
              WHERE c.film_id = f.id AND c.role = 'actor') AS cast,
            (SELECT json_agg(p.name ORDER BY c.billing_order)
               FROM credits c JOIN people p ON p.id = c.person_id
              WHERE c.film_id = f.id AND c.role = 'director') AS directors,
            (SELECT d.edition_date
               FROM selection_items s JOIN daily_editions d ON d.id = s.edition_id
              WHERE s.film_id = f.id ORDER BY d.edition_date DESC LIMIT 1) AS issue_date,
            (SELECT s.angle
               FROM selection_items s JOIN daily_editions d ON d.id = s.edition_id
              WHERE s.film_id = f.id ORDER BY d.edition_date DESC LIMIT 1) AS selection_angle
     FROM editorial_articles ar
     JOIN films f ON f.id = ar.film_id
     JOIN assessments a ON a.film_id = f.id AND a.is_current
     LEFT JOIN ratings r ON r.film_id = f.id AND r.source = 'imdb'
     WHERE ar.kind = 'film_review'
       AND ar.status IN ('approved', 'published')
       AND f.status NOT IN ('archived', 'rejected')
     ORDER BY a.final_score DESC`,
  );

  const results = [];
  for (const film of films) {
    const filePath = path.join(CONTENT_DIR, 'films', `${film.slug}.md`);
    const body =
      String(film.body_markdown ?? '').trim() ||
      String(film.overview_zh ?? '').trim() ||
      `${film.title_zh}（${film.year}）由 ${film.directors?.[0] ?? '未知导演'} 执导。`;
    const content = toMarkdown(filmFrontmatter(film), body);
    results.push({
      slug: film.slug,
      path: filePath,
      action: dryRun ? 'would-write' : await writeIfChanged(filePath, content),
      articleId: film.article_id,
      filmId: film.id,
    });
  }
  return results;
}

async function exportDaily({ dryRun }) {
  const editions = await many(
    `SELECT d.*, ar.id AS article_id, ar.body_markdown, ar.sources AS article_sources
     FROM daily_editions d
     LEFT JOIN editorial_articles ar
       ON ar.edition_id = d.id AND ar.kind = 'daily_intro'
     WHERE d.status IN ('approved', 'published')
     ORDER BY d.edition_date ASC`,
  );
  if (editions.length === 0) return [];

  const items = await many(
    `SELECT s.edition_id, s.position, s.note, s.angle, s.is_lead,
            f.slug, f.title_zh, f.tmdb_id, f.imdb_id
     FROM selection_items s
     JOIN films f ON f.id = s.film_id
     JOIN daily_editions d ON d.id = s.edition_id
     WHERE d.status IN ('approved', 'published')
     ORDER BY s.edition_id, s.position`,
  );

  const results = [];
  for (const edition of editions) {
    const picks = items.filter((item) => item.edition_id === edition.id);
    if (picks.length < 1) continue;

    const date = toISODate(edition.edition_date);
    const frontmatter = {
      date,
      issue: edition.issue_no,
      title: edition.title,
      subtitle: edition.subtitle ?? '',
      editorIntro: edition.editor_intro ?? '',
      films: picks.map((pick) => ({ slug: pick.slug, note: pick.note ?? '' })),
      closing: edition.closing ?? '',
      sources: normalizeSources(edition.article_sources, [
        { label: 'TMDb 影片基础资料', retrieved: new Date().toISOString().slice(0, 10) },
      ]),
    };

    const filePath = path.join(CONTENT_DIR, 'daily', `${date}.md`);
    const body = String(edition.body_markdown ?? '').trim();
    results.push({
      slug: date,
      path: filePath,
      action: dryRun ? 'would-write' : await writeIfChanged(filePath, toMarkdown(frontmatter, body)),
      articleId: edition.article_id,
      editionId: edition.id,
    });
  }
  return results;
}

async function exportWeekly({ dryRun }) {
  const magazines = await many(
    `SELECT m.*, ar.id AS article_id, ar.body_markdown, ar.sources AS article_sources,
            cf.slug AS cover_slug
     FROM weekly_magazines m
     LEFT JOIN editorial_articles ar
       ON ar.magazine_id = m.id AND ar.kind = 'weekly_editorial'
     LEFT JOIN films cf ON cf.id = m.cover_film_id
     WHERE m.status IN ('approved', 'published')
     ORDER BY m.magazine_date ASC`,
  );
  if (magazines.length === 0) return [];

  const items = await many(
    `SELECT w.magazine_id, w.section, w.position, w.note, f.slug
     FROM weekly_items w
     JOIN films f ON f.id = w.film_id
     JOIN weekly_magazines m ON m.id = w.magazine_id
     WHERE m.status IN ('approved', 'published')
     ORDER BY w.magazine_id, w.section, w.position`,
  );

  const results = [];
  for (const magazine of magazines) {
    const own = items.filter((item) => item.magazine_id === magazine.id);
    const picks = own.filter((item) => item.section === 'pick');
    const finds = own.filter((item) => item.section === 'special_find');
    if (picks.length < 1) continue;

    const frontmatter = {
      year: magazine.year,
      week: magazine.week,
      date: toISODate(magazine.magazine_date),
      title: magazine.title,
      subtitle: magazine.subtitle ?? '',
      theme: magazine.theme,
      editorIntro: magazine.editor_intro ?? '',
      coverPalette: paletteFor(`week-${magazine.year}-${magazine.week}`, magazine.cover_palette),
      ...(magazine.cover_slug ? { leadFilm: magazine.cover_slug } : {}),
      picks: picks.map((pick) => ({ slug: pick.slug, note: pick.note ?? '' })),
      specialFinds: finds.map((find) => ({ slug: find.slug, note: find.note ?? '' })),
      closing: magazine.closing ?? '',
      sources: normalizeSources(magazine.article_sources, [
        { label: 'TMDb 影片基础资料', retrieved: new Date().toISOString().slice(0, 10) },
      ]),
    };

    const filePath = path.join(CONTENT_DIR, 'magazine', `${magazine.year}-week-${magazine.week}.md`);
    const body = String(magazine.body_markdown ?? '').trim();
    results.push({
      slug: `${magazine.year}-week-${magazine.week}`,
      path: filePath,
      action: dryRun ? 'would-write' : await writeIfChanged(filePath, toMarkdown(frontmatter, body)),
      articleId: magazine.article_id,
      magazineId: magazine.id,
    });
  }
  return results;
}

async function exportFeatures({ dryRun }) {
  const features = await many(
    `SELECT a.*, f.slug AS film_slug
     FROM editorial_articles a
     LEFT JOIN films f ON f.id = a.film_id
     WHERE a.kind = 'feature' AND a.status IN ('approved', 'published')
     ORDER BY coalesce(a.published_at, a.created_at) DESC`,
  );

  const results = [];
  for (const feature of features) {
    const meta = feature.fact_check ?? {};
    const frontmatter = {
      title: feature.title,
      subtitle: feature.subtitle ?? '',
      date: toISODate(feature.published_at ?? feature.created_at),
      topic: meta.topic || feature.subtitle || '专题',
      films: Array.isArray(meta.films) ? meta.films : feature.film_slug ? [feature.film_slug] : [],
      palette: paletteFor(feature.slug, meta.palette),
      sources: normalizeSources(feature.sources, [
        { label: 'TMDb 影片基础资料', retrieved: new Date().toISOString().slice(0, 10) },
      ]),
    };
    const filePath = path.join(CONTENT_DIR, 'features', `${feature.slug}.md`);
    results.push({
      slug: feature.slug,
      path: filePath,
      action: dryRun
        ? 'would-write'
        : await writeIfChanged(filePath, toMarkdown(frontmatter, feature.body_markdown)),
      articleId: feature.id,
    });
  }
  return results;
}

function summarize(results) {
  return results.reduce(
    (acc, item) => {
      acc[item.action] = (acc[item.action] ?? 0) + 1;
      return acc;
    },
    { created: 0, updated: 0, unchanged: 0, 'would-write': 0 },
  );
}

async function updateStatuses({ films, daily, weekly, features }) {
  const filmIds = films.map((item) => item.filmId).filter(Boolean);
  if (filmIds.length > 0) {
    await query(`UPDATE films SET status = 'published' WHERE id = ANY($1::bigint[])`, [filmIds]);
  }

  const filmArticleIds = films.map((item) => item.articleId).filter(Boolean);
  const dailyArticleIds = daily.map((item) => item.articleId).filter(Boolean);
  const weeklyArticleIds = weekly.map((item) => item.articleId).filter(Boolean);
  const featureArticleIds = features.map((item) => item.articleId).filter(Boolean);
  const allArticles = [...filmArticleIds, ...dailyArticleIds, ...weeklyArticleIds, ...featureArticleIds];
  if (allArticles.length > 0) {
    await query(
      `UPDATE editorial_articles
       SET status = 'published', published_at = coalesce(published_at, now()), updated_at = now()
       WHERE id = ANY($1::bigint[])`,
      [allArticles],
    );
  }

  const editionIds = daily.map((item) => item.editionId).filter(Boolean);
  if (editionIds.length > 0) {
    await query(
      `UPDATE daily_editions
       SET status = 'published', published_at = coalesce(published_at, now()), updated_at = now()
       WHERE id = ANY($1::bigint[])`,
      [editionIds],
    );
  }

  const magazineIds = weekly.map((item) => item.magazineId).filter(Boolean);
  if (magazineIds.length > 0) {
    await query(
      `UPDATE weekly_magazines
       SET status = 'published', published_at = coalesce(published_at, now()), updated_at = now()
       WHERE id = ANY($1::bigint[])`,
      [magazineIds],
    );
  }
}

function git(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function pushCommit() {
  const branchResult = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = (branchResult.stdout ?? '').trim() || 'main';
  const result = spawnSync('git', ['push', 'origin', `HEAD:${branch}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) {
    throw new Error(`git push 失败：${(result.stderr || result.stdout || '').slice(-1200)}`);
  }
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  return { pushed: true, branch, sha };
}

async function commitContent(relativePaths) {
  if (relativePaths.length === 0) return { committed: false, sha: null };

  const add = git(['add', ...relativePaths]);
  if (add.status !== 0) throw new Error(`git add 失败：${add.stderr || add.stdout}`);

  const diff = git(['diff', '--cached', '--quiet']);
  if (diff.status === 0) return { committed: false, sha: null };

  const commit = git(['commit', '-m', `content: publish ${new Date().toISOString().slice(0, 10)}`]);
  if (commit.status !== 0) throw new Error(`git commit 失败：${commit.stderr || commit.stdout}`);

  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  return { committed: true, sha };
}

function buildSite() {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: SITE_DIR,
    encoding: 'utf8',
    env: { ...process.env, SITE_URL: env.siteUrl },
  });
  if (result.status !== 0) {
    throw new Error(`站点构建失败：${(result.stderr || result.stdout || '').slice(-1200)}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const pages = [...output.matchAll(/(\d+)\s+page/gi)].map((match) => Number(match[1]));
  return { pages: pages.length > 0 ? Math.max(...pages) : null };
}

async function triggerDeploy() {
  if (!env.cloudflareHook) {
    throw new Error('未配置 CLOUDFLARE_DEPLOY_HOOK，无法触发部署。');
  }
  const response = await fetch(env.cloudflareHook, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare Deploy Hook 返回 ${response.status}`);
  }
  return response.status;
}

/**
 * 把数据库中已批准的内容导出为站点 Markdown，随后回写发布状态。
 * 这是「数据库 → 静态站」的唯一出口，站点不直接依赖数据库。
 */
export async function runPublish({
  dryRun = false,
  commit = false,
  push = false,
  build = false,
  deploy = false,
} = {}) {
  const films = await exportFilms({ dryRun });
  const daily = await exportDaily({ dryRun });
  const weekly = await exportWeekly({ dryRun });
  const features = await exportFeatures({ dryRun });

  const all = [...films, ...daily, ...weekly, ...features];
  const summary = {
    action: dryRun ? 'dry-run' : 'published',
    films: films.length,
    daily: daily.length,
    magazine: weekly.length,
    features: features.length,
    files: summarize(all),
  };

  if (dryRun) {
    return { ...summary, details: all.map(({ path: filePath, action }) => ({ path: filePath, action })) };
  }

  await updateStatuses({ films, daily, weekly, features });

  await logPublish({
    target: 'content',
    status: 'success',
    reference: `${all.length} files`,
    detail: summary,
  });

  const output = { ...summary };
  let stage = 'git';

  try {
    if (commit) {
      stage = 'git';
      const relative = all.map((item) => path.relative(REPO_ROOT, item.path));
      const result = await commitContent(relative);
      output.git = result;
      await logPublish({
        target: 'git',
        status: 'success',
        reference: result.sha ?? 'no-change',
        detail: { files: relative.length },
        commitSha: result.sha,
      });
    }

    if (build) {
      stage = 'site';
      output.build = buildSite();
      await logPublish({
        target: 'site',
        status: 'success',
        reference: `${output.build.pages ?? '?'} pages`,
        detail: output.build,
        pagesBuilt: output.build.pages,
      });
    }

    if (push) {
      stage = 'git';
      output.push = pushCommit();
      await logPublish({
        target: 'git',
        status: 'success',
        reference: `pushed ${output.push.branch}`,
        detail: { sha: output.push.sha },
        commitSha: output.push.sha,
      });
    }

    if (deploy) {
      stage = 'cloudflare';
      output.deploy = { status: await triggerDeploy() };
      await logPublish({ target: 'cloudflare', status: 'success', reference: env.siteUrl });
    }
  } catch (error) {
    await logPublish({
      target: stage,
      status: 'failed',
      reference: null,
      detail: output,
      error: String(error.message ?? error).slice(0, 800),
    });
    throw error;
  }

  return output;
}
