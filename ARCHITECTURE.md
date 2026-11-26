# CineScope · 架构与运行原理

> 版本 1.0 · 2026-11-25  
> 面向接手维护的工程师。读完本文档你应当能：在 30 分钟内理解项目在做什么、数据怎么流、哪里出问题该去看哪。

---

## 一、项目是什么

CineScope 是一个 **AI 驱动的中文电影编辑平台**。它不接用户提交，不做社区，不跑在线后端——它每天自动发现一批值得说的电影，由 AI 写好影评和每日推荐，然后把这些内容作为 **静态 Markdown 文件** 导出到 Git 仓库里。Cloudflare Pages 只要看到 main 分支有 push，就自动 build Astro 站点并上线。

换句话说，它是一条 **内容自动化管线**，把「公开的电影资料 + 一个 AI 模型」变成「一个可访问的电影媒体网站」。

**它的设计原则：**

- **数据库是唯一真源**。所有内容先写 PostgreSQL，发布时从数据库抽出来导出 Markdown。站点本身不查询数据库，完全静态。
- **内容状态机**。每一篇内容（影片 / 影评 / 每日刊 / 周刊）都有明确的状态流转，publish 命令只导出 `approved / published` 的东西。
- **AI 调用有防护**。每条 AI 输出先 JSON 解析 → 校对 prompt 再过一遍 → 不合格会触发重写。DeepSeek 用 JSON mode（`response_format=json_object`），超时 180s，指数退避重试 3 次。
- **运行模式可选**。默认推荐 **手动一键**：每天打开一次电脑 `node scripts/run-daily.mjs` 就走完整链路。也支持 **全自动**：n8n 里 8 个定时工作流 24/7 跑。两者共享同一套 pipeline 代码。

---

## 二、整体架构（三层）

