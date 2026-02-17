// TMDB client — all API calls go through the Firebase Function proxy.
// Image CDN URLs are public and don't require a key.

import { getApp }            from 'https://www.gstatic.com/firebasejs/11.2.0/firebase-app.js';
import { getFunctions,
         httpsCallable }     from 'https://www.gstatic.com/firebasejs/11.2.0/firebase-functions.js';

const TMDB_IMG      = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP = 'https://image.tmdb.org/t/p/w1280';

// Lazy-init so the Firebase app is guaranteed to be ready
let _callTmdb = null;
function callTmdb() {
  if (!_callTmdb) {
    _callTmdb = httpsCallable(getFunctions(getApp()), 'tmdb');
  }
  return _callTmdb;
}

async function get(path, params = {}) {
  const result = await callTmdb()({ path, params });
  return result.data;
}

export function posterUrl(path)   { return path ? `${TMDB_IMG}${path}`      : null; }
export function backdropUrl(path) { return path ? `${TMDB_BACKDROP}${path}` : null; }

export async function searchMovies(query) {
  const data = await get('/search/movie', { query, include_adult: false });
  return data.results.slice(0, 8).map(normalizeMovie);
}

export async function searchTV(query) {
  const data = await get('/search/tv', { query, include_adult: false });
  return data.results.slice(0, 8).map(normalizeTV);
}

export async function getMovieDetails(id) {
  const data = await get(`/movie/${id}`, { append_to_response: 'credits' });
  return normalizeMovie(data, true);
}

export async function getTVDetails(id) {
  const data = await get(`/tv/${id}`, { append_to_response: 'credits' });
  return normalizeTV(data, true);
}

export async function getRecommendations(type, id) {
  const path = type === 'movie' ? `/movie/${id}/recommendations` : `/tv/${id}/recommendations`;
  const data = await get(path);
  return (data.results || []).slice(0, 12).map(type === 'movie' ? normalizeMovie : normalizeTV);
}

function normalizeMovie(m, full = false) {
  return {
    tmdbId:   m.id,
    type:     'movie',
    title:    m.title,
    year:        m.release_date ? m.release_date.slice(0, 4) : '—',
    releaseDate: m.release_date || null,
    overview: m.overview || '',
    poster:   posterUrl(m.poster_path),
    backdrop: backdropUrl(m.backdrop_path),
    tmdbRating: m.vote_average ? Math.round(m.vote_average * 10) : null,
    genres:   (m.genres || []).map(g => g.name),
    genreIds: m.genre_ids || (m.genres || []).map(g => g.id),
    cast:     full && m.credits ? m.credits.cast.slice(0, 4).map(c => c.name) : [],
    director: full && m.credits
      ? (m.credits.crew.find(c => c.job === 'Director') || {}).name || null
      : null,
    runtime:  m.runtime || null,
  };
}

function normalizeTV(t, full = false) {
  return {
    tmdbId:   t.id,
    type:     'tv',
    title:    t.name,
    year:        t.first_air_date ? t.first_air_date.slice(0, 4) : '—',
    releaseDate: t.first_air_date || null,
    overview: t.overview || '',
    poster:   posterUrl(t.poster_path),
    backdrop: backdropUrl(t.backdrop_path),
    tmdbRating: t.vote_average ? Math.round(t.vote_average * 10) : null,
    genres:   (t.genres || []).map(g => g.name),
    genreIds: t.genre_ids || (t.genres || []).map(g => g.id),
    cast:     full && t.credits ? t.credits.cast.slice(0, 4).map(c => c.name) : [],
    director: full && t.created_by ? (t.created_by[0] || {}).name || null : null,
    seasons:  t.number_of_seasons || null,
  };
}
