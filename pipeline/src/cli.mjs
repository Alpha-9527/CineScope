#!/usr/bin/env node
import { env, hasDatabase } from './env.mjs';
import { closePool } from './db.mjs';
import { runDiscover } from './commands/discover.mjs';
import { runEnrich, importImdbRating } from './commands/enrich.mjs';
import { runAssess } from './commands/assess.mjs';
import { runProofread, runWrite } from './commands/write.mjs';
import { runDaily } from './commands/daily.mjs';
import { runWeekly } from './commands/weekly.mjs';
import { runPublish } from './commands/publish.mjs';
import { runSeed } from './commands/seed.mjs';
import { runMaintenance } from './commands/maintenance.mjs';

const HELP = `CineScope AI 编辑管线

用法：node src/cli.mjs <命令> [选项]

命令
  discover    从 TMDb 发现候选影片并入库
  enrich      抓取演职员、评分与观看渠道
  assess      AI 评估：R/A/D 三维打分 + 置信度，计算 S = Q × C
  write       生成影评并自动校对，写入 editorial_articles
  proofread   重新校对处于 draft/review 的文章
  daily       生成某日的每日推荐（2–3 部影片 + 导语）
  weekly      生成某周的周刊（主题 + 片单 + 特别发现）
  publish     把已批准内容导出为站点 Markdown，可提交 / 构建 / 部署
  seed        把站点现有 Markdown 反向导入数据库
  maintain    一致性检查与历史数据清理
  imdb        手动录入某部影片的 IMDb 评分

通用选项
  --dry-run            只打印计划，不写数据库 / 文件
  --help               显示此帮助

各命令选项
  discover   --limit=20 --pages=2 --region=CN --language=zh --year-from=1990 --year-to=2026
  enrich     --limit=10 --force
  assess     --limit=10 --slug=<film-slug>
  write      --limit=3 --slug=<film-slug> --min-score=66
  proofread  --limit=5
  daily      --date=YYYY-MM-DD --min-score=66 --ignore-recent-days=21 --publish
  weekly     --year=2026 --week=47 --date=YYYY-MM-DD --publish
  publish    --commit --build --deploy
  seed       --dry-run
  maintain   --log-days=180 --availability-days=180
  imdb       --slug=<film-slug> --score=8.1 --votes=120000 --url=<IMDb 链接>

环境变量（写入仓库根目录 .env）
  DATABASE_URL            PostgreSQL 连接串（必填，publish/seed 之外都需要）
  TMDB_API_TOKEN          TMDb v4 Read Access Token（推荐）
  TMDB_API_KEY            TMDb v3 API Key（未配置 Token 时使用）
  DEEPSEEK_API_KEY        DeepSeek API Key
  DEEPSEEK_BASE_URL       默认 https://api.deepseek.com
  DEEPSEEK_MODEL          默认 deepseek-chat
  CLOUDFLARE_DEPLOY_HOOK  publish --deploy 时调用的 Deploy Hook
  SITE_URL                站点正式域名，用于构建与 RSS
  TMDB_REGION             观看渠道地区，默认 CN
  PIPELINE_TIMEZONE       日期计算时区，默认 Asia/Shanghai

示例
  npm run discover -- --limit=30
  npm run assess -- --limit=20
  npm run write -- --limit=5
  npm run daily -- --publish
  npm run weekly -- --publish
  npm run publish -- --commit --build --deploy
`;