```
┌─────────────────────────────────────────────────────────────────┐
│                   上游数据源（外部系统）                          │
│                                                                 │
│   TMDb API                  DeepSeek API                        │
│   · /discover/movie         · /chat/completions                 │
│   · /movie/{id}             · JSON mode + 温度可调               │
│   · /movie/{id}/watch/providers                                 │
└─────────────────────────┬───────────────────────────────────────┘
                          │ fetch（pipeline 内部做限流和重试）
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                  生产端（本项目核心，Node.js）                     │
│                                                                 │
│  ┌──────────┐    ┌──────────────────┐    ┌──────────────────┐   │
│  │  n8n     │───▶│  Pipeline CLI     │───▶│  PostgreSQL 15+   │   │
│  │  调度器  │    │  discover         │    │  search_path=    │   │
│  │  或      │    │  enrich           │    │  cinescope       │   │
│  │  手动调用 │    │  assess (AI)      │    └──────────────────┘   │
│  └──────────┘    │  write  (AI)      │                           │
│                  │  daily  (AI)      │                           │
│                  │  weekly (AI)      │                           │
│                  │  publish          │                           │
│                  └────────┬─────────┘                           │
│                           │  DB → Markdown 文件导出               │
└───────────────────────────┼─────────────────────────────────────┘
                            │ 写文件到 site/src/content/**
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                     发布链（Git + Cloudflare）                    │
│                                                                 │
│  Pipeline publish --commit                                      │
│        │                                                        │
│        ▼                                                        │
│  git add site/src/content                                       │
│  git commit "content: publish YYYY-MM-DD"                       │
│  git push origin main    ← 宿主机 cron 每 10 分钟补推 / 直接推   │
│        │                                                        │
│        ▼                                                        │
│  Cloudflare Pages（push 触发）                                   │
│    · astro build                                                │
│    · 产物 site/dist/**                                          │
│    · 部署到 cinescope.pages.dev                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、目录结构

```
cinescope/
├── ARCHITECTURE.md          ← 你现在在读的文档
├── README.md                ← 快速上手 + n8n 工作流说明
├── .env.example             ← 环境变量模板（DATABASE_URL / TMDB_API_KEY / DEEPSEEK_API_KEY / ...）
├── .gitignore               ← 排除 .env, node_modules, dist, backups
│
├── db/
│   └── migrations/
│       ├── 001_init.sql              ← PostgreSQL schema + 枚举 + 所有表
│       ├── 002_views.sql            ← 几个常用查询视图
│       ├── 003_publish_log_targets.sql  ← publish_logs 的 target 枚举更新
│       └── 004_optional_editorial_body.sql  ← daily/weekly body 允许为空的 CHECK 约束
│
├── pipeline/                ← 核心：Node.js ESM
│   ├── package.json         ← dotenv / pg / gray-matter / js-yaml，无原生依赖
│   └── src/
│       ├── cli.mjs          ← 命令行入口，subcommand 分发
│       ├── env.mjs          ← 环境变量 + 路径常量（REPO_ROOT / SITE_DIR / CONTENT_DIR）
│       ├── db.mjs           ← pg.Pool 单例 + query/one/many/withTransaction/logPublish
│       ├── tmdb.mjs         ← TMDb API 封装（限流 3.8 req/s + 重试） + mapMovie 归一化
│       ├── ai.mjs           ← DeepSeek chatJSON（JSON mode + 失败时自动修复一次）
│       ├── score.mjs        ← 评分公式 + decideStatus 状态判定
│       ├── prompts.mjs      ← 所有 system prompt 和 user prompt 模板
│       ├── queries.mjs      ← 常用 SQL 字符串常量（按场景组织）
│       └── commands/
│           ├── discover.mjs ← TMDb → PostgreSQL，候选电影入库
│           ├── enrich.mjs   ← 补全演职员 / 流媒体平台 availability / 刷新评分
│           ├── assess.mjs   ← AI 三维打分（audience / artistic / recommendation）
│           ├── write.mjs    ← AI 写影评 + proofread 校对
│           ├── daily.mjs    ← AI 组今日推荐 2~3 部
│           ├── weekly.mjs   ← AI 组本周 pick 5 部 + special_finds 2 部
│           ├── publish.mjs  ← DB → Markdown + git commit + git push（核心出口）
│           └── maintain.mjs ← 清理过期数据 / 日志 / 一致性检查
│
├── site/                    ← Astro 5 静态站
│   ├── astro.config.mjs     ← root='./src/content'，adapter='@astrojs/static'
│   ├── content.config.ts    ← Zod schema 定义 films/daily/magazine/features frontmatter
│   ├── package.json         ← astro / @astrojs/rss / @astrojs/sitemap / tailwindcss v4
│   └── src/
│       ├── content/         ← pipeline publish 的写入目标（git 追踪）
│       │   ├── films/*.md
│       │   ├── daily/*.md
│       │   ├── magazine/*.md
│       │   └── features/*.md
│       ├── components/      ← React + Astro 混合组件
│       ├── layouts/
│       ├── pages/
│       └── styles/
│
├── n8n/
│   ├── generate.mjs         ← 从模板参数生成 8 个工作流 JSON
│   └── wf01~wf08-*.json     ← 8 个工作流文件（全部 Execute Command 调 pipeline）
│
└── scripts/
    ├── run-daily.mjs        ← 每日一键发布（串联 7 步，跨平台）
    └── backup-db.sh         ← 宿主机每周 pg_dump（Linux bash，Windows 上用 PowerShell 版）
```

---

## 四、数据库设计

`db/migrations/001_init.sql` 创建所有表。所有表都在 schema `cinescope` 下（`search_path TO cinescope, public`），避免和同库其他应用的表混在一起。

### 4.1 表清单

| 表 | 用途 | 主键 / 唯一约束 | 生命周期 |
|----|------|----------------|----------|
| `films` | 影片事实层（标题、年份、国家、时长、海报、TMDb 评分） | `tmdb_id` 唯一 | discover 写入，enrich 刷新 |
| `people` | 演职员人员字典（导演、演员、编剧） | `tmdb_id` 唯一 | enrich upsert |
| `credits` | films ↔ people 多对多 | `(film_id, person_id, role)` | enrich 全量删除再重写 |
| `ratings` | 外部评分快照（TMDb、IMDb 等，多源） | `(film_id, source)` | enrich 刷新 |
| `assessments` | **编辑部评分**（audience / artistic / recommendation / confidence / final） | （无 PK，`is_current=true` 标记当前版） | assess 每次插入新版 |
| `availability` | 各地区流媒体平台 availability | `(film_id, region, platform, offer_type)` | enrich 刷新 |
| `editorial_articles` | 所有 AI 生成文本（film_review / daily_intro / weekly_editorial / feature / brief） | `slug` 唯一 | write / daily / weekly 写入 |
| `daily_editions` | 每日刊的头部信息（issue_no, 日期, 导语, 总结） | `edition_date` 唯一 | daily 写入 |
| `selection_items` | 每日刊的影片槽位（position / note / is_lead） | `(edition_id, position)` | daily 写入 |
| `weekly_magazines` | 周刊头部（year+week / 主题 / 导语 / 封面） | `(year, week)` 唯一 | weekly 写入 |
| `weekly_items` | 周刊的影片槽位（pick / special_find 两种 section） | `(magazine_id, section, position)` | weekly 写入 |
| `features` | 专题文章（功能上已合并进 editorial_articles 的 kind='feature'） | — | — |
| `publish_logs` | 每次 publish 的目标 / 状态 / 错误 / commit_sha | — | publish 写入 |

### 4.2 设计原则

**事实与判断分离。** `films` 存可核实的电影资料（来自 TMDb、IMDb），`assessments` 存 CineScope 编辑部的三维打分和最终评分。永远不把编辑部评分写进 films 表，避免 "事实被覆盖"。

**快照式评分而非历史曲线。** `assessments` 每次评估都是 INSERT 一条新记录，旧记录 `is_current=false`。这样将来如果想回看某部电影在不同时间的编辑部评价，可以查历史。

**状态机是核心。** 每一条可对外展示的内容都有状态。publish 只认 `approved / published`。详见下文 §5。

---

## 五、内容状态机

```
  ┌─────────────┐     AI assess 通过      ┌──────────────┐
  │  candidate  │ ──────────────────────▶ │  selected    │
  │  (候选)     │   final_score ≥ 66      │  (选中)      │
  └─────────────┘   confidence ≥ 0.68    └──────┬───────┘
         │                                       │
         │ 分数不够或可信度低                       │
         ▼                                       │
  ┌─────────────┐                                │
  │  rejected   │                                │
  └─────────────┘                                │
                                                 ▼
  ┌─────────────┐   write / daily / weekly    ┌──────────────┐
  │   selected  │ ──────────────────────────▶ │   review     │
  └─────────────┘   生成文章默认 review        │  (待审)      │
                                               └──────┬───────┘
                                                      │
                                           proofread 通过 / 手动审核
                                                      ▼
                                               ┌──────────────┐
                                               │   approved   │
                                               └──────┬───────┘
                                                      │
                                           publish 命令导出并回写
                                                      ▼
                                               ┌──────────────┐
                                               │  published   │
                                               └──────────────┘

  影片归档：任何 published 影片在后台 maintain 里可以被标记 archived
           （不再在首页推荐，但详情页保留，publish 不导出）
```

状态判定的硬规则在 `pipeline/src/score.mjs`：

```js
// decideStatus 默认阈值：select=66, review=56
if (final >= 66 && confidence >= 0.68) return 'selected';
if (final >= 56)                       return 'candidate';
return 'rejected';
```

两个门槛同时生效——低分不可能入选，"资料不足但语气笃定"的高置信度也会被卡。

---

## 六、完整 Pipeline 详解

### 6.1 总览

```
discover → enrich → assess → write → daily → weekly → publish

手动模式：node scripts/run-daily.mjs  一行跑完上面 7 步
全自动：  n8n 8 个工作流按时间定时触发，每步独立执行
```

每一步都支持 `--dry-run`（不写数据库），这是排查问题的第一选择。

### 6.2 discover — 发现候选电影

**做什么**：从 TMDb `/discover/movie` 抓一批候选，经过两层筛选后写入 `films` 表，状态为 `candidate`。

**输入**：TMDb API  
**输出**：`films` INSERT / `ratings` INSERT（TMDb 评分快照）

**筛选逻辑**（代码常量，`pipeline/src/commands/discover.mjs` 顶部）：

| 条件 | 值 | 为什么 |
|------|----|--------|
| `vote_count.gte` | 400 | 样本量太小的片子评分不可信 |
| `vote_count.lte` | 10000 | 排除流量大片（MCU、沙丘），CineScope 不是热榜 |
| `vote_average.gte` | 7.6 | 质量门槛 |
| 上映日期 ≤ cutoff | 3 年前 | 新片评分样本小、热度波动大，要时间沉淀 |
| 排除 genres | 99, 10770 | 纪录片 + 脱口秀 |
| sort_by | `vote_average.desc` | 优先高评分 |
| region | `CN`（可配） | 目标地区 |

**流程细节**：
1. TMDb `/discover/movie?page=N` 拉 1~3 页，每页 20 条
2. 客户端再走一遍同样的筛选（因为 TMDb 的 vote_count 有 24h 延迟，cutoff 精确到今天）
3. `alreadyKnown(tmdb_id)` 查 DB，已存在 → 跳过
4. 新片调 `/movie/{id}?append_to_response=credits,external_ids,release_dates,translations,images` 补全详情
5. `mapMovie()` 把 TMDb 原始 JSON 归一化成 CineScope 的字段命名（`release_date` → `releaseDate`，`original_title` → `titleOriginal` 等），同时把国家/语言代码翻译成中文（用 `Intl.DisplayNames`）
6. `upsertFilm()`：INSERT + `ON CONFLICT (tmdb_id) DO UPDATE`，保证重复 discover 不会重复入库，只会刷新热度和评分

**API 限流**：`tmdb.mjs` 里 `MIN_INTERVAL_MS = 260`，每秒最多 3.8 次请求，TMDb 免费 tier 是 45 req/s，这里非常保守。遇到 429 读 `retry-after` 头，指数退避重试 3 次。

### 6.3 enrich — 资料补全

**做什么**：对已入库的影片，刷新演职员（director / writer / composer / cinematographer / producer / editor / cast 前 10）、流媒体平台 availability、TMDb 评分快照、runtime、海报、国家、语言。

**输入**：`films` 表里 `last_synced_at < 30 天前` 的 candidate / selected / published 影片  
**输出**：`films` UPDATE + `credits` 全量删除重写 + `ratings` UPSERT + `availability` UPSERT

**流程细节**：
1. SQL 查出需要刷新的影片（按 `last_synced_at NULLS FIRST` 排序，先补新入库的）
2. 每部影片：`getMovie()` 拉详情 → 整个包在 `withTransaction` 里
3. `syncCredits`：先 `DELETE FROM credits WHERE film_id=$1`，然后 upsert people + 插入 credits。crew 按 job 过滤到 8 种角色（见 `ROLE_BY_JOB` 映射表），cast 取前 10 个按 order 排序
4. `syncAvailability`：调 `getWatchProviders()`（`/movie/{id}/watch/providers`），分 stream / rent / buy 三种 offer_type，每种 UPSERT
5. 更新 films 表所有可刷新字段，设置 `last_synced_at = now()`

**为什么全量删除 credits 而不是 upsert**：因为一部电影的演职表 TMDb 上可能变动（新信息添加、错误修正），DELETE + 重插入最简单可靠。

### 6.4 assess — AI 质量评估

**做什么**：调 DeepSeek 对每部候选影片打三维分数 + 综合评分 + 可信度 + 选片状态。

**输入**：已完整 enrich 的 candidate / selected 影片（需要有 TMDb 评分和至少 250 字的中文简介）  
**输出**：`assessments` INSERT + `films.status` UPDATE

**三维评分模型**（`score.mjs`）：

| 维度 | 权重 | 含义 |
|------|------|------|
| **A**udience（观众维度） | 35% | 普通观众会不会喜欢？娱乐性？普适性？ |
| **A**rtistic（艺术维度） | 40% | 导演水平？镜头/声音/叙事是否有特点？技术完成度？ |
| **D**（Recommendation，推荐维度） | 25% | 媒体价值？讨论空间？话题性？ |

**综合评分公式**：

```
质量分 Q = 0.35·A + 0.40·R + 0.25·D   （缺失维度时权重重归一化，不按 0 算）
最终分 S = Q × C                       （C = confidence，0~1，"对这三个分数我有多确定"）
```

**为什么有 confidence 乘子**：assess 拿不到 IMDB 评分时，只能依赖 TMDb 评分（中文社区覆盖度不如英文），AI 会在置信度里体现这一点。最终用 S 卡门槛，避免 "分数很高但只有 200 条评论" 的片子混进来。

**AI prompt 输入**：电影基本信息（标题/年份/国家/语言/时长/类型）、已同步的外部评分（TMDb + IMDb 如果有）、sources 链接（TMDb + IMDb 页面 URL）、TMDb overview 中文简介。输出是严格 JSON：`{audience, artistic, recommendation, confidence, dimensions, rationale, evidence[], caveats[], angle}`。

**每次 assess 都插入新记录**，不是更新：

```sql
UPDATE assessments SET is_current = false WHERE film_id = $1 AND is_current;
INSERT INTO assessments (...) VALUES (..., is_current=true);
```

### 6.5 write — AI 写影评 + 校对

**做什么**：对 `final_score >= 66` 的影片，让 AI 写 500+ 字的中文影评 + 标题 + 副标题 + pull_quote，然后过一次 proofread 校对。

**输入**：已 assess 入选影片  
**输出**：`editorial_articles` INSERT（kind='film_review'，status 初始 review）

**两段式设计**：

```
第 1 段：chatJSON(WRITE_SYSTEM + writePrompt) → {title, subtitle, pull_quote, body}
  temperature: 0.65, maxTokens: 6000

校验：countWords(body) >= 500，title 非空。
  不合格 → 直接 throw，不做后续步骤

第 2 段：chatJSON(PROOFREAD_SYSTEM + proofreadPrompt) → {issues[], verdict}
  只看 severity === 'high' 判断是否可发布；medium/low 作为修改建议保留

通过 → status = 'approved'
不通过 → 第 3 段

第 3 段（如果校对没过）：chatJSON 重写，prompt 包含上一轮的问题清单
  温度降低到 0.5
  重写后再过一次 proofread
  最终无论过不过，都写进 editorial_articles，proofread 没通过的 status = 'review'
```

**proofread 检查什么**：事实准确性（与 films 表的类型/国家/年份/时长/导演是否匹配）、来源是否都有可点击 URL、中文表达自然、无幻觉（写出 sources 里不存在的演员/奖项/剧情细节）。

**sources 来源**：不是 AI 编的。从 films 表的 tmdb_id / imdb_id 拼 TMDb 和 IMDb 页面 URL，写入 editorial_articles.sources JSON 字段。publish 导出时如果发现 sources 里没有合法 http(s) URL，会用 TMDb 页面兜底。

### 6.6 daily — AI 组今日推荐

**做什么**：每天生成一次。从候选池里挑 2~3 部，AI 写导语 + 每部一句话 note + 总结。

**输入**：`films` 表中 `final_score >= 66` 且最近 21 天没在每日刊里出现过的影片（SQL_DAILY_POOL）  
**输出**：`daily_editions` INSERT + `selection_items` INSERT × N + `editorial_articles` INSERT (kind='daily_intro')

**防重复机制**：
- 每部影片在 daily_editions 表通过 selection_items 关联，SQL 查询 `ignoreRecentDays=21` 确保同一部片子 21 天内不会重复推荐
- 如果当天的 edition 已经存在，命令直接报错退出（`daily_editions.edition_date` 有唯一约束）

**最少 2 部**：如果 AI 选中不足 2 部，代码会从候选池里按 final_score 降序补到 2 部；最多 3 部。

**issue_no 自动递增**：`SELECT coalesce(max(issue_no), 0) + 1 FROM daily_editions` 保证每日刊有连贯的期号。

**daily 的 body_markdown 是空字符串**：代码里明确写了 `const body = ''`，因为 daily 的导语（editor_intro）和总结（closing）已经分别单独存了，再在 body 里拼一遍会在站点渲染时三处重复。004 迁移加了 `CHECK (kind IN ('daily_intro', 'weekly_editorial') OR length(btrim(body_markdown)) > 0)` 这个约束，正好把这条规则固化到数据库里。

### 6.7 weekly — AI 组本周杂志

**做什么**：每周一次。AI 组一个主题（theme），推荐 5 部 pick + 2 部 special_finds（被主流忽略但值得单独提出的）。

**输入**：`films` 表中 `status IN ('selected','published')` 且 `final_score >= 66` 排序前 20 部  
**输出**：`weekly_magazines` INSERT + `weekly_items` INSERT × N + `editorial_articles` INSERT (kind='weekly_editorial')

**防重复机制**：
- `weekly_magazines (year, week)` 唯一约束，同一周不会生成两刊
- SQL 里 `SELECT ... WHERE f.status IN ('selected','published')` 但 weekly_items 表有 `UNIQUE (magazine_id, film_id)`，代码层 `dedupe` 函数再次确保同部片子不会在同一周刊里出现两次（pick 和 special_find 也不会交叉）

**封面配色（cover_palette）**：9 种配色池（dusk / ember / moss / sand / ash / ink / rust / sea / paper），AI 在 JSON 输出里选一个。如果 AI 选了不在池子里的值，代码回退到 `ash`。

### 6.8 publish — DB → Markdown → Git → Cloudflare

**做什么**：这是整条管线的**唯一出口**。所有前面命令的产物都写进了 PostgreSQL，publish 命令把它们导成 Astro 需要的 Markdown frontmatter 格式，写到 site/src/content/ 下，然后可选地 git commit / git push / 触发 Cloudflare build。

**四个导出函数**：

```
exportFilms()   → site/src/content/films/{slug}.md     (film_review 且 approved/published)
exportDaily()   → site/src/content/daily/{YYYY-MM-DD}.md
exportWeekly()  → site/src/content/magazine/{year}-week-{week}.md
exportFeatures()→ site/src/content/features/{slug}.md
```

**写入是幂等的**。`writeIfChanged()` 每次先读旧文件，内容相同则返回 `unchanged` 不写磁盘。这意味着 pipeline 重跑不会产生无意义的 `updated_at` 变动或 git 空提交。

**frontmatter 结构**（以 film 为例）：

```yaml
---
title: 美国往事
originalTitle: Once Upon a Time in America
year: 1984
countries: ["意大利", "美国"]
language: 英语
runtime: 229
directors: ["塞尔乔·莱昂内"]
cast: ["罗伯特·德尼罗", "詹姆斯·伍兹", ...]
genres: ["犯罪", "剧情"]
palette: ink
poster: https://image.tmdb.org/t/p/w500/...
tmdbId: 111
imdbId: tt0087843
ratings: { imdb: 8.3, votes: 520000, source: "IMDb 官方数据集" }
scores:
  audience: 92
  artistic: 94
  recommendation: 88
  confidence: 0.91
  final: 85
selection:
  issue: 2026-11-25
  angle: "莱昂内的时间哲学"
dataStatus: verified
sources:
  - { label: "TMDb 影片资料", url: "https://www.themoviedb.org/movie/111", retrieved: "2026-11-25" }
---

（body_markdown 正文）
```

**sources URL 校验**。`normalizeSources()` 会过滤掉没有合法 http(s) URL 的条目。如果所有来源都无效，用 TMDb 基础 URL 兜底。这样 Astro 前端的 Zod schema 永远不会拿到空 URL。

**Git 操作**（只有传了 `--commit` / `--push` 才执行）：

```bash
git add site/src/content/**                 # 只 stage 内容目录
git diff --cached --quiet                  # 有改动才 commit
git commit -m "content: publish YYYY-MM-DD"
git push origin HEAD:main                  # GIT_TERMINAL_PROMPT=0，无密码推送
```

**build 和 deploy 是可选的**。Cloudflare Pages 已经连接了 GitHub 仓库（push 触发构建），所以正常情况下不需要 `--build` / `--deploy`。只有在你想手动触发时才用 `--deploy`（调 `CLOUDFLARE_DEPLOY_HOOK`）。

**publish_logs 全程记录**。每一步（content → git → site → cloudflare）都写一条 publish_log，失败也会写 status='failed' 并把错误信息存进 error 字段。这是排查 Cloudflare Pages 构建失败时的第一入口。

---

## 七、评分公式的推导

为什么用 `Q = 0.35A + 0.40R + 0.25D`？这来自 CineScope 定位：

- **艺术 40% 最高**：编辑部想推的是"值得讨论"的电影，不一定最卖座但要有个人表达。
- **观众 35% 第二**：但也不能完全脱离观众基础。如果一部片子艺术分很高但观众分只有 50，说明它可能太刁钻不适合每日推荐。
- **推荐 25% 最末**：话题性是加分项，但不应成为主驱动（避免为了热度牺牲品位）。
- **Confidence 乘子**：三个维度的置信度各自有值，但最终只存一个 confidence，取三个维度置信度的平均。如果 AI 觉得"我对这三个分数都只有 60% 把握"，最终分会被打到 60%。

这也是为什么最终分 S 不是简单的 Q：
- 一部 Q=90 但 confidence=0.4 的片子，S=36，会被 reject 掉
- 一部 Q=78 但 confidence=0.9 的片子，S=70，会被 selected

---

## 八、AI 调用模式

所有 AI 调用都走 `pipeline/src/ai.mjs` 的 `chatJSON()`。

```
1. 发送：system + user + temperature + max_tokens + response_format=json_object
2. 拿到 response.choices[0].message.content
3. extractJson()：先找 ```json...``` fenced block，没有就从第一个 { 到最后一个 } 切
4. JSON.parse()
5. parse 失败 → 再调一次 repair prompt（"你是 JSON 修复器。只输出合法 JSON"）
6. repair 也失败 → throw
```

DeepSeek 的 JSON mode 并不保证返回严格 JSON，有时会返回 `{...}` 外面带注释或多余文本。`extractJson` 做了双重保险。

**Retry**：网络错误、429、5xx 都会指数退避重试 3 次。Timeout 180s（AI 写 6000 token 影评需要时间）。

**失败不中断整条链路**：`run-daily.mjs` 里每一步都是独立的 try/catch，某个 AI 调用失败只记录那条的错误，后面步骤继续跑。最终汇总哪些成功了哪些失败了。

---

## 九、运行模式

### 9.1 手动一键（推荐）

```bash
node scripts/run-daily.mjs
```

内部顺序执行 7 步，每步独立 try/catch，失败不中断。

常用变体：
```bash
node scripts/run-daily.mjs --dry-run                  # 预演，不写 DB 也不 push
node scripts/run-daily.mjs --only daily,weekly,publish # 只跑发布阶段（跳过 discover/评估/撰稿）
node scripts/run-daily.mjs --skip-discover --skip-enrich
node scripts/run-daily.mjs --no-push                  # commit 不 push，改完人工推
```

### 9.2 全自动（n8n）

`n8n/` 下 8 个工作流，全是 Execute Command 节点，按时间调度：

| 工作流 | 触发 | 命令 |
|--------|------|------|
| WF01 全球电影发现 | 每天 02:00 | `discover --limit=30 --pages=3` |
| WF02 电影资料补全 | 每天 02:30 | `enrich --limit=20` |
| WF03 AI 质量评估 | 每天 03:00 | `assess --limit=20` |
| WF04 AI 编辑撰稿 | 每天 04:00 | `write --limit=6` |
| WF05 每日刊物 | 每天 06:30 | `daily --publish` |
| WF06 每周杂志 | 周日 20:00 | `weekly --publish` |
| WF07 静态站点发布 | 每天 07:00 | `publish --commit` |
| WF08 数据库维护 | 周日 03:30 | `maintain --log-days=180` |

每个 Execute Command 节点的路径通过 `node n8n/generate.mjs --pipeline-path=/your/path --activate` 生成，避免硬编码 Linux 路径。

n8n 内部不执行 `git push`——由宿主机 cron 每 10 分钟补推一次：
```cron
*/10 * * * * cd /path/to/cinescope && git push origin main
```

### 9.3 Cloudflare Pages

**部署方式**：GitHub repo 在 Cloudflare Dashboard 里手动连接（仓库 → Pages → Create application → Connect to Git）。

**构建配置**：
| 项 | 值 |
|----|----|
| Root directory | `site` |
| Build command | `npm run build` |
| Build output | `dist` |
| Environment variable | `SITE_URL=https://cinescope.pages.dev` |

