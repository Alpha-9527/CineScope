-- CineScope · 初始化数据库
-- 目标版本：PostgreSQL 15+
-- 执行方式：psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_init.sql
--
-- 设计原则
--   1. 影片元数据与"我们的判断"严格分表：films / ratings 存可核实事实，assessments 存编辑部评分。
--   2. 每一条公开内容都有状态机：draft → review → approved → published。
--   3. 发布是可追溯的：publish_logs 记录每一次构建与部署。

BEGIN;

-- 独立 schema，避免与同库中的 n8n 等应用表混在一起。
CREATE SCHEMA IF NOT EXISTS cinescope;
SET search_path TO cinescope, public;

-- ---------------------------------------------------------------------------
-- 枚举
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'film_status' AND typnamespace = 'cinescope'::regnamespace
  ) THEN
    CREATE TYPE film_status AS ENUM ('candidate', 'selected', 'published', 'rejected', 'archived');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'content_status' AND typnamespace = 'cinescope'::regnamespace
  ) THEN
    CREATE TYPE content_status AS ENUM ('draft', 'review', 'approved', 'published', 'rejected', 'archived');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'publish_status' AND typnamespace = 'cinescope'::regnamespace
  ) THEN
    CREATE TYPE publish_status AS ENUM ('pending', 'running', 'success', 'failed');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'article_kind' AND typnamespace = 'cinescope'::regnamespace
  ) THEN
    CREATE TYPE article_kind AS ENUM ('film_review', 'daily_intro', 'weekly_editorial', 'feature', 'brief');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'credit_role' AND typnamespace = 'cinescope'::regnamespace
  ) THEN
    CREATE TYPE credit_role AS ENUM ('director', 'actor', 'writer', 'composer', 'cinematographer', 'producer', 'editor');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. films —— 影片主数据（事实层）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS films (
  id                bigserial PRIMARY KEY,
  tmdb_id           integer UNIQUE,
  imdb_id           text UNIQUE,
  wikidata_id       text,
  slug              text NOT NULL UNIQUE,
  title_zh          text NOT NULL,
  title_original    text,
  title_en          text,
  year              smallint NOT NULL CHECK (year BETWEEN 1888 AND 2100),
  release_date      date,
  runtime           smallint CHECK (runtime > 0 AND runtime < 1200),
  countries         text[] NOT NULL DEFAULT '{}',
  languages         text[] NOT NULL DEFAULT '{}',
  genres            text[] NOT NULL DEFAULT '{}',
  overview_zh       text,
  overview_original text,
  poster_path       text,
  backdrop_path     text,
  tmdb_popularity   numeric(10, 3),
  tmdb_vote_average numeric(3, 1),
  tmdb_vote_count   integer,
  status            film_status NOT NULL DEFAULT 'candidate',
  discovered_from   text,
  source_updated_at timestamptz,
  last_synced_at    timestamptz,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(slug)) > 0),
  CHECK (length(btrim(title_zh)) > 0)
);

COMMENT ON TABLE films IS '影片主数据，仅保存可核实事实；评分与判断见 ratings / assessments';
COMMENT ON COLUMN films.slug IS '站内 URL 标识，发布后不可变更（变更需同步 301 重定向）';
COMMENT ON COLUMN films.status IS 'candidate=候选，selected=已入选，published=已发布，rejected=未采用，archived=下架';

