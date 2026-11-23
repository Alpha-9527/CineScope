export const SITE = {
  name: 'CineScope',
  tagline: '在主流之外，重新发现电影',
  description:
    'CineScope 是一本由 AI 编辑部持续出版的全球电影杂志：每天发现值得观看的电影，每周出版一期完整刊物。',
  url: import.meta.env.SITE ?? 'https://cinescope.pages.dev',
  author: 'CineScope AI Editorial Team',
  locale: 'zh-CN',
  nav: [
    { label: '每日推荐', href: '/daily/' },
    { label: '每周杂志', href: '/magazine/' },
    { label: '专题', href: '/features/' },
    { label: '往期', href: '/archive/' },
    { label: '关于', href: '/about/' },
  ],
};

const CN_MONTHS = [
  '一月',
  '二月',
  '三月',
  '四月',
  '五月',
  '六月',
  '七月',
  '八月',
  '九月',
  '十月',
  '十一月',
  '十二月',
];

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${y} 年 ${CN_MONTHS[m - 1]} ${d} 日`;
}

export function formatDateShort(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}`;
}

export function formatWeekday(iso: string): string {
  const date = new Date(`${iso}T00:00:00+08:00`);
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' }).format(date);
}

export function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} 分钟`;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`;
}

export function issueLabel(issue: number): string {
  return `NO.${String(issue).padStart(3, '0')}`;
}

export function weekLabel(year: number, week: number): string {
  return `${year} · 第 ${week} 周`;
}

export function byDateDesc<T extends { data: { date: string } }>(a: T, b: T): number {
  return b.data.date.localeCompare(a.data.date);
}
