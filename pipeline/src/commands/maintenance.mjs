import { many, query } from '../db.mjs';

async function counts(label, sql) {
  const rows = await many(sql);
  return { label, rows };
}

function printReport(report) {
  for (const section of report) {
    console.log(`\n${section.label}`);
    if (section.rows.length === 0) {
      console.log('  （无）');
      continue;
    }
    for (const row of section.rows) {
      console.log(`  ${Object.values(row).join('  ·  ')}`);
    }
  }
}

/**
 * 维护任务：执行发布前的一致性检查与历史数据清理。
 * 规则来自规格中的「不编造、不无来源发布、发布可追溯」。
 */
export async function runMaintenance({ dryRun = false, logDays = 180, availabilityDays = 180 } = {}) {
  const report = [
    await counts('影片状态分布', `SELECT status, count(*)::int AS total FROM films GROUP BY status ORDER BY total DESC`),
    await counts(
      '内容状态分布',
      `SELECT kind, status, count(*)::int AS total FROM editorial_articles GROUP BY kind, status ORDER BY kind, status`,
    ),
    await counts(
      '待处理问题',
      `SELECT
         (SELECT count(*)::int FROM editorial_articles WHERE status = 'published' AND jsonb_array_length(sources) = 0) AS 无来源已发布文章,
         (SELECT count(*)::int FROM daily_editions d WHERE d.status = 'published'
            AND NOT EXISTS (SELECT 1 FROM selection_items s WHERE s.edition_id = d.id)) AS 空每日刊物,
         (SELECT count(*)::int FROM weekly_magazines m WHERE m.status = 'published'
            AND NOT EXISTS (SELECT 1 FROM weekly_items w WHERE w.magazine_id = m.id)) AS 空周刊,
         (SELECT count(*)::int FROM films f WHERE f.status = 'published'
            AND NOT EXISTS (
              SELECT 1 FROM editorial_articles a
              WHERE a.film_id = f.id AND a.kind = 'film_review' AND a.status = 'published'
            )) AS 无影评已发布影片,
         (SELECT count(*)::int FROM assessments WHERE is_current AND created_at < now() - INTERVAL '60 days') AS 超过60天未复核的评估`,
    ),
  ];

  printReport(report);

  if (dryRun) {
    console.log('\n（dry-run）未修改任何数据。');
    return { action: 'dry-run', report };
  }

  const demotedArticles = await query(
    `UPDATE editorial_articles
     SET status = 'review', updated_at = now()
     WHERE status = 'published' AND jsonb_array_length(sources) = 0
     RETURNING id`,
  );

  const demotedEditions = await query(
    `UPDATE daily_editions d
     SET status = 'review', updated_at = now()
     WHERE d.status = 'published'
       AND NOT EXISTS (SELECT 1 FROM selection_items s WHERE s.edition_id = d.id)
     RETURNING d.id`,
  );

  const demotedMagazines = await query(
    `UPDATE weekly_magazines m
     SET status = 'review', updated_at = now()
     WHERE m.status = 'published'
       AND NOT EXISTS (SELECT 1 FROM weekly_items w WHERE w.magazine_id = m.id)
     RETURNING m.id`,
  );

  const demotedFilms = await query(
    `UPDATE films f
     SET status = 'selected', updated_at = now()
     WHERE f.status = 'published'
       AND NOT EXISTS (
         SELECT 1 FROM editorial_articles a
         WHERE a.film_id = f.id AND a.kind = 'film_review' AND a.status = 'published'
       )
     RETURNING f.id`,
  );

  const removedLogs = await query(
    `DELETE FROM publish_logs WHERE started_at < now() - ($1::int * INTERVAL '1 day') RETURNING id`,
    [logDays],
  );

  const removedAvailability = await query(
    `DELETE FROM availability WHERE checked_at < now() - ($1::int * INTERVAL '1 day') RETURNING id`,
    [availabilityDays],
  );

  const summary = {
    action: 'maintained',
    demotedArticles: demotedArticles.rowCount,
    demotedEditions: demotedEditions.rowCount,
    demotedMagazines: demotedMagazines.rowCount,
    demotedFilms: demotedFilms.rowCount,
    removedLogs: removedLogs.rowCount,
    removedAvailability: removedAvailability.rowCount,
  };

  console.log('\n维护结果：', JSON.stringify(summary));
  return { ...summary, report };
}
