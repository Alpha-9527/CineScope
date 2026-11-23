import { env } from './src/env.mjs';
import { one } from './src/db.mjs';
import { tmdbGet } from './src/tmdb.mjs';

const results = {};

try {
  const db = await one(`SELECT current_database() AS db, current_user AS usr, version() AS version`);
  results.database = { ok: true, db: db.db, user: db.usr, version: String(db.version).split(',')[0] };
} catch (error) {
  results.database = { ok: false, error: error.message };
}

try {
  const movie = await tmdbGet('/movie/550', { language: env.tmdbLanguage });
  results.tmdb = { ok: true, title: movie.title, year: (movie.release_date ?? '').slice(0, 4) };
} catch (error) {
  results.tmdb = { ok: false, error: error.message };
}

try {
  const response = await fetch(`${env.deepseekBaseUrl}/models`, {
    headers: { authorization: `Bearer ${env.deepseekKey}` },
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  results.deepseek = response.ok
    ? { ok: true, models: (body.data ?? []).map((m) => m.id) }
    : { ok: false, status: response.status, error: JSON.stringify(body).slice(0, 200) };
} catch (error) {
  results.deepseek = { ok: false, error: error.message };
}

results.site = { url: env.siteUrl };
results.cloudflareHook = env.cloudflareHook ? 'set' : 'empty';
console.log(JSON.stringify(results, null, 2));
process.exit(0);
