# cinemAIc — Dev Log & Roadmap

## What It Is

A personal movie and TV tracker with AI-powered recommendations. Built with vanilla JS (no framework, no build step), Firebase, and the Anthropic Claude API. The name is the concept: cinema meets AI curation.

**Live:** https://cinemaic.web.app

---

## Stack

| Layer | Technology |
|-------|-----------|
| Hosting | Firebase Hosting (CDN) |
| Database | Firestore (NoSQL, real-time sync) |
| Auth | Firebase Auth — Google Sign-In |
| Backend functions | Firebase Functions v2 (Node 22, serverless) |
| AI advisor | Anthropic Claude Haiku 4.5 via Firebase Function |
| Movie data | TMDB API via Firebase Function proxy |
| Secrets | Google Secret Manager (`TMDB_KEY`, `CLAUDE_KEY`) |
| Frontend | Vanilla ES Modules — no bundler, no framework |
| Fonts | Bebas Neue (display) + DM Sans (body) via Google Fonts |

---

## Architecture Notes

### Secret management
API keys never touch the browser. Both `TMDB_KEY` and `CLAUDE_KEY` live in Google Secret Manager and are only accessible inside Firebase Functions. The Firebase client config (in `js/firebase.js`) is intentionally public — Firestore security rules are the actual security boundary.

### Data flow
```
Browser → Firebase Auth → Firestore (user data)
Browser → Firebase Function (tmdb) → TMDB API
Browser → Firebase Function (askAI) → Claude API
```

### Firestore schema
```
users/{uid}/movie/{tmdbId}   — movie items
users/{uid}/tv/{tmdbId}      — TV show items
```

Each item document:
```json
{
  "tmdbId": 12345,
  "type": "movie",
  "title": "The Creator",
  "year": "2023",
  "releaseDate": "2023-09-29",
  "poster": "https://image.tmdb.org/...",
  "backdrop": "https://image.tmdb.org/...",
  "overview": "...",
  "genres": ["Science Fiction", "Action", "Drama"],
  "genreIds": [878, 28, 18],
  "tmdbRating": 71,
  "cast": ["John David Washington", "..."],
  "director": "Gareth Edwards",
  "runtime": 133,
  "watched": false,
  "rating": null,
  "notes": "",
  "addedAt": 1708123456789,
  "watchedAt": null
}
```

### In-memory cache pattern
`store.js` maintains a synchronous in-memory cache (`cache = { movie: [], tv: [] }`) backed by Firestore `onSnapshot` listeners. All reads are synchronous from cache; all writes are async to Firestore. This means render functions never need to be async.

---

## Session History

### Session 1 — Foundation (localStorage era)
- Built the core app: To Watch / Watched / Explore tabs
- TMDB search and add flow
- "Because you liked X" recommendation rows
- Theater aesthetic: dark gold palette, Bebas Neue, card grid

### Session 2 — Firebase migration
- Migrated from localStorage to Firestore
- Added Google Sign-In with avatar + dropdown sign-out
- Created Firebase Function TMDB proxy (keys off the browser)
- Deployed to Firebase Hosting
- Fixed several auth/display bugs (CSS `hidden` override, secret trailing newline)
- Added responsive layout: tablet + phone breakpoints, two-row mobile header
- Added context-aware action buttons on detail modal

### Session 3 — Sort, Filter & AI (current session)
- **Sort order**: A–Z / Year / TMDB Rating (highest first, unrated to bottom, stable ties)
- **Genre filter bar**: horizontal scrolling chips, resets on tab/media switch
- **Data backfill system**: on login, silently fetches missing `tmdbRating`, `genres`, `genreIds`, and `releaseDate` for all existing items
- **Full detail fetch on add**: items added from search now always fetch full movie details first, so genres/ratings are complete from day one
- **Upcoming Releases section**: items with a future `releaseDate` are segregated below a divider; "Coming Soon" badge on card; no "Mark Watched" button
- **cinemAIc Advisor**: Claude Haiku-powered chat in the Explore tab — builds a taste profile from the user's rated/watched history, sends it as context with the user's natural-language prompt, resolves responses against TMDB for real posters, displays reason text per card
- **Recommendation quality filter**: "Because you liked X" rows now filter by genre overlap (must share at least one genre ID with source) and a 55% TMDB score floor — eliminates tonally mismatched noise

