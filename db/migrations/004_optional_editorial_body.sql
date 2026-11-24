-- 每日/周刊的编辑说明正文允许为空：
-- 导语与总结分别存放在 daily_editions/write weekly 的 editor_intro / closing，
-- editorial_articles 里再拼一次就会在站点上重复。

ALTER TABLE editorial_articles
  DROP CONSTRAINT IF EXISTS editorial_articles_body_markdown_check;

ALTER TABLE editorial_articles
  ADD CONSTRAINT editorial_articles_body_markdown_check
  CHECK (kind IN ('daily_intro', 'weekly_editorial') OR length(btrim(body_markdown)) > 0);
