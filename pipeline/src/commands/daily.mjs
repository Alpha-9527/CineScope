import { chatJSON } from '../ai.mjs';
import { DAILY_EDITOR_SYSTEM, dailyPrompt } from '../prompts.mjs';
import { many, one, withTransaction } from '../db.mjs';
import { SQL_DAILY_POOL } from '../queries.mjs';
import { todayInTimezone } from '../env.mjs';

function pickFallback(pool, count = 3) {
  return pool.slice(0, count);
}

export async function runDaily({
  date = todayInTimezone(),
  minScore = 66,
  ignoreRecentDays = 21,
  dryRun = false,
  publish = false,
} = {}) {
  const existing = await one('SELECT id, issue_no, status FROM daily_editions WHERE edition_date = $1', [
    date,
  ]);
  if (existing && !dryRun) {
    throw new Error(`${date} 的每日刊物已存在（issue ${existing.issue_no}）。如需重做请先归档。`);
  }

  const pool = await many(SQL_DAILY_POOL, [minScore, ignoreRecentDays, 12]);
  if (pool.length < 2) {
    throw new Error('候选池不足，请先运行 discover / enrich / assess，或放宽 minScore。');
  }

  let plan;
  if (dryRun) {
    plan = {
      title: '（dry-run）今日推荐',
      subtitle: '（dry-run）',
      editor_intro: '（dry-run）',
      closing: '（dry-run）',
      selected: pickFallback(pool, 3).map((film) => ({
        title_zh: film.title_zh,
        note: '（dry-run）',
        angle: film.angle ?? '',
      })),
    };
  } else {
    const { data } = await chatJSON({
      system: DAILY_EDITOR_SYSTEM,
      user: dailyPrompt({ date, candidates: pool }),
      temperature: 0.6,
      maxTokens: 2500,
    });
    plan = data;
  }

  const byTitle = new Map(pool.map((film) => [film.title_zh.trim(), film]));
  const chosen = [];
  for (const item of plan.selected ?? []) {
    const film = byTitle.get(String(item.title_zh ?? '').trim());
    if (film && !chosen.some((entry) => entry.film.id === film.id)) {
      chosen.push({ film, note: String(item.note ?? '').slice(0, 120), angle: item.angle ?? '' });
    }
  }
  while (chosen.length < 2) {
    const candidate = pickFallback(pool).find((film) => !chosen.some((entry) => entry.film.id === film.id));
    if (!candidate) break;
    chosen.push({ film: candidate, note: candidate.angle ?? '编辑部认为它值得被更多观众看到。', angle: candidate.angle ?? '' });
  }
  chosen.splice(3);

  if (dryRun) {
    return {
      action: 'dry-run',
      date,
      title: plan.title,
      films: chosen.map(({ film, note }) => ({ slug: film.slug, title: film.title_zh, note })),
    };
  }

  const edition = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO daily_editions (issue_no, edition_date, title, subtitle, editor_intro, closing, status)
       VALUES (
         (SELECT coalesce(max(issue_no), 0) + 1 FROM daily_editions),
         $1, $2, $3, $4, $5, $6
       )
       RETURNING id, issue_no, edition_date, status`,
      [
        date,
        String(plan.title ?? '').slice(0, 40),
        String(plan.subtitle ?? '').slice(0, 120),
        String(plan.editor_intro ?? '').slice(0, 600),
        String(plan.closing ?? '').slice(0, 400),
        publish ? 'approved' : 'review',
      ],
    );
    const editionRow = rows[0];

    for (const [index, entry] of chosen.entries()) {
      await client.query(
        `INSERT INTO selection_items (edition_id, film_id, position, note, angle, is_lead)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [editionRow.id, entry.film.id, index + 1, entry.note, entry.angle, index === 0],
      );
      await client.query(
        `UPDATE films SET status = 'selected' WHERE id = $1 AND status = 'candidate'`,
        [entry.film.id],
      );
    }

    const body = [plan.editor_intro, plan.closing].filter(Boolean).join('\n\n');
    const sources = entries
      .filter(({ film }) => film.tmdb_id)
      .map(({ film }) => ({
        label: `TMDb：${film.title_zh}`,
        url: `https://www.themoviedb.org/movie/${film.tmdb_id}`,
        retrieved: date,
      }));
    if (sources.length === 0) {
      sources.push({ label: 'TMDb 影片基础资料', url: 'https://www.themoviedb.org/', retrieved: date });
    }
    await client.query(
      `INSERT INTO editorial_articles (kind, slug, title, subtitle, body_markdown, edition_id, status, model, sources)
       VALUES ('daily_intro', $1, $2, $3, $4, $5, 'approved', $6, $7)
       ON CONFLICT (slug) DO UPDATE SET body_markdown = EXCLUDED.body_markdown, sources = EXCLUDED.sources, updated_at = now()`,
      [
        `daily-${date}`,
        String(plan.title ?? ''),
        String(plan.subtitle ?? ''),
        body || '本期导语。',
        editionRow.id,
        'deepseek-chat',
        JSON.stringify(sources),
      ],
    );

    return editionRow;
  });

  return {
    action: 'created',
    date,
    issue: edition.issue_no,
    title: plan.title,
    status: edition.status,
    films: chosen.map(({ film, note }) => ({ slug: film.slug, title: film.title_zh, note })),
  };
}
