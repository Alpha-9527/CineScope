import rss from '@astrojs/rss';
import { getDaily, getFeatures, getMagazines } from '../lib/content';
import { SITE } from '../lib/site';

export const GET = async (context) => {
  const [dailies, magazines, features] = await Promise.all([
    getDaily(),
    getMagazines(),
    getFeatures(),
  ]);

  const items = [
    ...dailies.map((edition) => ({
      title: edition.data.title,
      description: edition.data.subtitle,
      pubDate: new Date(`${edition.data.date}T09:00:00+08:00`),
      link: `/daily/${edition.id}/`,
      categories: ['每日推荐'],
    })),
    ...magazines.map((issue) => ({
      title: `${issue.data.title} · 第 ${issue.data.week} 周`,
      description: issue.data.subtitle,
      pubDate: new Date(`${issue.data.date}T20:00:00+08:00`),
      link: `/magazine/${issue.id}/`,
      categories: ['每周杂志'],
    })),
    ...features.map((feature) => ({
      title: feature.data.title,
      description: feature.data.subtitle,
      pubDate: new Date(`${feature.data.date}T12:00:00+08:00`),
      link: `/features/${feature.id}/`,
      categories: ['专题'],
    })),
  ].sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  return rss({
    title: `${SITE.name} — 全球电影杂志`,
    description: SITE.description,
    site: context.site ?? SITE.url,
    items,
    customData: '<language>zh-CN</language>',
  });
};