**触发条件**：main 分支任何 push → 自动 build。构建失败时线上保持上一个正常版本，不会把站点打挂。

---

## 十、环境变量

定义在 `pipeline/src/env.mjs`，示例在根目录 `.env.example`：

| 变量 | 必填 | 默认值 | 用途 |
|------|------|--------|------|
| `DATABASE_URL` | ✅ | — | PostgreSQL 连接串，`search_path=cinescope,public` 会自动加上 |
| `TMDB_API_KEY` | 二选一 | — | TMDb v3 API key |
| `TMDB_API_TOKEN` | 二选一 | — | TMDb v4 Bearer token（优先用这个） |
| `DEEPSEEK_API_KEY` | ✅ | — | DeepSeek API key |
| `TMDB_REGION` | ❌ | `CN` | TMDb watch providers 查询地区 |
| `TMDB_LANGUAGE` | ❌ | `zh-CN` | TMDb 返回语言 |
| `DEEPSEEK_BASE_URL` | ❌ | `https://api.deepseek.com` | 可指向自建或代理 |
| `DEEPSEEK_MODEL` | ❌ | `deepseek-chat` | 可切 deepseek-reasoner 或其他 |
| `CLOUDFLARE_DEPLOY_HOOK` | ❌ | — | 只有想手动触发 Cloudflare 构建时需要 |
| `SITE_URL` | ❌ | `https://cinescope.pages.dev` | 传给 Astro build，生成 sitemap |
| `PIPELINE_TIMEZONE` | ❌ | `Asia/Shanghai` | 影响 daily 的 edition_date 和 weekly 的 ISO week |

