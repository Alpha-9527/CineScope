import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const palette = z.enum([
  'dusk',
  'ember',
  'moss',
  'sand',
  'ash',
  'ink',
  'rust',
  'sea',
  'paper',
]);

const sources = z
  .array(
    z.object({
      label: z.string(),
      url: z.string().url().optional(),
      retrieved: z.string().optional(),
    }),
  )
  .default([]);

const films = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/films' }),
  schema: z.object({
    title: z.string(),
    originalTitle: z.string(),
    year: z.number(),
    countries: z.array(z.string()),
    language: z.string(),
    runtime: z.number(),
    directors: z.array(z.string()),
    cast: z.array(z.string()).default([]),
    genres: z.array(z.string()).default([]),
    palette: palette.default('ink'),
    poster: z.string().optional(),
    backdrop: z.string().optional(),
    tmdbId: z.number().optional(),
    imdbId: z.string().optional(),
    ratings: z
      .object({
        imdb: z.number().optional(),
        votes: z.number().optional(),
        source: z.string().default('IMDb 官方数据集'),
      })
      .default({ source: 'IMDb 官方数据集' }),
    scores: z.object({
      audience: z.number(),
      artistic: z.number(),
      recommendation: z.number(),
      confidence: z.number(),
      final: z.number(),
    }),
    selection: z
      .object({
        issue: z.string().optional(),
        angle: z.string().optional(),
      })
      .default({}),
    dataStatus: z.enum(['sample', 'verified']).default('sample'),
    sources,
  }),
});

const daily = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/daily' }),
  schema: z.object({
    date: z.string(),
    issue: z.number(),
    title: z.string(),
    subtitle: z.string(),
    editorIntro: z.string(),
    films: z.array(
      z.object({
        slug: z.string(),
        note: z.string(),
      }),
    ),
    closing: z.string(),
    sources,
  }),
});

const magazine = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/magazine' }),
  schema: z.object({
    year: z.number(),
    week: z.number(),
    date: z.string(),
    title: z.string(),
    subtitle: z.string(),
    theme: z.string(),
    editorIntro: z.string(),
    coverPalette: palette.default('ash'),
    leadFilm: z.string().optional(),
    picks: z.array(z.object({ slug: z.string(), note: z.string() })),
    specialFinds: z.array(z.object({ slug: z.string(), note: z.string() })),
    closing: z.string(),
    sources,
  }),
});

const features = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/features' }),
  schema: z.object({
    title: z.string(),
    subtitle: z.string(),
    date: z.string(),
    topic: z.string(),
    films: z.array(z.string()).default([]),
    palette: palette.default('ash'),
    sources,
  }),
});

export const collections = { films, daily, magazine, features };
