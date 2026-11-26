#!/usr/bin/env node
/**
 * CineScope · 每日一键发布
 *
 * 把 AI 编辑部完整管线串成一条命令：
 *   discover → enrich → assess → write → daily → weekly → publish --commit --push
 *
 * 设计给"每天开一次电脑"的手动模式。n8n 全自动是另一条路，
 * 这里用单进程顺序执行，失败不中断后续步骤，末尾汇总报告。
 *
 * 用法：
 *   node scripts/run-daily.mjs                  # 跑完整链路
 *   node scripts/run-daily.mjs --dry-run       # 只打印计划，不写数据
 *   node scripts/run-daily.mjs --skip-discover --skip-enrich
 *   node scripts/run-daily.mjs --only daily,weekly,publish
 *   node scripts/run-daily.mjs --no-push       # 只 commit 不 push
 *
 * Windows / macOS / Linux 通用，只需要 Node ≥ 20 + pipeline 依赖已安装。
 */
import { runDiscover } from '../pipeline/src/commands/discover.mjs';
import { runEnrich } from '../pipeline/src/commands/enrich.mjs';
import { runAssess } from '../pipeline/src/commands/assess.mjs';
import { runWrite } from '../pipeline/src/commands/write.mjs';
import { runDaily } from '../pipeline/src/commands/daily.mjs';
import { runWeekly } from '../pipeline/src/commands/weekly.mjs';
import { runPublish } from '../pipeline/src/commands/publish.mjs';
import { closePool } from '../pipeline/src/db.mjs';

const PARTS = ['discover', 'enrich', 'assess', 'write', 'daily', 'weekly', 'publish'];

function parseArgs(argv) {
  const opts = { dryRun: false, push: true };
  const only = new Set();
  const skip = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const val = eq === -1 ? undefined : body.slice(eq + 1);
    if (body === 'dry-run') opts.dryRun = true;
    else if (body === 'no-push') opts.push = false;
    else if (body === 'skip-discover') skip.add('discover');
    else if (body === 'skip-enrich') skip.add('enrich');
    else if (body === 'skip-assess') skip.add('assess');
    else if (body === 'skip-write') skip.add('write');
    else if (body === 'skip-daily') skip.add('daily');
    else if (body === 'skip-weekly') skip.add('weekly');
    else if (body === 'skip-publish') skip.add('publish');
    else if (key === 'only' && val) for (const p of val.split(',').map((s) => s.trim())) only.add(p);
    else if (body === 'help' || body === 'h') { printHelp(); process.exit(0); }
  }
  if (only.size > 0) {
    for (const p of PARTS) if (!only.has(p)) skip.add(p);
  }
  opts.skip = skip;
  return opts;
}

function printHelp() {
  console.log(`CineScope · 每日一键发布

用法：node scripts/run-daily.mjs [选项]

选项
  --dry-run          只打印计划，不写数据库/文件
  --only=a,b,c       只跑指定步骤（discover,enrich,assess,write,daily,weekly,publish）
  --skip-X           跳过某步骤（同 --only 反向，可叠加）
  --no-push          publish 只 commit 不 push
  --help             显示本帮助

示例
  node scripts/run-daily.mjs                           # 完整链路
  node scripts/run-daily.mjs --dry-run                 # 预演
  node scripts/run-daily.mjs --only daily,weekly,publish
  node scripts/run-daily.mjs --skip-discover --skip-enrich
  node scripts/run-daily.mjs --no-push                 # 改完人工 git push
`);
}

async function safeRun(label, fn) {
  const pad = label.padEnd(10);
  try {
    const t0 = performance.now();
    const result = await fn();
    const ms = Math.round(performance.now() - t0);
    const summary = summarize(label, result);
    console.log(`  ${pad} ✔ ${summary}  · ${ms}ms`);
    return { ok: true, label, result, ms };
  } catch (err) {
    const msg = err.message?.slice(0, 160) ?? String(err);
    console.log(`  ${pad} ✘ ${msg}`);
    return { ok: false, label, error: msg };
  }
}

function summarize(label, r) {
  if (!r) return '(ok)';
  if (label === 'discover') return `${r.processed ?? r.inserted ?? '?'} 部新候选`;
  if (label === 'enrich') return `${r.processed ?? '?'} 部资料补全`;
  if (label === 'assess') return `${r.processed ?? '?'} 部打分`;
  if (label === 'write') return `${r.processed ?? '?'} 篇影评`;
  if (label === 'daily') return `${r.action ?? 'ok'} · ${r.date ?? ''} issue ${r.issue ?? '?'}`;
  if (label === 'weekly') return `${r.action ?? 'ok'} · ${r.year ?? ''}-W${r.week ?? '?'}`;
  if (label === 'publish') {
    const f = r.files ?? {};
    return `${r.action ?? 'ok'} · 影片${r.films ?? '?'} 每日${r.daily ?? '?'} 周刊${r.magazine ?? '?'} 专题${r.features ?? '?'}  | git=${r.git?.committed ? '已提交' : '无变更'}${r.push?.pushed ? ' 已推送' : ''}`;
  }
  return r.action ?? '(ok)';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const start = new Date();

  console.log('\n🟢 CineScope 每日一键发布');
  console.log(`   时间：${start.toLocaleString('zh-CN')}`);
  if (opts.dryRun) console.log('   模式：DRY-RUN（不写数据）');
  if (opts.push === false) console.log('   push：已关闭（--no-push）');
  if (opts.skip.size > 0) console.log(`   跳过：${[...opts.skip].join(', ')}`);
  console.log();

  // 1. discover
  if (!opts.skip.has('discover')) {
    await safeRun('discover', () => runDiscover({ limit: 30, pages: 3, dryRun: opts.dryRun }));
  }
  // 2. enrich
  if (!opts.skip.has('enrich')) {
    await safeRun('enrich', () => runEnrich({ limit: 20, dryRun: opts.dryRun }));
  }
  // 3. assess
  if (!opts.skip.has('assess')) {
    await safeRun('assess', () => runAssess({ limit: 20, dryRun: opts.dryRun }));
  }
  // 4. write
  if (!opts.skip.has('write')) {
    await safeRun('write', () => runWrite({ limit: 6, minScore: 66, dryRun: opts.dryRun }));
  }
  // 5. daily（每天只生成一次，已存在会跳过）
  if (!opts.skip.has('daily')) {
    await safeRun('daily', () => runDaily({ publish: !opts.dryRun, dryRun: opts.dryRun }));
  }
  // 6. weekly（每周只生成一次）
  if (!opts.skip.has('weekly')) {
    await safeRun('weekly', () => runWeekly({ publish: !opts.dryRun, dryRun: opts.dryRun }));
  }
  // 7. publish（导出 md + commit + push）
  if (!opts.skip.has('publish')) {
    await safeRun('publish', () =>
      runPublish({
        dryRun: opts.dryRun,
        commit: !opts.dryRun,
        push: !opts.dryRun && opts.push,
      }),
    );
  }

  const elapsed = Math.round((performance.now() - 0) / 1000);
  console.log(`\n✅ 完成，用时约 ${elapsed}s。push 到 GitHub 后 Cloudflare Pages 会自动构建上线。\n`);
}

main()
  .catch((err) => {
    console.error(`\n💥 未捕获错误：${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