---

## 十一、常见排查路径

### 11.1 "publish 说有内容但 Cloudflare Pages 没构建"

1. 查 `publish_logs` 表（`SELECT * FROM publish_logs ORDER BY finished_at DESC LIMIT 10`）看最后一次是 content / git / cloudflare 哪步 status=failed
2. 如果 git step failed：本地手动 `git status` 看是否 repo 未初始化、SSH key 没配、或 commit 失败
3. 如果 Cloudflare Pages 没自动触发：去 Cloudflare Dashboard → Pages → Deployments，看是否被过滤了（Cloudflare 可以设置只在特定目录有改动时才构建）

### 11.2 "discover 发现 0 部候选"

- 放宽 `vote_average.gte` / `MIN_VOTE_COUNT` / `MIN_AGE_YEARS`（在 `discover.mjs` 顶部）
- 检查 TMDb API key 是否还有配额
- 用 `node src/cli.mjs discover --dry-run --pages=5 --limit=50` 预演

### 11.3 "assess/reassess 结果不合理"

- 改 `score.mjs` 的权重或阈值（`decideStatus` 的 `select / review` 门槛）
- 改 `prompts.mjs` 里的 `ASSESS_SYSTEM` / `assessPrompt`，给 AI 更明确的维度解释
- 注意：`RUBRIC_VERSION` 常量要跟着改，publish_logs 和 assessments 表里都会记录它

