# CineScope

> Discover Cinema Beyond the Mainstream.  
> 在主流之外，重新发现电影。

CineScope 是一本由 AI 编辑部持续出版的全球电影杂志。它不做电影数据库、不做搜索、不做社区：只负责发现、判断、撰写与出版。

- **每日**：06:30 生成当日推荐（DeepSeek 空闲时段），09:30 推送上线；默认 3 部，质量不足时自动少选。
- **每周**：周日 20:00 生成一期独立策划的周刊（周末全天为空闲时段），次日 09:30 随发布任务上线；主题、片单与特别发现都重新组织。
- **专题**：按国家、导演、流派、电影史等方向不定期出版深度文章。

站点为纯静态 Astro 网站，构建产物可部署到 Cloudflare Pages；生产端（PostgreSQL + DeepSeek + n8n）只负责内容生产。

---

## 目录结构

```
cinescope/
├── site/                 Astro 静态杂志站（含样例内容，可独立构建）
│   ├── src/content/      films / daily / magazine / features 四个内容集合
│   ├── src/components/   视觉组件（Artwork、HeroSection、FilmFacts…）
│   ├── src/layouts/      BaseLayout / ArticleLayout
│   └── src/pages/        首页、每日、周刊、专题、电影、归档、About、RSS
├── db/migrations/        PostgreSQL 迁移（001 表结构 / 002 视图与触发器 / 003 发布日志目标）
├── pipeline/             AI 编辑管线（Node.js，无额外框架）
│   └── src/commands/     discover / enrich / assess / write / daily / weekly / publish / seed / maintenance
├── n8n/                  8 个可导入的自动化工作流 JSON
└── .env.example          环境变量模板
```

## 内容与事实的边界

- `films` 只存可核实的事实；`assessments` 存编辑部判断；`ratings` 存外部平台原始评分。三者不混用。
- 每篇文章区分：已核实事实 / 外部评论观点 / AI 编辑判断。
- 文章必须带 `sources`；**无来源的文章不得发布**（`maintain` 会自动把这类文章退回 `review`）。
- 评分公式：`Q = 0.35R + 0.40A + 0.25D`，`S = Q × C`；缺失维度按剩余权重归一化，不填 0。
- 内容状态机：`draft → review → approved → published`，发布记录写入 `publish_logs`。

---

## 一、只预览网站（无需数据库与密钥）

```bash
cd site
npm install
npm run dev        # http://localhost:4321
npm run build      # 静态产物在 site/dist
```

仓库自带 19 部影片（其中 1 篇《切腹》由管线在本地完整跑通时生成）、4 期每日、2 期周刊、3 篇专题的中文内容，`dataStatus: sample` 会在页面上明确提示「样例数据」。不接数据库也能完整浏览。

## 二、启用完整管线

### 1. 准备环境

```bash
cp .env.example .env    # 填写 DATABASE_URL / TMDB_API_TOKEN / DEEPSEEK_API_KEY
createdb cinescope
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_init.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_views.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/003_publish_log_targets.sql
cd pipeline && npm install
```

### 2. 先把样例内容导入数据库（可选，但推荐）

```bash
node src/cli.mjs seed --dry-run   # 看会导入多少
node src/cli.mjs seed             # 影片 / 评分 / 评估 / 文章 / 刊物全部入库
```

这条命令让「数据库 → 站点」的链路立刻可跑；之后外部 API 抓取的新内容会与样例共存。

### 3. 日常命令

```bash
node src/cli.mjs discover --limit=30 --pages=3
node src/cli.mjs enrich --limit=20
node src/cli.mjs assess --limit=20
node src/cli.mjs write --limit=6
node src/cli.mjs daily --publish          # 生成今天的每日刊物
node src/cli.mjs weekly --publish         # 生成本周周刊
node src/cli.mjs publish --commit --push   # 导出 + 提交 + 推送（本机执行）
node src/cli.mjs maintain --dry-run       # 一致性检查
```

完整参数见 `node src/cli.mjs --help`。

### 4. 发布链路

```
PostgreSQL → pipeline publish → site/src/content/**.md
           → git commit → git push（宿主机定时任务）
           → Cloudflare Pages 自动构建 → 上线
```

`publish` 只导出 `approved / published` 的内容，导出后把状态回写为 `published` 并记录 `publish_logs`。可用开关：

| 参数 | 作用 |
| --- | --- |
| `--commit` | `git add` 内容文件并提交 |
| `--push` | 提交后推送到 `origin` 当前分支 |
| `--build` | 本地执行 `npm run build`（需要 glibc 环境的 Node，容器内不适用） |
| `--deploy` | 调用 `CLOUDFLARE_DEPLOY_HOOK`（仓库已连 Pages 自动构建时可不加） |

推送触发 Cloudflare 构建；构建失败时线上保持最后一个正常版本。

`--commit` 需要项目本身是一个 Git 仓库并已配置远端：