---

## Taste Profile (sent to Claude)

Built in `js/ai.js` from Firestore data:

```json
{
  "loved": [{ "title": "Interstellar", "year": "2014", "genres": ["Sci-Fi"], "stars": 5, "notes": "..." }],
  "liked": [{ "title": "Ex Machina", "genres": ["Sci-Fi", "Thriller"] }],
  "watchedUnrated": ["Arrival", "Moon"],
  "watchlist": ["Project Hail Mary", "Dune: Part Two"],
  "topGenres": ["Science Fiction", "Drama", "Thriller", "Action"]
}
```

---

## Possible Future Features

### High priority / low complexity
- **Where to watch** — TMDB's `/watch/providers` endpoint returns streaming availability (Netflix, Apple TV+, etc.) per region. Add a streaming badge to cards and detail modal.
- **PWA / installable** — Add a `manifest.json` and service worker so the app installs to the home screen on iOS/Android. Currently it's a great mobile web app but not installable.
- **Watched date display** — Show when something was watched on the card footer or detail view. Data is already stored (`watchedAt` timestamp).

### Medium priority / moderate complexity
- **Multi-profile support** — Sid and Deborah as named profiles under the same Google account, each with their own watchlist/watched history. Schema: `users/{uid}/profiles/{profileId}/movie/{tmdbId}`.
- **Shared "Our List"** — A joint watchlist accessible to both profiles. Could use a shared Firestore collection with both UIDs as owners.
- **Stats / insights page** — Genres breakdown pie chart, average ratings, total watch time (from `runtime` data), most-watched directors. All computable from existing Firestore data.
- **Collections** — Group items into themed lists (e.g. "Road trip movies", "Date night"). Schema: `users/{uid}/collections/{collectionId}`.

### Longer term / more complex
- **News/updates feed** — Surface upcoming seasons, sequel announcements, and premiere dates for titles on your watchlist. Could poll TMDB's "upcoming" and "now playing" endpoints and match against your list.
- **AI conversation history** — Allow the advisor to remember previous prompts in a session ("show me more like the second one") using a short message history array.
- **Vibe score** — After Claude returns recommendations, score each against the taste profile and display a match percentage badge on each AI result card.
- **Push notifications** — "Project Hail Mary releases in 3 days" — requires a service worker and a scheduled Firebase Function to check upcoming release dates nightly.
- **Social sharing** — Share a watchlist or a "my top 10" card as a public URL or image. Read-only public view of a curated list.

---

## Local Dev Notes

```bash
# Serve locally (no auth emulation — use the live Firebase project)
# Just open index.html via a local server or Firebase hosting preview

# Deploy everything
firebase deploy

# Deploy hosting only (JS/CSS changes)
firebase deploy --only hosting

# Deploy functions only
firebase deploy --only functions

# Set a secret (use printf, NOT echo — avoids trailing newline)
printf 'your-key-here' | firebase functions:secrets:set SECRET_NAME

# View function logs
firebase functions:log --only askAI
firebase functions:log --only tmdb
```

---

## Key Files

```
cinemaic/
├── index.html              # App shell, sign-in screen, modal
├── css/style.css           # All styles — theater dark theme
├── js/
│   ├── app.js              # Main render loop, state, UI logic
│   ├── store.js            # Firestore cache + write operations
│   ├── tmdb.js             # TMDB API client (via Firebase Function)
│   ├── firebase.js         # Firebase init, auth helpers
│   └── ai.js               # Taste profile builder, askAI callable
├── functions/
│   └── index.js            # Firebase Functions: tmdb proxy + askAI
├── firestore.rules         # Security: users can only access own data
└── firebase.json           # Hosting + function config
```
