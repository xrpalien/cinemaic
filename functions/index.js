const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const { setGlobalOptions }   = require('firebase-functions/v2');
const logger                 = require('firebase-functions/logger');
const Anthropic              = require('@anthropic-ai/sdk');

setGlobalOptions({ maxInstances: 10 });

const tmdbKey   = defineSecret('TMDB_KEY');
const claudeKey = defineSecret('CLAUDE_KEY');

/**
 * TMDB proxy — keeps the API key server-side.
 * Called from the frontend via Firebase httpsCallable.
 * Requires the user to be authenticated.
 */
exports.tmdb = onCall({ secrets: [tmdbKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }

  const { path, params = {} } = request.data;

  if (!path || typeof path !== 'string' || !path.startsWith('/')) {
    throw new HttpsError('invalid-argument', 'Invalid TMDB path.');
  }

  const key = process.env.TMDB_KEY;
  if (!key) {
    logger.error('TMDB_KEY secret not available');
    throw new HttpsError('internal', 'API key not configured.');
  }

  try {
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    url.searchParams.set('api_key', key);
    url.searchParams.set('language', 'en-US');
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url);
    if (!res.ok) {
      logger.error(`TMDB upstream error: ${res.status} for ${path}`);
      throw new HttpsError('internal', `TMDB error: ${res.status}`);
    }

    return res.json();
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error('Unexpected error in tmdb function', err);
    throw new HttpsError('internal', 'Unexpected error.');
  }
});

/**
 * AI recommendation advisor — calls Claude with the user's taste profile + prompt.
 * Returns an array of { title, type, reason } objects.
 */
exports.askAI = onCall({ secrets: [claudeKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }

  const { tasteProfile, prompt, mediaType } = request.data;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'Prompt is required.');
  }

  const key = process.env.CLAUDE_KEY;
  if (!key) {
    logger.error('CLAUDE_KEY secret not available');
    throw new HttpsError('internal', 'AI not configured.');
  }

  const client = new Anthropic({ apiKey: key });

  const mediaLabel = mediaType === 'tv' ? 'TV shows' : 'movies';

  const systemPrompt = `You are cinemAIc's personal film and TV advisor. You can answer any question about movies and TV — recommendations, release dates, cast, plot summaries, box office, awards, history, or anything else.

USER TASTE PROFILE (use as context when making recommendations):
${JSON.stringify(tasteProfile, null, 2)}

Always respond with a single valid JSON object in one of these two shapes:

1. For recommendations or lists of titles (e.g. "suggest something tense", "top films starring X", "what should I watch next"):
{"type":"recommendations","items":[{"title":"exact TMDB title","type":"${mediaType}","reason":"1–2 sentences connecting to profile and prompt"}]}
Return 5–8 items.

2. For factual, general, or conversational questions (e.g. "when does X release?", "what is X about?", "who directed X?", "how much did X gross?"):
{"type":"answer","heading":"short label for the question","text":"your answer in plain prose, no markdown"}

RULES:
- No markdown, no text outside the JSON object
- For title lists, "title" must be the exact name as it appears on TMDB
- For recommendations, connect picks to the user's profile AND their current prompt
- When unsure whether to use recommendations or answer, prefer answer`;

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt.trim() }],
      system: systemPrompt,
    });

    const raw = message.content[0]?.text || '{}';

    // Extract the outermost JSON object from the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      logger.error('Claude response did not contain a JSON object', { raw });
      throw new HttpsError('internal', 'Unexpected AI response format.');
    }

    const parsed = JSON.parse(match[0]);

    if (parsed.type === 'recommendations') {
      return { type: 'recommendations', items: parsed.items || [] };
    } else if (parsed.type === 'answer') {
      return { type: 'answer', heading: parsed.heading || '', text: parsed.text || '' };
    } else {
      logger.error('Claude returned unknown response type', { parsed });
      throw new HttpsError('internal', 'Unexpected AI response type.');
    }

  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error('Unexpected error in askAI function', err);
    throw new HttpsError('internal', 'AI request failed.');
  }
});
