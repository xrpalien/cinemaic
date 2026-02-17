import { searchMovies, searchTV, getMovieDetails, getTVDetails, getRecommendations } from './tmdb.js';
import { getAll, addItem, removeItem, markWatched, unmarkWatched, updateRating, patchItem, setUser, getTasteNotes, saveTasteNotes } from './store.js';
import { auth, signIn, signOutUser, onAuthStateChanged } from './firebase.js';
import { buildTasteProfile, askAI } from './ai.js';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  mediaType: 'movie',   // 'movie' | 'tv'
  filter: 'watchlist',  // 'watchlist' | 'watched' | 'explore'
  sort: 'alpha',        // 'alpha' | 'year' | 'rating'
  genreFilter: null,    // null = all, or a genre string
  searchQuery: '',
  searchResults: [],
  searchLoading: false,
  activeCard: null,     // item being detailed/rated
  aiResults: [],        // last AI recommendation results
  aiLoading: false,
  aiPrompt: '',         // last submitted prompt
};

let searchDebounce = null;

// ─── Auth state ───────────────────────────────────────────────────────────────
function setAuthState(user) {
  const signInScreen = document.getElementById('sign-in-screen');
  const appShell     = document.getElementById('app-shell');
  const userAvatar   = document.getElementById('user-avatar');
  const userName     = document.getElementById('user-name');

  if (user) {
    signInScreen.hidden = true;
    appShell.hidden     = false;
    if (userAvatar) userAvatar.src           = user.photoURL || '';
    if (userAvatar) userAvatar.hidden        = !user.photoURL;
    if (userName)   userName.textContent     = user.displayName?.split(' ')[0] || 'You';
    setUser(user.uid);
    render();
    setTimeout(backfillMissingData, 1500);
  } else {
    signInScreen.hidden = false;
    appShell.hidden     = true;
    setUser(null);
  }
}

// Store updates (onSnapshot) trigger re-render via this hook
window.__cinemaic_onStoreUpdate = () => render();

// Silently backfill tmdbRating + genres for items added before full details were fetched on add
async function backfillMissingData() {
  for (const type of ['movie', 'tv']) {
    const needsBackfill = getAll(type).filter(
      i => i.tmdbRating == null || !i.genres?.length || i.releaseDate === undefined || !i.genreIds?.length
    );
    for (const item of needsBackfill) {
      try {
        const details = type === 'movie'
          ? await getMovieDetails(item.tmdbId)
          : await getTVDetails(item.tmdbId);
        const updates = {};
        if (details.tmdbRating != null)        updates.tmdbRating  = details.tmdbRating;
        if (details.genres?.length)            updates.genres      = details.genres;
        if (details.genreIds?.length)          updates.genreIds    = details.genreIds;
        if (details.releaseDate !== undefined) updates.releaseDate = details.releaseDate ?? null;
        if (Object.keys(updates).length) await patchItem(type, item.tmdbId, updates);
      } catch { /* silent — best-effort */ }
    }
  }
}

onAuthStateChanged(auth, setAuthState);

// Exported for index.html onclick handlers
export { signIn, signOutUser };

// ─── Render ───────────────────────────────────────────────────────────────────
export function render() {
  renderNav();
  renderFilters();
  renderGrid();
}

function renderNav() {
  document.getElementById('nav-movie').classList.toggle('active', state.mediaType === 'movie');
  document.getElementById('nav-tv').classList.toggle('active', state.mediaType === 'tv');
}

function renderFilters() {
  document.getElementById('filter-watchlist').classList.toggle('active', state.filter === 'watchlist');
  document.getElementById('filter-watched').classList.toggle('active', state.filter === 'watched');
  document.getElementById('filter-explore').classList.toggle('active', state.filter === 'explore');
  const isExplore = state.filter === 'explore';
  document.getElementById('card-grid').parentElement.hidden = isExplore;
  document.getElementById('explore-view').hidden = !isExplore;
  document.getElementById('sort-wrap').hidden = isExplore;
  document.getElementById('sort-select').value = state.sort;
  if (isExplore) {
    document.getElementById('genre-bar').hidden = true;
    renderExplore();
  } else {
    renderGenreBar();
  }
}