const COMMANDS = {
  discover: {
    allowed: ['limit', 'pages', 'region', 'language', 'yearFrom', 'yearTo'],
    run: (o) =>
      runDiscover({
        limit: o.limit ?? 20,
        pages: o.pages ?? 2,
        region: o.region ?? env.tmdbRegion,
        language: o.language,
        yearFrom: o.yearFrom,
        yearTo: o.yearTo,
        dryRun: Boolean(o.dryRun),
      }),
  },
  enrich: {
    allowed: ['limit', 'force'],
    run: (o) => runEnrich({ limit: o.limit ?? 10, force: Boolean(o.force), dryRun: Boolean(o.dryRun) }),
  },
  assess: {
    allowed: ['limit', 'slug'],
    run: (o) => runAssess({ limit: o.limit ?? 10, slug: o.slug, dryRun: Boolean(o.dryRun) }),
  },
  write: {
    allowed: ['limit', 'slug', 'minScore'],
    run: (o) =>
      runWrite({
        limit: o.limit ?? 3,
        slug: o.slug,
        minScore: o.minScore ?? 66,
        dryRun: Boolean(o.dryRun),
      }),
  },
  proofread: {
    allowed: ['limit'],
    run: (o) => runProofread({ limit: o.limit ?? 5, dryRun: Boolean(o.dryRun) }),
  },
  daily: {
    allowed: ['date', 'minScore', 'ignoreRecentDays', 'publish'],
    run: (o) =>
      runDaily({
        date: o.date,
        minScore: o.minScore ?? 66,
        ignoreRecentDays: o.ignoreRecentDays ?? 21,
        publish: Boolean(o.publish),
        dryRun: Boolean(o.dryRun),
      }),
  },
  weekly: {
    allowed: ['year', 'week', 'date', 'publish'],
    run: (o) =>
      runWeekly({
        year: o.year,
        week: o.week,
        date: o.date,
        publish: Boolean(o.publish),
        dryRun: Boolean(o.dryRun),
      }),
  },
  publish: {
    allowed: ['commit', 'build', 'deploy'],
    run: (o) =>
      runPublish({
        dryRun: Boolean(o.dryRun),
        commit: Boolean(o.commit),
        build: Boolean(o.build),
        deploy: Boolean(o.deploy),
      }),
  },
  seed: {
    allowed: [],
    run: (o) => runSeed({ dryRun: Boolean(o.dryRun) }),
  },
  maintain: {
    allowed: ['logDays', 'availabilityDays'],
    run: (o) =>
      runMaintenance({
        dryRun: Boolean(o.dryRun),
        logDays: o.logDays ?? 180,
        availabilityDays: o.availabilityDays ?? 180,
      }),
  },
  imdb: {
    allowed: ['slug', 'score', 'votes', 'url'],
    run: async (o) => {
      if (!o.slug || o.score === undefined) {
        throw new Error('imdb 需要 --slug 与 --score');
      }
      await importImdbRating({ slug: o.slug, score: o.score, votes: o.votes, url: o.url });
      return { action: 'imported', slug: o.slug, score: o.score };
    },
  },
};

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const rawKey = eq === -1 ? body : body.slice(0, eq);
    const rawValue = eq === -1 ? undefined : body.slice(eq + 1);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (rawValue === undefined) {
      options[key] = true;
    } else if (rawValue === 'true' || rawValue === 'false') {
      options[key] = rawValue === 'true';
    } else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      options[key] = Number(rawValue);
    } else {
      options[key] = rawValue;
    }
  }
  return { options, positional };
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));

  if (options.help || positional.length === 0) {
    console.log(HELP);
    return;
  }

  const name = positional[0];
  const command = COMMANDS[name];
  if (!command) {
    console.error(`未知命令：${name}\n`);
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const unknown = Object.keys(options).filter(
    (key) => key !== 'dryRun' && key !== 'help' && !command.allowed.includes(key),
  );
  if (unknown.length > 0) {
    console.warn(`忽略未知选项：${unknown.map((key) => `--${key}`).join(', ')}`);
  }

  if (!hasDatabase()) {
    throw new Error('缺少 DATABASE_URL，请先参考 .env.example 配置数据库连接。');
  }

  const result = await command.run(options);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(`\n[${new Date().toISOString()}] 执行失败：${error.message}`);
    if (process.env.DEBUG) console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
