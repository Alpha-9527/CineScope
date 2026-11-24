-- 003 —— 允许 publish_logs 记录站点构建（target = 'site'）
-- 001 中的 CHECK 只覆盖 content / git / cloudflare / rss，构建结果无法落库。
-- 新库直接使用 001 的最新定义，本迁移用于已经执行过 001 的现有数据库。

BEGIN;
SET search_path TO cinescope, public;

ALTER TABLE publish_logs DROP CONSTRAINT IF EXISTS publish_logs_target_check;
ALTER TABLE publish_logs
  ADD CONSTRAINT publish_logs_target_check
  CHECK (target IN ('content', 'git', 'site', 'cloudflare', 'rss'));

COMMIT;