-- ---------------------------------------------------------------------------
-- 2. people —— 影人
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people (
  id         bigserial PRIMARY KEY,
  tmdb_id    integer UNIQUE,
  name       text NOT NULL,
  name_zh    text,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. credits —— 影片与影人的关系
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credits (
  id            bigserial PRIMARY KEY,
  film_id       bigint NOT NULL REFERENCES films (id) ON DELETE CASCADE,
  person_id     bigint NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  role          credit_role NOT NULL,
  character     text,
  job           text,
  billing_order smallint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (film_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS idx_credits_film_role ON credits (film_id, role, billing_order);
CREATE INDEX IF NOT EXISTS idx_credits_person ON credits (person_id);

-- ---------------------------------------------------------------------------
-- 4. ratings —— 外部平台评分（只存事实，不与编辑部评分混用）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ratings (
  id          bigserial PRIMARY KEY,
  film_id     bigint NOT NULL REFERENCES films (id) ON DELETE CASCADE,
  source      text NOT NULL CHECK (source IN ('imdb', 'tmdb', 'douban', 'metacritic', 'rottentomatoes')),
  score       numeric(5, 2),
  vote_count  integer,
  url         text,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (film_id, source)
);

CREATE INDEX IF NOT EXISTS idx_ratings_film ON ratings (film_id);

-- ---------------------------------------------------------------------------
-- 5. availability —— 观看渠道
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS availability (
  id         bigserial PRIMARY KEY,
  film_id    bigint NOT NULL REFERENCES films (id) ON DELETE CASCADE,
  region     char(2) NOT NULL,
  platform   text NOT NULL,
  offer_type text NOT NULL CHECK (offer_type IN ('stream', 'rent', 'buy', 'cinema', 'tv')),
  url        text,
  price_note text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (film_id, region, platform, offer_type)
);

CREATE INDEX IF NOT EXISTS idx_availability_film ON availability (film_id, region);

-- ---------------------------------------------------------------------------
-- 6. assessments —— 编辑部评估（判断层）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessments (
  id                     bigserial PRIMARY KEY,
  film_id                bigint NOT NULL REFERENCES films (id) ON DELETE CASCADE,
  model                  text NOT NULL,
  prompt_version         text NOT NULL DEFAULT 'v1',
  rubric_version         text NOT NULL DEFAULT 'q-2026.1',
  audience_score         smallint CHECK (audience_score BETWEEN 0 AND 100),
  artistic_score         smallint CHECK (artistic_score BETWEEN 0 AND 100),
  recommendation_score   smallint CHECK (recommendation_score BETWEEN 0 AND 100),
  confidence             numeric(3, 2) CHECK (confidence BETWEEN 0 AND 1),
  quality_score          numeric(5, 2),
  final_score            numeric(5, 2),
  dimensions             jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence               jsonb NOT NULL DEFAULT '[]'::jsonb,
  rationale              text,
  is_current             boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (film_id, rubric_version, is_current)
);

COMMENT ON TABLE assessments IS '编辑部评分：R 观众口碑 / A 艺术价值 / D 推荐价值 / C 证据可信度';
COMMENT ON COLUMN assessments.final_score IS 'S = Q × C，Q = 0.35R + 0.40A + 0.25D（缺失维度按剩余权重归一化）';

CREATE INDEX IF NOT EXISTS idx_assessments_current ON assessments (is_current, final_score DESC);

-- ---------------------------------------------------------------------------
-- 7. daily_editions —— 每日刊物
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_editions (
  id            bigserial PRIMARY KEY,
  issue_no      integer NOT NULL UNIQUE,
  edition_date  date NOT NULL UNIQUE,
  title         text NOT NULL,
  subtitle      text,
  theme         text,
  editor_intro  text,
  closing       text,
  status        content_status NOT NULL DEFAULT 'draft',
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_status_date ON daily_editions (status, edition_date DESC);

-- ---------------------------------------------------------------------------
-- 8. selection_items —— 当期入选影片及编辑意见
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS selection_items (
  id         bigserial PRIMARY KEY,
  edition_id bigint NOT NULL REFERENCES daily_editions (id) ON DELETE CASCADE,
  film_id    bigint NOT NULL REFERENCES films (id) ON DELETE RESTRICT,
  position   smallint NOT NULL CHECK (position BETWEEN 1 AND 10),
  note       text NOT NULL,
  angle      text,
  is_lead    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (edition_id, film_id),
  UNIQUE (edition_id, position)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_selection_lead ON selection_items (edition_id) WHERE is_lead;

-- ---------------------------------------------------------------------------
-- 9. weekly_magazines —— 每周杂志
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weekly_magazines (
  id            bigserial PRIMARY KEY,
  year          smallint NOT NULL,
  week          smallint NOT NULL CHECK (week BETWEEN 1 AND 53),
  magazine_date date NOT NULL UNIQUE,
  title         text NOT NULL,
  subtitle      text,
  theme         text NOT NULL,
  editor_intro  text,
  closing       text,
  cover_film_id bigint REFERENCES films (id) ON DELETE SET NULL,
  cover_palette text NOT NULL DEFAULT 'ash',
  status        content_status NOT NULL DEFAULT 'draft',
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (year, week)
);

-- ---------------------------------------------------------------------------
-- 10. weekly_items —— 周刊片单
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weekly_items (
  id          bigserial PRIMARY KEY,
  magazine_id bigint NOT NULL REFERENCES weekly_magazines (id) ON DELETE CASCADE,
  film_id     bigint NOT NULL REFERENCES films (id) ON DELETE RESTRICT,
  section     text NOT NULL CHECK (section IN ('pick', 'special_find', 'revisit')),
  position    smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
  note        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (magazine_id, film_id),
  UNIQUE (magazine_id, section, position)
);

-- ---------------------------------------------------------------------------
-- 11. editorial_articles —— 所有文章正文
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS editorial_articles (
  id             bigserial PRIMARY KEY,
  kind           article_kind NOT NULL,
  slug           text NOT NULL UNIQUE,
  title          text NOT NULL,
  subtitle       text,
  excerpt        text,
  body_markdown  text NOT NULL,
  film_id        bigint REFERENCES films (id) ON DELETE SET NULL,
  edition_id     bigint REFERENCES daily_editions (id) ON DELETE SET NULL,
  magazine_id    bigint REFERENCES weekly_magazines (id) ON DELETE SET NULL,
  language       char(2) NOT NULL DEFAULT 'zh',
  word_count     integer,
  status         content_status NOT NULL DEFAULT 'draft',
  model          text,
  prompt_version text,
  fact_check     jsonb NOT NULL DEFAULT '{}'::jsonb,
  sources        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  CHECK (length(btrim(body_markdown)) > 0)
);

COMMENT ON COLUMN editorial_articles.sources IS '来源数组：[{label,url,retrieved}]，缺失来源的文章不得发布';
COMMENT ON COLUMN editorial_articles.fact_check IS '校对结果：{passed, issues[], checked_at, model}';

CREATE INDEX IF NOT EXISTS idx_articles_status_kind ON editorial_articles (status, kind);
CREATE INDEX IF NOT EXISTS idx_articles_film ON editorial_articles (film_id);
CREATE INDEX IF NOT EXISTS idx_articles_edition ON editorial_articles (edition_id);
CREATE INDEX IF NOT EXISTS idx_articles_magazine ON editorial_articles (magazine_id);

-- ---------------------------------------------------------------------------
-- 12. publish_logs —— 发布记录
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS publish_logs (
  id           bigserial PRIMARY KEY,
  target       text NOT NULL CHECK (target IN ('content', 'git', 'cloudflare', 'rss')),
  status       publish_status NOT NULL DEFAULT 'pending',
  reference    text,
  commit_sha   text,
  pages_built  integer,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_publish_target_started ON publish_logs (target, started_at DESC);

COMMIT;