function renderGenreBar() {
  const bar = document.getElementById('genre-bar');
  const items = getAll(state.mediaType).filter(i =>
    state.filter === 'watchlist' ? !i.watched : i.watched
  );
  const genres = [...new Set(items.flatMap(i => i.genres || []))].sort();

  if (genres.length === 0) { bar.hidden = true; return; }

  bar.hidden = false;
  bar.innerHTML = ['All', ...genres].map(g => {
    const isAll = g === 'All';
    const active = isAll ? !state.genreFilter : state.genreFilter === g;
    const onclick = isAll ? `app.setGenre(null)` : `app.setGenre('${g.replace(/'/g, "\\'")}')`;
    return `<button class="genre-chip${active ? ' active' : ''}" onclick="${onclick}">${g}</button>`;
  }).join('');
}

async function renderExplore() {
  const container = document.getElementById('explore-view');
  const watched = getAll(state.mediaType).filter(i => i.watched);
  const mediaLabel = state.mediaType === 'movie' ? 'movie' : 'show';

  // Always render the AI chat section + TMDB rows skeleton first
  container.innerHTML = `
    <div class="ai-chat-section">
      <div class="ai-chat-header">
        <span class="ai-chat-label">cinem<span class="ai-highlight">AI</span>c advisor</span>
        <span class="ai-chat-hint">Describe your mood and get personalised picks</span>
      </div>
      <div class="ai-chat-input-row">
        <input id="ai-prompt-input" class="ai-prompt-input" type="text"
          placeholder="e.g. Life was hard today, find me something light and funny in sci-fi"
          value="${state.aiPrompt.replace(/"/g, '&quot;')}" autocomplete="off" />
        <button id="ai-clear-btn" class="ai-clear-btn" ${!state.aiPrompt && !state.aiResults.length ? 'hidden' : ''}>
          Clear
        </button>
        <button id="ai-submit-btn" class="ai-submit-btn" ${watched.length === 0 ? 'disabled title="Add watched titles first"' : ''}>
          Ask <span class="ai-btn-spark">✦</span>
        </button>
      </div>
      <div id="ai-results-section"></div>
    </div>
    <div id="tmdb-rows-section"></div>
  `;

  // Restore previous AI results if any
  if (state.aiResults.length > 0) {
    renderAIResults(state.aiResults, state.aiPrompt);
  }

  // Wire up chat input
  const input    = document.getElementById('ai-prompt-input');
  const btn      = document.getElementById('ai-submit-btn');
  const clearBtn = document.getElementById('ai-clear-btn');

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') btn.click();
  });

  btn.addEventListener('click', async () => {
    const prompt = input.value.trim();
    if (!prompt) return;
    state.aiPrompt = prompt;
    await submitAIPrompt(prompt);
  });

  clearBtn?.addEventListener('click', () => {
    state.aiPrompt  = '';
    state.aiResults = [];
    input.value     = '';
    document.getElementById('ai-results-section').innerHTML = '';
    clearBtn.hidden = true;
    input.focus();
  });

  // Render TMDB "Because you liked" rows
  const tmdbSection = document.getElementById('tmdb-rows-section');

  if (watched.length === 0) {
    tmdbSection.innerHTML = `
      <div class="explore-empty">
        <div class="empty-icon">🎬</div>
        <p class="empty-label">Nothing watched yet.</p>
        <p class="empty-hint">Mark some ${mediaLabel}s as watched and Explore will personalise recommendations for you.</p>
      </div>`;
    return;
  }

  const sources = [...watched]
    .sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.watchedAt || 0) - (a.watchedAt || 0))
    .slice(0, 6);

  tmdbSection.innerHTML = sources.map(item => `
    <div class="explore-row" id="row-${item.tmdbId}">
      <div class="explore-row-header">
        <span class="explore-because">Because you liked</span>
        <span class="explore-title">${item.title}</span>
        ${item.rating ? `<span class="explore-rating">${'★'.repeat(item.rating)}</span>` : ''}
      </div>
      <div class="explore-shelf" id="shelf-${item.tmdbId}">
        <div class="shelf-loading">${skeletons(6)}</div>
      </div>
    </div>
  `).join('');

  sources.forEach(async item => {
    try {
      const allRecs = await getRecommendations(state.mediaType, item.tmdbId);

      // Filter: must share at least one genre with the source + meet quality floor
      const sourceGenreIds = new Set(item.genreIds || []);
      const recs = allRecs.filter(r => {
        const qualityOk = !r.tmdbRating || r.tmdbRating >= 55;
        const genreMatch = sourceGenreIds.size === 0
          || (r.genreIds || []).some(id => sourceGenreIds.has(id));
        return qualityOk && genreMatch;
      });

      const allOnList = new Set(getAll(state.mediaType).map(i => i.tmdbId));
      const shelf = document.getElementById(`shelf-${item.tmdbId}`);
      if (!shelf) return;

      if (recs.length === 0) {
        shelf.innerHTML = `<p class="shelf-empty">No recommendations found.</p>`;
        return;
      }

      shelf.innerHTML = recs.map(r => exploreCardHTML(r, allOnList.has(r.tmdbId))).join('');
      bindExploreShelf(shelf, recs);
    } catch {
      const shelf = document.getElementById(`shelf-${item.tmdbId}`);
      if (shelf) shelf.innerHTML = `<p class="shelf-empty">Couldn't load recommendations.</p>`;
    }
  });
}

