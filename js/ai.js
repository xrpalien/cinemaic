// AI advisor — builds taste profile from Firestore data, calls askAI function

import { getApp }        from 'https://www.gstatic.com/firebasejs/11.2.0/firebase-app.js';
import { getFunctions,
         httpsCallable } from 'https://www.gstatic.com/firebasejs/11.2.0/firebase-functions.js';

let _askAI = null;
function callAskAI() {
  if (!_askAI) _askAI = httpsCallable(getFunctions(getApp()), 'askAI');
  return _askAI;
}

let _submitFeedback = null;
function callSubmitFeedback() {
  if (!_submitFeedback) _submitFeedback = httpsCallable(getFunctions(getApp()), 'submitFeedback');
  return _submitFeedback;
}

/**
 * Build a taste profile from the user's stored items.
 * Sent to the AI as context — no raw IDs or internal fields.
 */
export function buildTasteProfile(items, tasteNotes = '') {
  const watched = items.filter(i => i.watched);

  const loved = watched
    .filter(i => i.rating >= 4)
    .map(i => ({
      title:  i.title,
      year:   i.year,
      genres: i.genres || [],
      stars:  i.rating,
      ...(i.notes ? { notes: i.notes } : {}),
    }));

  const liked = watched
    .filter(i => i.rating === 3)
    .map(i => ({ title: i.title, genres: i.genres || [] }));

  const watchedUnrated = watched
    .filter(i => !i.rating)
    .map(i => i.title);

  const watchlist = items
    .filter(i => !i.watched)
    .map(i => i.title);

  // Weighted genre affinity: each genre scored by sum of star ratings
  const genreScore = {};
  watched.forEach(i => {
    const weight = i.rating || 3;
    (i.genres || []).forEach(g => {
      genreScore[g] = (genreScore[g] || 0) + weight;
    });
  });
  const topGenres = Object.entries(genreScore)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([g]) => g);

  return {
    loved,
    liked,
    watchedUnrated,
    watchlist,
    topGenres,
    ...(tasteNotes.trim() ? { personalNotes: tasteNotes.trim() } : {}),
  };
}

/**
 * Send a natural-language prompt to the AI advisor.
 * Returns an array of { title, type, reason }.
 */
export async function askAI(tasteProfile, prompt, mediaType) {
  const result = await callAskAI()({ tasteProfile, prompt, mediaType });
  return result.data;
}

export async function submitFeedback(type, title, body) {
  const result = await callSubmitFeedback()({ type, title, body });
  return result.data;
}
