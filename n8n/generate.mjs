#!/usr/bin/env node
/**
 * 生成 n8n 工作流 JSON。
 *
 * 每条工作流都以「定时触发 → 执行管线命令 → 解析输出」的最小结构组织，
 * 便于在自托管 n8n 中直接导入、逐条启用。执行命令依赖服务器上的
 * /opt/cinescope/pipeline 与已配置好的 .env。
 *
 * 运行：node n8n/generate.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = here;
const PIPELINE = 'cd /opt/cinescope/pipeline && node src/cli.mjs';

function scheduleNode(id, cron) {
  return {
    parameters: {
      rule: {
        interval: [{ field: 'cronExpression', expression: cron }],
      },
    },
    id: `${id}-schedule`,
    name: '定时触发',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, 0],
  };
}

function manualNode(id) {
  return {
    parameters: {},
    id: `${id}-manual`,
    name: '手动触发',
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: [0, 160],
  };
}

function commandNode(id, index, name, command, { retry = false } = {}) {
  const node = {
    parameters: { command },
    id: `${id}-cmd-${index}`,
    name,
    type: 'n8n-nodes-base.executeCommand',
    typeVersion: 1,
    position: [220 + index * 220, 0],
    ...(retry ? { retryOnFail: true, maxTries: 2, waitBetweenTries: 120000 } : {}),
  };
  return node;
}

function summaryNode(id, position) {
  return {
    parameters: {
      jsCode: `// 汇总最后一条命令的 JSON 输出，执行失败时保留 stderr 方便排查
const items = $input.all();
const last = items[items.length - 1]?.json ?? {};
let summary = null;
try {
  summary = JSON.parse(last.stdout ?? '{}');
} catch {
  summary = { raw: String(last.stdout ?? '').slice(-2000) };
}
if (last.exitCode !== undefined && last.exitCode !== 0) {
  throw new Error('管线命令失败：' + String(last.stderr ?? '').slice(-1500));
}
return [{ json: { summary, exitCode: last.exitCode ?? 0 } }];`,
    },
    id: `${id}-summary`,
    name: '解析输出',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function sticky(id, content, position = [-40, -260]) {
  return {
    parameters: {
      content,
      height: 200,
      width: 340,
      color: 4,
    },
    id: `${id}-note`,
    name: '运行说明',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position,
  };
}

function build({ id, name, cron, description, steps, manual = false }) {
  const nodes = [];
  const connections = {};
  const stepsNodes = steps.map((step, index) =>
    commandNode(id, index, step.name, step.command, { retry: step.retry }),
  );
  const lastPosition = [220 + steps.length * 220, 0];
  nodes.push(sticky(id, description));
  if (manual) {
    nodes.push(manualNode(id));
    nodes.push(scheduleNode(id, cron));
  } else {
    nodes.push(scheduleNode(id, cron));
  }
  nodes.push(...stepsNodes, summaryNode(id, lastPosition));

  if (manual) {
    connections['定时触发'] = { main: [[{ node: stepsNodes[0].name, type: 'main', index: 0 }]] };
    connections['手动触发'] = { main: [[{ node: stepsNodes[0].name, type: 'main', index: 0 }]] };
  } else {
    connections['定时触发'] = { main: [[{ node: stepsNodes[0].name, type: 'main', index: 0 }]] };
  }
  for (let index = 0; index < stepsNodes.length - 1; index += 1) {
    connections[stepsNodes[index].name] = {
      main: [[{ node: stepsNodes[index + 1].name, type: 'main', index: 0 }]],
    };
  }
  connections[stepsNodes[stepsNodes.length - 1].name] = {
    main: [[{ node: '解析输出', type: 'main', index: 0 }]],
  };

  return {
    name,
    nodes,
    connections,
    active: false,
    settings: {
      executionOrder: 'v1',
      timezone: 'Asia/Shanghai',
      saveManualExecutions: true,
      executionTimeout: 3600,
    },
    staticData: null,
    meta: { templateCredsSetupCompleted: true },
    tags: [{ name: 'CineScope' }],
    versionId: `${id}-v1`,
    id: id.toUpperCase(),
  };
}

const WORKFLOWS = [
  build({
    id: 'wf01',
    name: 'WF01 · 全球电影发现',
    cron: '0 2 * * *',
    description: '每天 02:00 从 TMDb 按地区与年份发现候选影片，去重后写入 films。\n需要：DATABASE_URL、TMDB_API_TOKEN。',
    steps: [{ name: '发现候选影片', command: `${PIPELINE} discover --limit=30 --pages=3`, retry: true }],
  }),
  build({
    id: 'wf02',
    name: 'WF02 · 电影资料补全',
    cron: '30 2 * * *',
    description: '每天 02:30 补全候选影片的演职员、国家、语言、海报与观看渠道。\n需要：DATABASE_URL、TMDB_API_TOKEN。',
    steps: [{ name: '补全影片资料', command: `${PIPELINE} enrich --limit=20`, retry: true }],
  }),
  build({
    id: 'wf03',
    name: 'WF03 · AI 质量评估',
    cron: '0 3 * * *',
    description: '每天 03:00 对未评估影片做 R/A/D 三维打分并计算 S = Q × C。\n需要：DATABASE_URL、DEEPSEEK_API_KEY。',
    steps: [{ name: '评估候选影片', command: `${PIPELINE} assess --limit=20`, retry: true }],
  }),
  build({
    id: 'wf04',
    name: 'WF04 · AI 编辑撰稿',
    cron: '0 4 * * *',
    description: '每天 04:00 为达标影片生成影评并自动校对。\n校对不通过的文章停留在 review，不进入网站。\n需要：DATABASE_URL、DEEPSEEK_API_KEY。',
    steps: [{ name: '撰写与校对', command: `${PIPELINE} write --limit=6`, retry: true }],
  }),
  build({
    id: 'wf05',
    name: 'WF05 · 每日刊物',
    cron: '30 6 * * *',
    description: '每天 06:30（DeepSeek 空闲时段，价格约为高峰一半）生成当日推荐。\n09:30 由 WF07 导出并推送，站点上线时间不变。\n若当天候选质量不足，管线会自动少选，不会凑数。\n需要：数据库、DeepSeek。',
    steps: [{ name: '生成每日刊物', command: `${PIPELINE} daily --publish` }],
  }),
  build({
    id: 'wf06',
    name: 'WF06 · 每周杂志',
    cron: '0 20 * * 0',
    description: '每周日 20:00 独立策划本期主题、片单与特别发现。\n周日全天属于 DeepSeek 空闲时段，价格约为高峰一半。\n推送仍由 WF07 在次日 09:30 统一完成。\n周刊不是每日内容的机械汇总。',
    steps: [{ name: '生成周刊', command: `${PIPELINE} weekly --publish` }],
  }),
  build({
    id: 'wf07',
    name: 'WF07 · 静态站点发布',
    cron: '30 9 * * *',
    description:
      '把已发布内容导出为 Markdown 并提交到 Git；宿主机定时任务（每 10 分钟）推送后，Cloudflare Pages 自动构建上线。\n容器内不安装 SSH 私钥、不执行 npm build：构建交给 Cloudflare，失败时线上保持上一个正常版本。\npublish_logs 保留每次导出的记录。',
    manual: true,
    steps: [{ name: '导出并提交', command: `${PIPELINE} publish --commit` }],
  }),
  build({
    id: 'wf08',
    name: 'WF08 · 数据库维护',
    cron: '30 3 * * 0',
    description: '每周日 03:30 备份数据库并做一致性检查。\n只清理日志与过期渠道数据，不删除正式文章和已出版刊物。',
    steps: [
      {
        name: '备份数据库',
        command:
          'cd /opt/cinescope && mkdir -p backups && if command -v pg_dump >/dev/null 2>&1; then set -a && . ./.env && set +a && pg_dump "$DATABASE_URL" | gzip > "backups/cinescope-$(date +%F).sql.gz" && ls -lh backups | tail -n 5; else echo \'{"backup":"skipped","reason":"pg_dump not installed in n8n container"}\'; fi',
      },
      { name: '一致性检查', command: `${PIPELINE} maintain --log-days=180 --availability-days=180` },
    ],
  }),
];

async function main() {
  for (const workflow of WORKFLOWS) {
    const fileName = `${workflow.name.split(' ')[0].toLowerCase()}-${workflow.name
      .split('·')[1]
      .trim()
      .replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, '-')}.json`;
    const target = path.join(OUT_DIR, fileName);
    await fs.writeFile(target, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
    console.log(`written ${path.relative(process.cwd(), target)}`);
  }

  console.log(`\n共 ${WORKFLOWS.length} 个工作流，全部 active=false，导入后需手动启用。`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