### 11.4 "write 的影评通不过 proofread"

- proofread 里 high 级问题的类型通常是：导演名字拼错、时长写错、类型写错、sources URL 空
- 检查 films 表里那部片子的原始数据是否正确（enrich 有没有跑过、有没有被 TMDb 后来修正了）
- 调 proofreadPrompt 的 strictness，降低对某些类型幻觉的敏感度

### 11.5 "daily / weekly 没生成"

- SQL 候选池为空：`SELECT COUNT(*) FROM films WHERE status='selected' AND (SELECT final_score FROM assessments WHERE film_id=films.id AND is_current) >= 66`
- `daily_editions.edition_date` 或 `weekly_magazines(year, week)` 已存在 → 报错退出（不会覆盖）
- ISO week 可能和你预期的不一样：`node -e "import('./env.mjs').then(m=>console.log(m.isoWeek('2026-11-25')))"`

### 11.6 "站点 build 报错"

- 几乎一定是 Markdown frontmatter 不合法（`sources` 数组里有空 URL、`year` 不是数字、`directors` 不是数组等）
- `site/src/content.config.ts` 里定义了 Zod schema，schema 报错信息就是修复指南
- 在 pipeline 的 `normalizeSources` 里加了 `isHttpUrl` 过滤来兜底，确保不会写出坏 URL

