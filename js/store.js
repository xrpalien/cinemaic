// Persistence layer — Firestore with in-memory cache
// getAll() stays synchronous (reads from cache) so render functions need no changes.
// Write operations are async. onSnapshot keeps the cache live.

import { db } from './firebase.js';
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  updateDoc,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js';

// ─── In-memory cache ──────────────────────────────────────────────────────────
const cache = { movie: [], tv: [] };
let profileCache = { tasteNotes: '' };
let currentUid = null;
const unsubscribers = { movie: null, tv: null, profile: null };

// ─── Auth handoff ─────────────────────────────────────────────────────────────
// Called by app.js when auth state changes.
export function setUser(uid) {
  // Tear down existing listeners
  unsubscribers.movie?.();
  unsubscribers.tv?.();
  unsubscribers.profile?.();
  unsubscribers.movie   = null;
  unsubscribers.tv      = null;
  unsubscribers.profile = null;

  currentUid = uid;

  if (!uid) {
    cache.movie = [];
    cache.tv    = [];
    profileCache = { tasteNotes: '' };
    return;
  }

  // Set up real-time listeners for media collections
  for (const type of ['movie', 'tv']) {
    unsubscribers[type] = onSnapshot(
      collection(db, 'users', uid, type),
      snap => {
        cache[type] = snap.docs.map(d => d.data());
        window.__cinemaic_onStoreUpdate?.();
      }
    );
  }

  // Listen to profile doc for taste notes
  unsubscribers.profile = onSnapshot(
    doc(db, 'users', uid, 'profile', 'taste'),
    snap => { profileCache.tasteNotes = snap.exists() ? (snap.data().tasteNotes || '') : ''; }
  );
}

// ─── Reads (synchronous — from cache) ────────────────────────────────────────
export function getAll(type) {
  return cache[type];
}

export function getItem(type, tmdbId) {
  return cache[type].find(i => i.tmdbId === tmdbId) || null;
}

// ─── Writes (async — go to Firestore) ────────────────────────────────────────
function ref(type, tmdbId) {
  return doc(db, 'users', currentUid, type, String(tmdbId));
}

export async function addItem(type, item) {
  if (!currentUid) return false;
  if (cache[type].find(i => i.tmdbId === item.tmdbId)) return false;
  await setDoc(ref(type, item.tmdbId), {
    ...item,
    addedAt:   Date.now(),
    watched:   false,
    rating:    null,
    notes:     '',
  });
  return true;
}

export async function removeItem(type, tmdbId) {
  if (!currentUid) return;
  await deleteDoc(ref(type, tmdbId));
}

export async function markWatched(type, tmdbId, rating = null, notes = '') {
  if (!currentUid) return;
  await updateDoc(ref(type, tmdbId), {
    watched:   true,
    watchedAt: Date.now(),
    rating,
    notes,
  });
}

export async function unmarkWatched(type, tmdbId) {
  if (!currentUid) return;
  await updateDoc(ref(type, tmdbId), {
    watched:   false,
    watchedAt: null,
    rating:    null,
    notes:     '',
  });
}

export async function updateRating(type, tmdbId, rating, notes) {
  if (!currentUid) return;
  await updateDoc(ref(type, tmdbId), { rating, notes });
}

export async function patchItem(type, tmdbId, updates) {
  if (!currentUid) return;
  await updateDoc(ref(type, tmdbId), updates);
}

// ─── Taste profile notes ──────────────────────────────────────────────────────
export function getTasteNotes() {
  return profileCache.tasteNotes;
}

export async function saveTasteNotes(notes) {
  if (!currentUid) return;
  await setDoc(doc(db, 'users', currentUid, 'profile', 'taste'), { tasteNotes: notes });
  profileCache.tasteNotes = notes;
}