async function submitAIPrompt(prompt) {
  const btn        = document.getElementById('ai-submit-btn');
  const resultsEl  = document.getElementById('ai-results-section');
  if (!btn || !resultsEl) return;

  btn.disabled = true;
  btn.textContent = '...';
  resultsEl.innerHTML = `
    <div class="ai-results-loading">
      <div class="spinner"></div>
      <span>Thinking about your taste…</span>
    </div>`;

  try {
    const allItems = getAll(state.mediaType);
    const profile  = buildTasteProfile(allItems, getTasteNotes());
    const response = await askAI(profile, prompt, state.mediaType);

    const clearBtn = document.getElementById('ai-clear-btn');

    if (response.type === 'answer') {
      renderAIAnswer(response, prompt);
      if (clearBtn) clearBtn.hidden = false;

    } else {
      // recommendations — resolve each title against TMDB to get poster + real data
      const searchFn = state.mediaType === 'movie' ? searchMovies : searchTV;
      const resolved = await Promise.all(
        (response.items || []).map(async pick => {
          try {
            const results = await searchFn(pick.title);
            return { ...pick, tmdbItem: results[0] || null };
          } catch {
            return { ...pick, tmdbItem: null };
          }
        })
      );

      state.aiResults = resolved;
      renderAIResults(resolved, prompt);
      if (clearBtn) clearBtn.hidden = false;
    }

  } catch (err) {
    resultsEl.innerHTML = `<div class="ai-results-error">Something went wrong. Try again.</div>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Ask <span class="ai-btn-spark">✦</span>';
    }
  }
}

function renderAIResults(results, prompt) {
  const resultsEl = document.getElementById('ai-results-section');
  if (!resultsEl) return;

  const allOnList = new Set(getAll(state.mediaType).map(i => i.tmdbId));

  resultsEl.innerHTML = `
    <div class="ai-results-header">
      <span class="ai-results-because">Picked for:</span>
      <span class="ai-results-prompt">"${prompt}"</span>
    </div>
    <div class="ai-results-shelf">
      ${results.map(pick => {
        const item = pick.tmdbItem;
        if (!item) return '';
        const posterStyle = item.poster
          ? `background-image: url('${item.poster}')`
          : 'background: var(--surface2)';
        const onList = allOnList.has(item.tmdbId);
        return `
          <div class="ai-result-card" data-id="${item.tmdbId}">
            <div class="explore-card-poster" style="${posterStyle}">
              <div class="explore-card-overlay">
                <div class="explore-card-title">${item.title}</div>
                <div class="explore-card-year">${item.year}${item.tmdbRating ? ` · ${item.tmdbRating}%` : ''}</div>
                <button class="btn-explore-add ${onList ? 'on-list' : ''}" ${onList ? 'disabled' : ''}>
                  ${onList ? '✓ In list' : '+ Watchlist'}
                </button>
              </div>
            </div>
            <p class="ai-result-reason">${pick.reason}</p>
          </div>`;
      }).join('')}
    </div>
  `;

  // Bind add-to-watchlist events
  resultsEl.querySelectorAll('.ai-result-card').forEach(card => {
    const id   = parseInt(card.dataset.id);
    const pick = results.find(p => p.tmdbItem?.tmdbId === id);
    card.querySelector('.btn-explore-add')?.addEventListener('click', async e => {
      e.stopPropagation();
      if (pick?.tmdbItem) {
        await addItem(state.mediaType, pick.tmdbItem);
        const addBtn = card.querySelector('.btn-explore-add');
        addBtn.textContent = '✓ Added';
        addBtn.disabled = true;
      }
    });
    card.addEventListener('click', () => openDetailModal(state.mediaType, id));
  });
}

function renderAIAnswer(response, prompt) {
  const resultsEl = document.getElementById('ai-results-section');
  if (!resultsEl) return;
  resultsEl.innerHTML = `
    <div class="ai-results-header">
      <span class="ai-results-because">Asked:</span>
      <span class="ai-results-prompt">"${prompt}"</span>
    </div>
    <div class="ai-answer">
      ${response.heading ? `<div class="ai-answer-heading">${response.heading}</div>` : ''}
      <p class="ai-answer-text">${response.text}</p>
    </div>
  `;
}

function bindExploreShelf(shelf, recs) {
  shelf.querySelectorAll('.explore-card').forEach(card => {
    const id  = parseInt(card.dataset.id);
    const rec = recs.find(r => r.tmdbId === id);
    card.querySelector('.btn-explore-add')?.addEventListener('click', async e => {
      e.stopPropagation();
      if (rec) {
        await addItem(state.mediaType, rec);
        const addBtn = card.querySelector('.btn-explore-add');
        addBtn.textContent = '✓ Added';
        addBtn.disabled = true;
      }
    });
    card.addEventListener('click', () => openDetailModal(state.mediaType, id));
  });
}

function skeletons(n) {
  return Array(n).fill(0).map(() =>
    `<div class="explore-card skeleton"><div class="explore-card-poster skeleton-poster"></div></div>`
  ).join('');
}

function exploreCardHTML(item, onList) {
  const posterStyle = item.poster
    ? `background-image: url('${item.poster}')`
    : 'background: var(--surface2)';
  return `
    <div class="explore-card" data-id="${item.tmdbId}">
      <div class="explore-card-poster" style="${posterStyle}">
        <div class="explore-card-overlay">
          <div class="explore-card-title">${item.title}</div>
          <div class="explore-card-year">${item.year}${item.tmdbRating ? ` · ${item.tmdbRating}%` : ''}</div>
          <button class="btn-explore-add ${onList ? 'on-list' : ''}" ${onList ? 'disabled' : ''}>
            ${onList ? '✓ In list' : '+ Watchlist'}
          </button>
        </div>
      </div>
    </div>`;
}

function renderGrid() {
  const grid     = document.getElementById('card-grid');
  const empty    = document.getElementById('empty-state');
  const upcomingSection = document.getElementById('upcoming-section');
  const upcomingGrid    = document.getElementById('upcoming-grid');
  if (state.filter === 'explore') return;

  let items = getAll(state.mediaType).filter(i =>
    state.filter === 'watchlist' ? !i.watched : i.watched
  );

  // Genre filter
  if (state.genreFilter) {
    items = items.filter(i => i.genres?.includes(state.genreFilter));
  }

  // Sort
  items = [...items].sort((a, b) => {
    if (state.sort === 'year') {
      const diff = (b.year || '0').localeCompare(a.year || '0');
      return diff !== 0 ? diff : a.title.localeCompare(b.title);
    }
    if (state.sort === 'rating') {
      // Sort by TMDB %; unrated items sink to the bottom
      if (a.tmdbRating == null && b.tmdbRating == null) return a.title.localeCompare(b.title);
      if (a.tmdbRating == null) return 1;
      if (b.tmdbRating == null) return -1;
      const diff = b.tmdbRating - a.tmdbRating;
      return diff !== 0 ? diff : a.title.localeCompare(b.title);
    }
    return a.title.localeCompare(b.title); // 'alpha' default
  });

  // Split into released vs upcoming
  const today    = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  const released = items.filter(i => !i.releaseDate || i.releaseDate <= today);
  const upcoming = items.filter(i => i.releaseDate && i.releaseDate > today);

  if (released.length === 0 && upcoming.length === 0) {
    grid.innerHTML = '';
    upcomingSection.hidden = true;
    empty.hidden = false;
    empty.querySelector('.empty-label').textContent =
      state.filter === 'watchlist'
        ? `No ${state.mediaType === 'movie' ? 'movies' : 'shows'} on your watchlist yet.`
        : `Nothing watched yet. Go watch something!`;
    return;
  }

  empty.hidden = true;
  grid.innerHTML = released.map(item => cardHTML(item)).join('');

  // Upcoming section
  if (upcoming.length > 0) {
    upcomingSection.hidden = false;
    upcomingGrid.innerHTML = upcoming.map(item => cardHTML(item)).join('');
  } else {
    upcomingSection.hidden = true;
    upcomingGrid.innerHTML = '';
  }

  // Bind card events for both grids
  [grid, upcomingGrid].forEach(container => {
    container.querySelectorAll('.card').forEach(card => {
    const id = parseInt(card.dataset.id);
    const type = card.dataset.type;

    card.querySelector('.btn-remove')?.addEventListener('click', async e => {
      e.stopPropagation();
      await removeItem(type, id);
    });

    card.querySelector('.btn-watched')?.addEventListener('click', e => {
      e.stopPropagation();
      openRateModal(type, id);
    });

    card.querySelector('.btn-rewatch')?.addEventListener('click', async e => {
      e.stopPropagation();
      await unmarkWatched(type, id);
    });

    card.querySelector('.btn-edit-rating')?.addEventListener('click', e => {
      e.stopPropagation();
      openRateModal(type, id, true);
    });

    card.addEventListener('click', () => openDetailModal(type, id));
    });
  });
}

// ─── Card HTML ────────────────────────────────────────────────────────────────
function cardHTML(item) {
  const posterStyle = item.poster
    ? `background-image: url('${item.poster}')`
    : 'background: var(--surface2)';

  const today = new Date().toISOString().slice(0, 10);
  const isUpcoming = item.releaseDate && item.releaseDate > today;

  const watchedBadge = item.watched
    ? `<div class="watched-badge">
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
        Watched
       </div>`
    : isUpcoming
      ? `<div class="upcoming-badge">Coming Soon</div>`
      : '';

  const ratingBadge = item.rating
    ? `<div class="rating-badge">${'★'.repeat(item.rating)}${'☆'.repeat(5 - item.rating)}</div>`
    : '';

  const actions = item.watched
    ? `<div class="card-actions">
         <button class="btn-card btn-edit-rating">Edit Rating</button>
         <button class="btn-card btn-rewatch">Move to Watchlist</button>
         <button class="btn-card btn-remove btn-danger">Remove</button>
       </div>`
    : isUpcoming
      ? `<div class="card-actions">
           <button class="btn-card btn-remove btn-danger">Remove</button>
         </div>`
      : `<div class="card-actions">
           <button class="btn-card btn-watched btn-primary">Mark Watched</button>
           <button class="btn-card btn-remove btn-danger">Remove</button>
         </div>`;

  const genreTags = item.genres?.length
    ? `<div class="genre-tags">${item.genres.slice(0,3).map(g => `<span class="genre-tag">${g}</span>`).join('')}</div>`
    : '';

  return `
    <div class="card ${item.watched ? 'card-watched' : ''}" data-id="${item.tmdbId}" data-type="${item.type}">
      <div class="card-poster" style="${posterStyle}">
        ${watchedBadge}
        ${ratingBadge}
        ${!item.poster ? `<div class="poster-placeholder">${item.title}</div>` : ''}
        <div class="card-overlay">
          <p class="card-overview">${item.overview ? item.overview.slice(0, 140) + '…' : 'No synopsis available.'}</p>
          ${genreTags}
          ${actions}
        </div>
      </div>
      <div class="card-footer">
        <div class="card-title">${item.title}</div>
        <div class="card-year">${item.year}${item.runtime ? ` · ${item.runtime}m` : ''}${item.seasons ? ` · ${item.seasons}S` : ''}</div>
      </div>
    </div>
  `;
}

// ─── Search Modal ─────────────────────────────────────────────────────────────
export function openSearchModal() {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');

  body.innerHTML = `
    <div class="modal-search">
      <h2 class="modal-title">Add to Watchlist</h2>
      <div class="search-input-wrap">
        <input id="search-input" type="text" placeholder="Search for a ${state.mediaType === 'movie' ? 'movie' : 'TV show'}…" autocomplete="off" />
        <div class="search-spinner" id="search-spinner" hidden></div>
      </div>
      <div id="search-results" class="search-results"></div>
    </div>
  `;

  modal.hidden = false;
  document.getElementById('search-input').focus();

  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchDebounce);
    const q = e.target.value.trim();
    if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
    searchDebounce = setTimeout(() => runSearch(q), 350);
  });
}

async function runSearch(query) {
  const spinner = document.getElementById('search-spinner');
  const resultsEl = document.getElementById('search-results');
  if (!spinner || !resultsEl) return;

  spinner.hidden = false;
  try {
    const results = state.mediaType === 'movie'
      ? await searchMovies(query)
      : await searchTV(query);

    resultsEl.innerHTML = results.length
      ? results.map(r => searchResultHTML(r)).join('')
      : `<div class="search-empty">No results found.</div>`;

    resultsEl.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.id);
        const hit = results.find(r => r.tmdbId === id);
        if (hit) handleAdd(hit);
      });
    });
  } catch (err) {
    resultsEl.innerHTML = `<div class="search-empty">Search failed. Check your API key.</div>`;
  } finally {
    spinner.hidden = true;
  }
}

function searchResultHTML(r) {
  const thumbStyle = r.poster ? `background-image:url('${r.poster}')` : 'background:var(--surface2)';
  return `
    <div class="search-result" data-id="${r.tmdbId}">
      <div class="search-thumb" style="${thumbStyle}"></div>
      <div class="search-info">
        <div class="search-title">${r.title}</div>
        <div class="search-meta">${r.year}${r.tmdbRating ? ` · ${r.tmdbRating}%` : ''}</div>
        <div class="search-overview">${r.overview ? r.overview.slice(0, 100) + '…' : ''}</div>
      </div>
    </div>
  `;
}

async function handleAdd(item) {
  // Fetch full details so genres, tmdbRating, cast, etc. are all stored
  let enriched = item;
  try {
    enriched = state.mediaType === 'movie'
      ? await getMovieDetails(item.tmdbId)
      : await getTVDetails(item.tmdbId);
  } catch { /* fallback to basic item if fetch fails */ }
  const added = await addItem(state.mediaType, enriched);
  closeModal();
  if (!added) showToast(`"${item.title}" is already on your list.`);
  else showToast(`Added "${item.title}" to your watchlist.`);
}

// ─── Rate Modal ───────────────────────────────────────────────────────────────
function openRateModal(type, tmdbId, editing = false) {
  const items = getAll(type);
  const item = items.find(i => i.tmdbId === tmdbId);
  if (!item) return;

  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');

  body.innerHTML = `
    <div class="modal-rate">
      <div class="rate-poster" style="${item.poster ? `background-image:url('${item.poster}')` : 'background:var(--surface2)'}"></div>
      <div class="rate-content">
        <h2 class="modal-title">${editing ? 'Edit Rating' : 'Mark as Watched'}</h2>
        <p class="rate-subtitle">${item.title} · ${item.year}</p>
        <div class="star-picker" id="star-picker">
          ${[1,2,3,4,5].map(n => `<button class="star ${item.rating >= n ? 'filled' : ''}" data-val="${n}">★</button>`).join('')}
        </div>
        <p class="rate-hint">Tap to rate (optional)</p>
        <textarea id="rate-notes" placeholder="Any thoughts? (optional)" rows="3">${item.notes || ''}</textarea>
        <div class="rate-actions">
          <button id="btn-save-rating" class="btn-primary btn-large">
            ${editing ? 'Save Changes' : 'Mark as Watched'}
          </button>
          <button id="btn-cancel-rating" class="btn-ghost btn-large">Cancel</button>
        </div>
      </div>
    </div>
  `;

  modal.hidden = false;

  let selectedRating = item.rating || 0;

  const stars = body.querySelectorAll('.star');
  stars.forEach(star => {
    star.addEventListener('mouseenter', () => {
      const val = parseInt(star.dataset.val);
      stars.forEach(s => s.classList.toggle('hover', parseInt(s.dataset.val) <= val));
    });
    star.addEventListener('mouseleave', () => stars.forEach(s => s.classList.remove('hover')));
    star.addEventListener('click', () => {
      selectedRating = parseInt(star.dataset.val);
      stars.forEach(s => s.classList.toggle('filled', parseInt(s.dataset.val) <= selectedRating));
    });
  });

  body.querySelector('#btn-save-rating').addEventListener('click', async () => {
    const notes = body.querySelector('#rate-notes').value.trim();
    if (editing) await updateRating(type, tmdbId, selectedRating || null, notes);
    else await markWatched(type, tmdbId, selectedRating || null, notes);
    closeModal();
    if (!editing) showToast(`Marked "${item.title}" as watched.`);
  });

  body.querySelector('#btn-cancel-rating').addEventListener('click', closeModal);
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────
async function openDetailModal(type, tmdbId) {
  const modal = document.getElementById('modal');
  const body = document.getElementById('modal-body');

  body.innerHTML = `<div class="modal-loading"><div class="spinner"></div></div>`;
  modal.hidden = false;

  try {
    const details = type === 'movie'
      ? await getMovieDetails(tmdbId)
      : await getTVDetails(tmdbId);

    const stored = getAll(type).find(i => i.tmdbId === tmdbId);
    const bgStyle = details.backdrop
      ? `background-image: linear-gradient(to bottom, rgba(10,9,8,0.4), var(--bg)), url('${details.backdrop}')`
      : '';

    const actions = stored
      ? stored.watched
        ? `<div class="detail-actions">
             <span class="detail-on-list">✓ Watched${stored.rating ? ' · ' + '★'.repeat(stored.rating) : ''}</span>
             <button class="btn-card btn-edit-rating detail-action-btn" id="detail-btn-rate">Edit Rating</button>
           </div>`
        : `<div class="detail-actions">
             <span class="detail-on-list">On your watchlist</span>
             <button class="btn-primary detail-action-btn" id="detail-btn-watched">Mark as Watched</button>
           </div>`
      : `<div class="detail-actions">
           <button class="btn-primary detail-action-btn" id="detail-btn-add">+ Add to Watchlist</button>
         </div>`;

    body.innerHTML = `
      <div class="modal-detail">
        <div class="detail-backdrop" style="${bgStyle}"></div>
        <div class="detail-content">
          <div class="detail-poster" style="${details.poster ? `background-image:url('${details.poster}')` : 'background:var(--surface2)'}"></div>
          <div class="detail-info">
            <h2 class="detail-title">${details.title}</h2>
            <div class="detail-meta">
              ${details.year}
              ${details.runtime ? `· ${details.runtime}m` : ''}
              ${details.seasons ? `· ${details.seasons} season${details.seasons !== 1 ? 's' : ''}` : ''}
              ${details.tmdbRating ? `· <span class="tmdb-score">${details.tmdbRating}% on TMDB</span>` : ''}
            </div>
            ${details.director ? `<div class="detail-director">Directed by <strong>${details.director}</strong></div>` : ''}
            ${details.cast?.length ? `<div class="detail-cast">Starring ${details.cast.join(', ')}</div>` : ''}
            ${details.genres?.length ? `<div class="genre-tags">${details.genres.map(g => `<span class="genre-tag">${g}</span>`).join('')}</div>` : ''}
            <p class="detail-overview">${details.overview || ''}</p>
            ${stored?.notes ? `<blockquote class="detail-notes">"${stored.notes}"</blockquote>` : ''}
            ${actions}
          </div>
        </div>
      </div>
    `;

    // Wire up action buttons
    body.querySelector('#detail-btn-add')?.addEventListener('click', async () => {
      await addItem(type, details);
      closeModal();
      showToast(`Added "${details.title}" to your watchlist.`);
    });

    body.querySelector('#detail-btn-watched')?.addEventListener('click', () => {
      closeModal();
      openRateModal(type, tmdbId);
    });

    body.querySelector('#detail-btn-rate')?.addEventListener('click', () => {
      closeModal();
      openRateModal(type, tmdbId, true);
    });

  } catch {
    body.innerHTML = `<div class="modal-loading"><p>Couldn't load details.</p></div>`;
  }
}