---

## 十二、跨平台移植（Windows / macOS）

**能跑的**：
- 整个 pipeline（纯 Node.js + pg 纯 JS + dotenv + js-yaml + gray-matter，无原生模块）
- `scripts/run-daily.mjs`（ESM 跨平台 import）
- Cloudflare Pages 部署链（只管 Git，完全不关心宿主机 OS）

**需要替换的**：
| Linux / bash | Windows | macOS |
|--------------|---------|-------|
| `scripts/backup-db.sh` | 用 PowerShell 版重写（见 README 附录） | bash 可用，也可以保留 |
| 宿主机 cron `*/10 * * * * git push` | 任务计划程序 / n8n 内置调度 | launchd / n8n 内置调度 |
| n8n 工作流 Execute Command 里的 Linux 绝对路径 | `node n8n/generate.mjs --pipeline-path="C:/cinescope/pipeline" --activate` 重新生成 | 同 Linux，用 `node generate.mjs` 重新生成 |
| pg_dump（宿主机 PostgreSQL 安装版） | pg_dump 在 Windows PG 安装目录的 `bin/` 下 | 同 Linux |

**不需要替换的**：所有路径拼接都用 `path.join()` / `path.resolve()`；时区用 `Intl.DateTimeFormat`（不依赖 POSIX `date` 命令）；SQL 纯 PostgreSQL 语法（枚举类型、search_path、JSONB）；API 调用是纯 Node fetch + AbortSignal。

