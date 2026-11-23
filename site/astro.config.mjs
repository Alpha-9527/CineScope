import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

const site = process.env.SITE_URL || 'https://cinescope.pages.dev';

export default defineConfig({
  site,
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/rss.xml'),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
