import { getCollection } from 'astro:content';

export type FilmEntry = Awaited<ReturnType<typeof getCollection<'films'>>>[number];

export async function getFilms() {
  const films = await getCollection('films');
  return films
    .map((film) => ({ ...film, slug: film.id }))
    .sort((a, b) => b.data.scores.final - a.data.scores.final);
}

export type FilmWithSlug = Awaited<ReturnType<typeof getFilms>>[number];

export async function getFilmMap(): Promise<Map<string, FilmWithSlug>> {
  const films = await getFilms();
  return new Map(films.map((film) => [film.slug, film]));
}

export async function getDaily() {
  const editions = await getCollection('daily');
  return editions.sort((a, b) => b.data.date.localeCompare(a.data.date));
}

export async function getMagazines() {
  const issues = await getCollection('magazine');
  return issues.sort((a, b) => b.data.date.localeCompare(a.data.date));
}

export async function getFeatures() {
  const features = await getCollection('features');
  return features.sort((a, b) => b.data.date.localeCompare(a.data.date));
}
