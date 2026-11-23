-- CineScope · 派生对象：updated_at 触发器、唯一性约束补充与只读视图
-- 执行方式：psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_views.sql

BEGIN;

CREATE SCHEMA IF NOT EXISTS cinescope;
SET search_path TO cinescope, public;

-- ---------------------------------------------------------------------------
-- updated_at 自动维护
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_films_touch ON films;
CREATE TRIGGER trg_films_touch
  BEFORE UPDATE ON films
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_people_touch ON people;
CREATE TRIGGER trg_people_touch
  BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_daily_touch ON daily_editions;
CREATE TRIGGER trg_daily_touch
  BEFORE UPDATE ON daily_editions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_weekly_touch ON weekly_magazines;
CREATE TRIGGER trg_weekly_touch
  BEFORE UPDATE ON weekly_magazines
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_articles_touch ON editorial_articles;
CREATE TRIGGER trg_articles_touch
  BEFORE UPDATE ON editorial_articles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 评估历史需要保留：去掉会阻止多条历史记录的普通唯一约束，
-- 只保留"每部影片最多一条当前评估"的部分唯一索引。
ALTER TABLE assessments
  DROP CONSTRAINT IF EXISTS assessments_film_id_rubric_version_is_current_key;

-- 每部影片只能有一条"当前"评估
CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_current_per_film
  ON assessments (film_id)
  WHERE is_current;

-- 已发布文章必须有来源
ALTER TABLE editorial_articles
  DROP CONSTRAINT IF EXISTS chk_articles_sources_when_published;
ALTER TABLE editorial_articles
  ADD CONSTRAINT chk_articles_sources_when_published
  CHECK (status <> 'published' OR jsonb_array_length(sources) > 0);

-- ---------------------------------------------------------------------------
-- 视图：影片 + 当前评估 + 外部评分
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_films_current AS
SELECT
  f.id,
  f.slug,
  f.title_zh,
  f.title_original,
  f.year,
  f.runtime,
  f.countries,
  f.languages,
  f.genres,
  f.status,
  f.poster_path,
  f.backdrop_path,
  a.audience_score,
  a.artistic_score,
  a.recommendation_score,
  a.confidence,
  a.quality_score,
  a.final_score,
  a.rubric_version,
  r.score AS imdb_score,
  r.vote_count AS imdb_votes,
  f.updated_at
FROM films f
LEFT JOIN assessments a ON a.film_id = f.id AND a.is_current
LEFT JOIN ratings r ON r.film_id = f.id AND r.source = 'imdb';

COMMENT ON VIEW v_films_current IS '发布构建使用的影片读取视图';

-- ---------------------------------------------------------------------------
-- 视图：每日刊物 + 影片数量 + 主推影片
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_editions AS
SELECT
  d.id,
  d.issue_no,
  d.edition_date,
  d.title,
  d.status,
  count(s.id) AS film_count,
  max(f.slug) FILTER (WHERE s.is_lead) AS lead_slug,
  d.published_at
FROM daily_editions d
LEFT JOIN selection_items s ON s.edition_id = d.id
LEFT JOIN films f ON f.id = s.film_id
GROUP BY d.id;

-- ---------------------------------------------------------------------------
-- 视图：周刊目录
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_weekly_catalog AS
SELECT
  m.id,
  m.year,
  m.week,
  m.magazine_date,
  m.title,
  m.theme,
  m.status,
  count(w.id) AS item_count,
  m.published_at
FROM weekly_magazines m
LEFT JOIN weekly_items w ON w.magazine_id = m.id
GROUP BY m.id;

COMMIT;