// ─── Profile Modal ─────────────────────────────────────────────────────────────
export function openProfileModal() {
  const modal = document.getElementById('modal');
  const body  = document.getElementById('modal-body');
  if (!modal || !body) return;

  const allMovies = getAll('movie');
  const allTV     = getAll('tv');
  const allItems  = [...allMovies, ...allTV];
  const watched   = allItems.filter(i => i.watched);

  const loved = watched.filter(i => i.rating >= 4).sort((a, b) => b.rating - a.rating);
  const liked = watched.filter(i => i.rating === 3);

  // Genre affinity
  const genreScore = {};
  watched.forEach(i => {
    const weight = i.rating || 3;
    (i.genres || []).forEach(g => { genreScore[g] = (genreScore[g] || 0) + weight; });
  });
  const topGenres = Object.entries(genreScore)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([g]) => g);

  const currentNotes = getTasteNotes();

  const starLabel = r => '★'.repeat(r) + '☆'.repeat(5 - r);

  body.innerHTML = `
    <div class="profile-modal">
      <h2 class="profile-modal-title">Your Taste Profile</h2>
      <p class="profile-modal-subtitle">This is what Claude knows about you when making recommendations.</p>

      <section class="profile-section">
        <h3 class="profile-section-title">Loved <span class="profile-count">${loved.length}</span></h3>
        ${loved.length ? `<ul class="profile-list">
          ${loved.map(i => `<li><span class="profile-stars">${starLabel(i.rating)}</span><span class="profile-item-title">${i.title}</span><span class="profile-item-year">${i.year}</span></li>`).join('')}
        </ul>` : `<p class="profile-empty">Nothing rated 4–5 stars yet.</p>`}
      </section>

      <section class="profile-section">
        <h3 class="profile-section-title">Liked <span class="profile-count">${liked.length}</span></h3>
        ${liked.length ? `<ul class="profile-list">
          ${liked.map(i => `<li><span class="profile-stars">${starLabel(3)}</span><span class="profile-item-title">${i.title}</span><span class="profile-item-year">${i.year}</span></li>`).join('')}
        </ul>` : `<p class="profile-empty">Nothing rated 3 stars yet.</p>`}
      </section>

      <section class="profile-section">
        <h3 class="profile-section-title">Top Genres</h3>
        ${topGenres.length ? `<div class="profile-genres">
          ${topGenres.map(g => `<span class="profile-genre-pill">${g}</span>`).join('')}
        </div>` : `<p class="profile-empty">Watch and rate more to build genre affinity.</p>`}
      </section>

      <section class="profile-section profile-notes-section">
        <h3 class="profile-section-title">Your Taste Notes</h3>
        <p class="profile-notes-hint">Tell Claude things your ratings can't — what you hate, love, or nuances that matter. Sent directly with every recommendation request.</p>
        <textarea id="profile-notes-input" class="profile-notes-input" placeholder="e.g. I generally avoid gory slasher films but enjoy occasional Lovecraftian horror. Deborah won't watch anything with jump scares…">${currentNotes}</textarea>
        <div class="profile-notes-actions">
          <button class="btn-ghost btn-large" onclick="app.closeModal()">Cancel</button>
          <button class="btn-primary btn-large" id="profile-save-btn">Save Notes</button>
        </div>
      </section>
    </div>
  `;

  document.getElementById('profile-save-btn').addEventListener('click', async () => {
    const btn   = document.getElementById('profile-save-btn');
    const notes = document.getElementById('profile-notes-input').value;
    btn.disabled    = true;
    btn.textContent = 'Saving…';
    await saveTasteNotes(notes);
    btn.textContent = 'Saved ✓';
    setTimeout(() => closeModal(), 800);
  });

  modal.hidden = false;
}

// ─── Modal / Toast ─────────────────────────────────────────────────────────────
export function closeModal() {
  document.getElementById('modal').hidden = true;
  document.getElementById('modal-body').innerHTML = '';
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2800);
}

// ─── Nav events (bound in index.html) ─────────────────────────────────────────
export function setMediaType(type) {
  state.mediaType = type;
  state.genreFilter = null;
  render();
}

export function setFilter(f) {
  state.filter = f;
  state.genreFilter = null;
  renderFilters();
  renderGrid();
}

export function setSort(value) {
  state.sort = value;
  renderGrid();
}

export function setGenre(genre) {
  state.genreFilter = genre;
  renderGenreBar();
  renderGrid();
}
