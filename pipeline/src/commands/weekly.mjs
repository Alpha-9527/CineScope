import { chatJSON } from '../ai.mjs';
import { WEEKLY_EDITOR_SYSTEM, weeklyPrompt } from '../prompts.mjs';
import { many, one, withTransaction } from '../db.mjs';
import { env, isoWeek, todayInTimezone } from '../env.mjs';

const PALETTES = new Set(['dusk', 'ember', 'moss', 'sand', 'ash', 'ink', 'rust', 'sea', 'paper']);

async function loadCandidates(limit = 20) {
  return many(
    `SELECT f.id, f.slug, f.title_zh, f.year, f.countries, f.tmdb_id, f.tmdb_popularity,
            a.artistic_score, a.final_score, a.rationale,
            a.dimensions->>'angle' AS angle
     FROM films f
     JOIN assessments a ON a.film_id = f.id AND a.is_current
     WHERE f.status IN ('selected', 'published')
       AND a.final_score >= 66
     ORDER BY a.final_score DESC
     LIMIT $1`,
    [limit],
  );
}

export async function runWeekly({
  year,
  week,
  date = todayInTimezone(),
  dryRun = false,
  publish = false,
} = {}) {
  const iso = isoWeek(date);
  const targetYear = year ?? iso.year;
  const targetWeek = week ?? iso.week;

  const existing = await one(
    'SELECT id, status FROM weekly_magazines WHERE year = $1 AND week = $2',
    [targetYear, targetWeek],
  );
  if (existing && !dryRun) {
    throw new Error(`${targetYear} 年第 ${targetWeek} 周的周刊已存在。`);
  }

  const candidates = await loadCandidates(20);
  if (candidates.length < 4) {
    throw new Error('候选影片不足（至少需要 4 部），请先完成评估。');
  }

  let plan;
  if (dryRun) {
    plan = {
      theme: '（dry-run）',
      title: '（dry-run）周刊',
      subtitle: '（dry-run）',
      editor_intro: '（dry-run）',
      closing: '（dry-run）',
      cover_palette: 'ash',
      picks: candidates.slice(0, 5).map((film) => ({ title_zh: film.title_zh, note: '（dry-run）' })),
      special_finds: candidates.slice(5, 7).map((film) => ({ title_zh: film.title_zh, note: '（dry-run）' })),
    };
  } else {
    const { data } = await chatJSON({
      system: WEEKLY_EDITOR_SYSTEM,
      user: weeklyPrompt({ year: targetYear, week: targetWeek, candidates }),
      temperature: 0.65,
      maxTokens: 4000,
    });
    plan = data;
  }

  const byTitle = new Map(candidates.map((film) => [film.title_zh.trim(), film]));
  const resolve = (list) =>
    (list ?? [])
      .map((item) => {
        const film = byTitle.get(String(item.title_zh ?? '').trim());
        return film ? { film, note: String(item.note ?? '').slice(0, 160) } : null;
      })
      .filter(Boolean);

  // 同一部影片在周刊中只能出现一次（weekly_items 有 UNIQUE (magazine_id, film_id)）。
  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((entry) => {
      const key = String(entry.film.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  let picks = dedupe(resolve(plan.picks));
  let finds = dedupe(resolve(plan.special_finds)).filter(
    (entry) => !picks.some((pick) => pick.film.id === entry.film.id),
  );

  if (picks.length < 4) {
    const used = new Set(picks.map((p) => p.film.id));
    for (const film of candidates) {
      if (picks.length >= 5) break;
      if (used.has(film.id)) continue;
      picks.push({ film, note: film.angle ?? '本周值得重新评估的一部作品。' });
    }
  }
  picks = picks.slice(0, 6);

  if (finds.length === 0) {
    const used = new Set(picks.map((p) => p.film.id));
    finds = candidates
      .filter((film) => !used.has(film.id))
      .slice(0, 2)
      .map((film) => ({ film, note: film.angle ?? '被主流视野忽略，但值得单独提出。' }));
  }
  // 兜底补片可能重复，再次确保 picks 与 finds 不交叉。
  finds = dedupe(finds).filter((entry) => !picks.some((pick) => pick.film.id === entry.film.id));

  const palette = PALETTES.has(plan.cover_palette) ? plan.cover_palette : 'ash';

  if (dryRun) {
    return {
      action: 'dry-run',
      year: targetYear,
      week: targetWeek,
      title: plan.title,
      theme: plan.theme,
      picks: picks.map((p) => ({ slug: p.film.slug, title: p.film.title_zh })),
      specialFinds: finds.map((p) => ({ slug: p.film.slug, title: p.film.title_zh })),
    };
  }

  const magazine = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO weekly_magazines (
         year, week, magazine_date, title, subtitle, theme, editor_intro, closing,
         cover_film_id, cover_palette, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, year, week`,
      [
        targetYear,
        targetWeek,
        date,
        String(plan.title ?? '').slice(0, 40),
        String(plan.subtitle ?? '').slice(0, 160),
        String(plan.theme ?? '').slice(0, 30),
        String(plan.editor_intro ?? '').slice(0, 900),
        String(plan.closing ?? '').slice(0, 500),
        picks[0]?.film.id ?? null,
        palette,
        publish ? 'approved' : 'review',
      ],
    );
    const row = rows[0];

    for (const [index, entry] of picks.entries()) {
      await client.query(
        `INSERT INTO weekly_items (magazine_id, film_id, section, position, note)
         VALUES ($1, $2, 'pick', $3, $4)`,
        [row.id, entry.film.id, index + 1, entry.note],
      );
    }
    for (const [index, entry] of finds.entries()) {
      await client.query(
        `INSERT INTO weekly_items (magazine_id, film_id, section, position, note)
         VALUES ($1, $2, 'special_find', $3, $4)`,
        [row.id, entry.film.id, index + 1, entry.note],
      );
    }

    // 同每日：导语与总结单独存储，避免周刊页面重复渲染。
    const body = '';
    const weeklySources = [...picks, ...finds]
      .filter(({ film }) => film.tmdb_id)
      .map(({ film }) => ({
        label: `TMDb：${film.title_zh}`,
        url: `https://www.themoviedb.org/movie/${film.tmdb_id}`,
        retrieved: date,
      }));
    if (weeklySources.length === 0) {
      weeklySources.push({
        label: 'TMDb 影片基础资料',
        url: 'https://www.themoviedb.org/',
        retrieved: date,
      });
    }
    await client.query(
      `INSERT INTO editorial_articles (kind, slug, title, subtitle, body_markdown, magazine_id, status, model, sources)
       VALUES ('weekly_editorial', $1, $2, $3, $4, $5, 'approved', $6, $7)
       ON CONFLICT (slug) DO UPDATE SET
         body_markdown = EXCLUDED.body_markdown,
         sources = EXCLUDED.sources,
         updated_at = now()`,
      [
        `weekly-${targetYear}-w${targetWeek}`,
        String(plan.title ?? ''),
        String(plan.subtitle ?? ''),
        body,
        row.id,
        env.deepseekModel,
        JSON.stringify(weeklySources),
      ],
    );

    return row;
  });

  return {
    action: 'created',
    year: magazine.year,
    week: magazine.week,
    title: plan.title,
    theme: plan.theme,
    picks: picks.map((p) => ({ slug: p.film.slug, title: p.film.title_zh })),
    specialFinds: finds.map((p) => ({ slug: p.film.slug, title: p.film.title_zh })),
  };
}