---

## 十三、安全与成本

**密钥管理**：`.env` 加入 `.gitignore`，不随仓库分发。`.env.example` 只有占位符。打包交付物用 `git archive` 直接从 HEAD 导出，天然排除 `.env`。

**DeepSeek 省钱**：prompt 里建议工作流放在晚 22:00 ~ 早 09:00 之间跑——DeepSeek 非高峰时段单价约为高峰一半。手动模式什么时候跑都行，n8n 定时工作流都设在凌晨 02:00~04:00 就是这个原因。

**API 限流**：TMDb 3.8 req/s（免费 tier 45 req/s），DeepSeek 默认无显式限流但有指数退避。单机 pipeline 跑完整链路一次约消耗 TMDb 50~60 次请求、DeepSeek 10~20 次请求。

**静态站零成本**：Cloudflare Pages 免费 tier 完全够用，38 页小站连构建时间都不到 3 秒。

---

## 十四、扩展点

| 想做什么 | 改哪里 |
|----------|--------|
| 接入 IMDb / Letterboxd / 烂番茄评分 | 在 `enrich.mjs` 里加一个类似 `importImdbRating()` 的函数，写进 `ratings` 表，publish 的 film frontmatter 会自动读 ratings |
| 接入 AI 图片生成每日封面 | `daily.mjs` 写完后调一个 AI image API，把产物写到 `site/public/daily-covers/` 下，在 film frontmatter 的 `poster` 字段里换成新图 |
| 加新的内容类型（影评之外） | 在 `editorial_articles` 的 `article_kind` 枚举里加新值，写一个对应的 export 函数，在 site/src/pages 下加新页面 |
| 换 AI 模型 | 改 `.env` 的 `DEEPSEEK_BASE_URL` 和 `DEEPSEEK_MODEL`。`ai.mjs` 是通用 chat 封装，任何 OpenAI 兼容 endpoint 都能用 |
| 多语言 | TMDb 的 `with_original_language` 已经支持多语言 discover；pipeline 里所有中文硬编码都集中在 `prompts.mjs` 的 system prompt 里，改 prompt 语言就能改输出语言 |

---

## 附录：SQL_CANDIDATES_WITH_ASSESSMENT 查询（write 的入口）

这条 SQL 是整个 pipeline 中最关键的一条——它决定了 AI 写影评时"喂给它什么材料"。join 了 films + assessments + ratings + editorial_articles（排除已写过的），带一个评分阈值和排序：

```sql
SELECT f.*, a.*, r.score AS imdb_score, r.vote_count AS imdb_votes,
       (SELECT json_agg(...) FROM credits+people WHERE actor ORDER BY billing_order) AS cast,
       (SELECT json_agg(...) FROM credits+people WHERE director ORDER BY billing_order) AS directors
FROM films f
JOIN assessments a ON a.film_id = f.id AND a.is_current
LEFT JOIN ratings r ON r.film_id = f.id AND r.source = 'imdb'
WHERE a.final_score >= $1
ORDER BY a.final_score DESC
LIMIT $2
```

`$1` = `minScore`（默认 66），`$2` = `limit * 3`（因为后面还要过滤掉已经有 approved/published film_review 的片子）。