```bash
git init && git add . && git commit -m "init cinescope"
git remote add origin git@github.com:<you>/cinescope.git
```

否则请省略 `--commit` 或 `--deploy`，只导出 Markdown。

## 三、n8n 自动化

`n8n/` 下有 8 个工作流，覆盖规格中的 WF01–WF08：

| 文件 | 触发 | 动作 |
| --- | --- | --- |
| `wf01-全球电影发现.json` | 每天 02:00 | `discover` |
| `wf02-电影资料补全.json` | 每天 02:30 | `enrich` |
| `wf03-AI-质量评估.json` | 每天 03:00 | `assess` |
| `wf04-AI-编辑撰稿.json` | 每天 04:00 | `write` |
| `wf05-每日刊物.json` | 每天 06:30 | `daily --publish`（生成并标记发布） |
| `wf06-每周杂志.json` | 周日 20:00 | `weekly --publish`（生成并标记发布） |
| `wf07-静态站点发布.json` | 每天 09:30 或手动 | `publish --commit`（提交）；宿主机负责推送 |
| `wf08-数据库维护.json` | 周日 03:30 | `maintain`（备份由宿主机 cron 执行） |

### AI 任务的运行时段

DeepSeek 的高峰时段为北京时间工作日 09:00–12:00、14:00–18:00（法定节假日除外），其余时间为空闲时段，单价约为高峰的一半。因此所有调用模型的环节都排在空闲时段：评估 03:00、撰稿 04:00、每日 06:30、周刊周日 20:00。静态站点发布（WF07）固定在 09:30，只做导出与 Git 提交，不调用模型，推送时间保持不变。

### WF07 自动提交

WF07 只做「导出 Markdown + git commit」，推送由宿主机定时任务完成，原因是 n8n 容器内不放置 SSH 私钥，也不执行 `npm run build`（容器为 Alpine/musl，而 `node_modules` 的原生模块按 glibc 安装）。

需要满足的条件：

1. 项目目录已挂载到容器 `/opt/cinescope`，且 `.git` 对容器用户（uid 1000）可写；
2. 仓库内已设置提交身份（与宿主机共用 `.git/config`）：
   ```bash
   git config user.name "CineScope Bot"
   git config user.email "bot@cinescope.local"
   ```
3. 宿主机定时推送（每 10 分钟）：
   ```
   */10 * * * * cd /opt/cinescope && git push origin main >> /tmp/cinescope-push.log 2>&1
   ```
4. 推送后由 Cloudflare Pages 自动构建；如需手动触发，另配 `CLOUDFLARE_DEPLOY_HOOK` 并在宿主机执行 `publish --deploy`。

若希望容器直接推送，需为 n8n 单独生成一把仅限该仓库的 deploy key 并以**单文件**方式挂载，或改用 GitHub fine-grained token + HTTPS remote；不要把整个 `~/.ssh` 挂进容器。

### 数据库备份

n8n 容器是 Alpine 镜像，没有 `pg_dump`，所以备份放在宿主机执行：

```bash
scripts/backup-db.sh          # 手动备份一次

# cron：每周日 03:40 自动执行
40 3 * * 0 /path/to/cinescope/scripts/backup-db.sh >> /tmp/cinescope-backup.log 2>&1
```

产物写入仓库 `backups/`（已在 `.gitignore` 中忽略），命名 `cinescope-YYYY-MM-DD.sql.gz`，保留 8 周（56 天）。WF08 只负责 `maintain` 一致性检查。

导入方式：n8n → Workflows → Import from File（或容器内 `n8n import:workflow --input=...`）。工作流 JSON 默认 `active: false`，确认路径与凭证后逐条启用；本服务器已启用全部 8 条。

默认命令路径为 `/opt/cinescope/pipeline`，若部署目录不同，导入后统一修改 Execute Command 节点。工作流通过服务器的 `.env` 读取密钥，不在 n8n 中保存明文。

## 四、部署到 Cloudflare Pages

1. 将仓库推到 GitHub。
2. Cloudflare Pages 连接仓库：构建命令 `npm run build`，输出目录 `site/dist`，根目录设为 `site`。
3. 在 Pages 环境变量中设置 `SITE_URL`（正式域名）。
4. 在服务器 `.env` 中填入 Pages 的 Deploy Hook，`publish --deploy` 即可触发构建。

站内已包含 `sitemap-index.xml`、`robots.txt`、`rss.xml`、OG/Twitter 卡片与 JSON-LD。

## 五、图片与来源

- 剧照与海报优先使用 TMDb 官方图片 CDN 路径，不批量下载、不重新分发。
- 图片缺失时组件自动回退到配色渐变 + 片名排版，文章阅读不受影响。
- TMDb 数据只作为基础事实与素材，不直接等同于编辑部结论。
- IMDb 评分通过官方非商业数据集补充，不假设存在免费无限查询 API。
