import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');

// 无论从哪个目录运行，都读取仓库根目录的 .env。
dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

export const SITE_DIR = path.join(REPO_ROOT, 'site');
export const CONTENT_DIR = path.join(SITE_DIR, 'src/content');

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  tmdbToken: process.env.TMDB_API_TOKEN ?? '',
  tmdbApiKey: process.env.TMDB_API_KEY ?? '',
  tmdbRegion: process.env.TMDB_REGION ?? 'CN',
  tmdbLanguage: process.env.TMDB_LANGUAGE ?? 'zh-CN',
  deepseekKey: process.env.DEEPSEEK_API_KEY ?? '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  cloudflareHook: process.env.CLOUDFLARE_DEPLOY_HOOK ?? '',
  siteUrl: process.env.SITE_URL ?? 'https://cinescope.pages.dev',
  timezone: process.env.PIPELINE_TIMEZONE ?? 'Asia/Shanghai',
};

export function requireEnv(key) {
  const value = env[key];
  if (!value) {
    const name = {
      databaseUrl: 'DATABASE_URL',
      tmdbToken: 'TMDB_API_TOKEN（或 TMDB_API_KEY）',
      deepseekKey: 'DEEPSEEK_API_KEY',
    }[key] ?? key;
    throw new Error(`缺少环境变量 ${name}，请参考仓库根目录 .env.example 配置。`);
  }
  return value;
}

export function hasDatabase() {
  return Boolean(env.databaseUrl);
}

export function todayInTimezone(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isoWeek(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  return { year: target.getUTCFullYear(), week };
}
