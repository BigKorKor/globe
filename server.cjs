// Tiny local server for the "ask the globe" demo.
// Serves the static globe page and proxies /api/ask to Claude so the
// Anthropic API key stays server-side (never sent to the browser).
//
// Usage:
//   1. put ANTHROPIC_API_KEY=sk-ant-... in globe/.env  (see .env.example)
//   2. node server.cjs (or npm run server)
//
// No npm install needed — uses only Node's built-in http/fs/path and global fetch (Node 18+).

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
loadEnvFile(path.join(ROOT, '.env'));

const PORT = process.env.PORT || 8765;
/* AI/LLM config — disabled while "Ask the globe" is archived (ASK_ENABLED=false). Uncomment with askClaude + /api/ask below to restore.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Supports pointing at an internal Anthropic-compatible gateway (e.g. PayPal's
// AI Platform) instead of api.anthropic.com. Accepts the base with or without
// a trailing /v1, matching how the official Anthropic SDK treats this var.
const RAW_BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const API_BASE = RAW_BASE_URL.endsWith('/v1') ? RAW_BASE_URL : `${RAW_BASE_URL}/v1`;

// api.anthropic.com speaks the native Messages API (x-api-key, /v1/messages,
// tool_use blocks). PayPal's gateway (and most enterprise LLM gateways) speak
// the OpenAI-compatible dialect instead (Bearer auth, /chat/completions,
// tool_calls) — confirmed by probing it directly. Any custom ANTHROPIC_BASE_URL
// is assumed to be the OpenAI-compatible kind.
const USE_OPENAI_DIALECT = !!process.env.ANTHROPIC_BASE_URL;
*/

// Minimal .env loader (KEY=value per line, '#' comments, no quoting/escapes needed
// for an API key) so we don't need the `dotenv` package as a dependency.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
// Carpark-availability card (Singapore live panel): LTA DataMall's
// CarParkAvailabilityv2 was chosen over a keyless join against the static HDB
// Carpark Information dataset — that dataset has no coordinates for carparks
// near Suntec (mostly private carparks, not HDB), and the join would need an
// SVY21->WGS84 conversion for no real benefit. LTA's feed returns lat/lng
// directly per carpark and has solid CBD coverage, at the cost of needing a
// free AccountKey (https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html) —
// which is why this is a server-side proxy rather than a direct client fetch:
// the key lives only in .env / process.env, never in client code. If unset,
// the endpoint just reports "unavailable" and the client shows "-".
const LTA_ACCOUNT_KEY = process.env.LTA_ACCOUNT_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const PAYPAL_SG_OFFICE = { lat: 1.2949, lng: 103.8578 }; // Suntec Tower — mirrors src/data.js

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

const CAR_PARK_API_URL = 'https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2';
// The feed returns 500 rows per call, ~2600 total across Singapore — paginate
// with $skip until a page comes back short (or this cap, as a backstop) so
// carparks past the first page (CBD included) aren't missed.
const CAR_PARK_PAGE_SIZE = 500;
const CAR_PARK_MAX_PAGES = 8;

async function fetchAllCarParks() {
  let all = [];
  for (let page = 0; page < CAR_PARK_MAX_PAGES; page++) {
    const resp = await fetch(`${CAR_PARK_API_URL}?$skip=${page * CAR_PARK_PAGE_SIZE}`, {
      headers: { AccountKey: LTA_ACCOUNT_KEY, accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`LTA CarParkAvailabilityv2 HTTP ${resp.status}`);
    const data = await resp.json();
    const items = data.value || [];
    all = all.concat(items);
    if (items.length < CAR_PARK_PAGE_SIZE) break;
  }
  return all;
}

async function fetchNearestCarpark() {
  const items = await fetchAllCarParks();
  let best = null;
  let bestDist = Infinity;
  for (const cp of items) {
    // Multiple rows can share a CarParkID, one per LotType (car/motorcycle/
    // heavy-vehicle/season) — restrict to car ("C") lots so a nearer
    // motorcycle-only row never wins over the actual car carpark next door.
    if (cp.LotType !== 'C') continue;
    const [cLat, cLng] = String(cp.Location || '').split(' ').map(Number);
    if (!Number.isFinite(cLat) || !Number.isFinite(cLng)) continue;
    const d = haversineKm(PAYPAL_SG_OFFICE.lat, PAYPAL_SG_OFFICE.lng, cLat, cLng);
    if (d < bestDist) {
      bestDist = d;
      best = cp;
    }
  }
  if (!best) return null;
  return {
    name: best.Development,
    lotsAvailable: Number(best.AvailableLots),
    distanceKm: bestDist,
  };
}

// Aircraft-overhead card: OpenSky's anonymous REST API does not send
// Access-Control-Allow-Origin, so a direct browser fetch fails as an opaque
// CORS error (not a 429) before the response body is even readable — that
// was the actual root cause of the card showing "-". Proxied server-side
// instead, same as carpark-nearest above; no key involved, this tier is just
// unauthenticated-and-rate-limited, which is why 429 is handled explicitly.
const SG_BBOX = { lamin: 1.15, lomin: 103.55, lamax: 1.48, lomax: 104.15 };

async function fetchAircraftOverhead() {
  const url = `https://opensky-network.org/api/states/all?lamin=${SG_BBOX.lamin}&lomin=${SG_BBOX.lomin}&lamax=${SG_BBOX.lamax}&lomax=${SG_BBOX.lomax}`;
  const resp = await fetch(url);
  if (resp.status === 429) {
    const err = new Error('OpenSky anonymous rate limit hit (429)');
    err.rateLimited = true;
    throw err;
  }
  if (!resp.ok) throw new Error(`OpenSky HTTP ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data.states) ? data.states.length : 0;
}

// Real-satellite layer (attract/globe view): CelesTrak's TLE endpoints have
// no CORS headers, so the browser can't fetch them directly — proxied here,
// same "keyless, server-side" pattern as aircraft-overhead/carpark above.
// Orbital elements are only ever republished a handful of times a day, so
// each group/satellite is cached to disk and refetched at most once every
// 24h rather than once per page load.
//
// GROUP=active is CelesTrak's entire ~10,000-satellite active-catalog feed —
// far more than this app's curated ~20-satellite list needs, and CelesTrak
// throttles repeat downloads of that specific bulk feed per-IP to once every
// 2 hours ("GP data has not updated since your last successful download...")
// independent of and in addition to our own 24h disk cache, so a handful of
// requests during development can leave GROUP=active 403ing for hours. Named
// satellites are fetched individually by NORAD id (CATNR=) instead, which is
// a much smaller/cheaper query CelesTrak does not appear to throttle the
// same way. Only the (currently disabled, see STARLINK_ENABLED) ambient
// Starlink swarm still needs a real bulk group, since it samples a couple
// hundred satellites at once by design rather than a fixed curated list.
const TLE_GROUPS = new Set(['starlink']);
const TLE_CACHE_DIR = path.join(ROOT, '.cache');
const TLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refresh at most once/day

function tleCachePath(key) {
  return path.join(TLE_CACHE_DIR, `tle-${key}.json`);
}

async function fetchTLECached(cacheKey, celestrakQuery) {
  const cachePath = tleCachePath(cacheKey);
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Date.now() - cached.fetchedAt < TLE_CACHE_TTL_MS) return cached.text;
  } catch { /* no cache yet, or unreadable — fetch fresh below */ }

  const resp = await fetch(`https://celestrak.org/NORAD/elements/gp.php?${celestrakQuery}&FORMAT=tle`);
  if (!resp.ok) throw new Error(`CelesTrak HTTP ${resp.status} for ${celestrakQuery}`);
  const text = await resp.text();
  fs.mkdirSync(TLE_CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), text }));
  return text;
}

function fetchTLEGroup(group) {
  return fetchTLECached(`group-${group}`, `GROUP=${group}`);
}

function fetchTLEById(noradId) {
  return fetchTLECached(`sat-${noradId}`, `CATNR=${noradId}`);
}

// Street View "journey" precompute (scripts/buildJourney.cjs, run once by a
// developer, not called at app runtime): Directions API and the Street View
// Static API's metadata endpoint are plain server-callable REST APIs with no
// CORS headers, so they're proxied here the same way as every other keyed
// third-party call in this file — the key stays server-side, the build
// script just talks to these two routes over localhost.
async function fetchDirections(origin, destination, mode) {
  if (!GOOGLE_MAPS_API_KEY) throw Object.assign(new Error('GOOGLE_MAPS_API_KEY not set'), { status: 500 });
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=${encodeURIComponent(mode)}&key=${GOOGLE_MAPS_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw Object.assign(new Error(`Directions API HTTP ${resp.status}`), { status: 502 });
  const data = await resp.json();
  if (data.status !== 'OK') throw Object.assign(new Error(`Directions API status ${data.status}: ${data.error_message || ''}`), { status: 502 });
  return data;
}

async function fetchStreetViewMetadata(location, radius) {
  if (!GOOGLE_MAPS_API_KEY) throw Object.assign(new Error('GOOGLE_MAPS_API_KEY not set'), { status: 500 });
  const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${encodeURIComponent(location)}&radius=${encodeURIComponent(radius)}&source=outdoor&key=${GOOGLE_MAPS_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw Object.assign(new Error(`Street View metadata HTTP ${resp.status}`), { status: 502 });
  return resp.json(); // { status, pano_id, location: {lat,lng}, ... } — ZERO_RESULTS is a normal "no coverage here" answer, not an error
}

const corridors = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'corridors.json'), 'utf8'));
const milestones = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'milestones.json'), 'utf8'));
const riskFraudStory = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'risk_fraud_story.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // .mjs must be served as a JS MIME type — browsers refuse to execute a
  // dynamically `import()`ed module (e.g. the vendored MediaPipe module,
  // see handLandmarkerWorker.js) whose response Content-Type isn't a
  // recognized JavaScript type, even when the request itself succeeds.
  '.mjs': 'text/javascript; charset=utf-8',
  // .wasm needs its own MIME type so the browser can use
  // WebAssembly.instantiateStreaming (compiles while downloading) instead of
  // silently falling back to the slower buffer-then-compile path.
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  // Missing before 2026-10: the SG office video/music and narration clips
  // were all falling back to application/octet-stream. Browsers can often
  // still sniff-and-play media served with the wrong type, but it's not
  // correct, and matches the MIME types Vercel's own static hosting serves
  // these as.
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary',
  '.task': 'application/octet-stream', // MediaPipe model blob — fetched as an ArrayBuffer, not played/executed, so the exact type doesn't matter beyond "not text"
};

/* AI/LLM helpers — disabled while "Ask the globe" is archived.
const HIGHLIGHT_TOOL_DESC ='Answer the spoken question about the corridor dataset and specify which corridor id(s) on the globe should be highlighted.';
const HIGHLIGHT_PARAMS = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: 'Short, conversational answer (1-3 sentences) suitable for reading aloud.',
    },
    highlightIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'Corridor ids (from the dataset) this answer is about, most relevant first. Empty array if the question does not match any corridor.',
    },
  },
  required: ['answer', 'highlightIds'],
};

function buildSystemPrompt() {
  return 'You answer spoken questions about a small illustrative dataset of trade/migration corridors and ' +
    'company milestones, shown on a 3D globe. All figures are fabricated demo data, not real statistics — ' +
    'never claim otherwise. Each corridor has a "sinceYear" it went live, and three metric modes, each an ' +
    'object with "value" and "yoyGrowthPct": "money" (money flow volume, $bn), "fraud" (fraud stopped, $M), ' +
    'and "compliance" (compliance checks, thousands/day). Use whichever mode(s) are relevant to the question; ' +
    'if the question does not name a mode, consider all three. Answer only using the data below. Keep the ' +
    'answer short and conversational, as if spoken aloud. Always call the highlight_corridors tool, populating ' +
    'highlightIds with the corridor id(s) (not milestone ids) your answer refers to — leave it empty if the ' +
    'question is only about a milestone.\n\n' +
    'Corridors:\n' + JSON.stringify(corridors) + '\n\nMilestones:\n' + JSON.stringify(milestones);
}

async function askClaude(question) {
  if (!API_KEY) {
    const err = new Error('Server has no ANTHROPIC_API_KEY set. Put it in globe/.env then restart the server');
    err.status = 500;
    throw err;
  }

  return USE_OPENAI_DIALECT ? askOpenAIDialect(question) : askAnthropicNative(question);
}

async function askAnthropicNative(question) {
  const resp = await fetch(`${API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: question }],
      tools: [{ name: 'highlight_corridors', description: HIGHLIGHT_TOOL_DESC, input_schema: HIGHLIGHT_PARAMS }],
      tool_choice: { type: 'tool', name: 'highlight_corridors' },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`LLM API error ${resp.status}: ${text.slice(0, 400)}`);
    err.status = 502;
    throw err;
  }

  const data = await resp.json();
  const toolUse = (data.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) {
    const err = new Error('Model response did not include structured output.');
    err.status = 502;
    throw err;
  }
  return toolUse.input; // { answer, highlightIds }
}

async function askOpenAIDialect(question) {
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: question },
      ],
      tools: [{ type: 'function', function: { name: 'highlight_corridors', description: HIGHLIGHT_TOOL_DESC, parameters: HIGHLIGHT_PARAMS } }],
      tool_choice: { type: 'function', function: { name: 'highlight_corridors' } },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`LLM API error ${resp.status}: ${text.slice(0, 400)}`);
    err.status = 502;
    throw err;
  }

  const data = await resp.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    const err = new Error('Model response did not include structured output.');
    err.status = 502;
    throw err;
  }
  return JSON.parse(toolCall.function.arguments); // { answer, highlightIds }
}
*/

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ googleMapsApiKey: GOOGLE_MAPS_API_KEY || '' }));
    return;
  }

  if (req.method === 'GET' && url === '/api/corridors') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(corridors));
    return;
  }

  if (req.method === 'GET' && url === '/api/milestones') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(milestones));
    return;
  }

  if (req.method === 'GET' && url === '/api/aircraft-overhead') {
    fetchAircraftOverhead()
      .then((count) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, count }));
      })
      .catch((err) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, rateLimited: !!err.rateLimited, reason: err.message }));
      });
    return;
  }

  if (req.method === 'GET' && url === '/api/carpark-nearest') {
    if (!LTA_ACCOUNT_KEY) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: false, reason: 'LTA_ACCOUNT_KEY not set' }));
      return;
    }
    fetchNearestCarpark()
      .then((carpark) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: !!carpark, carpark }));
      })
      .catch((err) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: false, reason: err.message }));
      });
    return;
  }

  if (req.method === 'GET' && url === '/api/tle') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const group = params.get('group');
    const id = params.get('id');
    let fetchPromise;
    if (id) {
      if (!/^\d+$/.test(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid NORAD id "${id}"` }));
        return;
      }
      fetchPromise = fetchTLEById(id);
    } else if (TLE_GROUPS.has(group)) {
      fetchPromise = fetchTLEGroup(group);
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Provide ?id=<noradId> or ?group=<one of: ${[...TLE_GROUPS].join(', ')}>` }));
      return;
    }
    fetchPromise
      .then((text) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(text);
      })
      .catch((err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  if (req.method === 'GET' && url === '/api/story') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(riskFraudStory));
    return;
  }

  // Dev-time only (see scripts/buildJourney.cjs) — not called by the client.
  if (req.method === 'GET' && url === '/api/directions') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const origin = params.get('origin');
    const destination = params.get('destination');
    const mode = params.get('mode') || 'driving';
    if (!origin || !destination) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Provide ?origin=lat,lng&destination=lat,lng' }));
      return;
    }
    fetchDirections(origin, destination, mode)
      .then((data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  // Dev-time only (see scripts/buildJourney.cjs) — not called by the client.
  if (req.method === 'GET' && url === '/api/streetview-metadata') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const location = params.get('location');
    const radius = params.get('radius') || '50';
    if (!location) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Provide ?location=lat,lng' }));
      return;
    }
    fetchStreetViewMetadata(location, radius)
      .then((data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      })
      .catch((err) => {
        res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  /* /api/ask — disabled while "Ask the globe" is archived.
  if (req.method === 'POST' && url === '/api/ask') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { question } = JSON.parse(body || '{}');
        if (!question || !question.trim()) throw Object.assign(new Error('Missing question'), { status: 400 });
        const result = await askClaude(question.trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  */

  // Static file serving: the frontend is now a Vite/React app. In dev, run
  // `npm run dev` (Vite's own server, proxying /api/* here) instead of
  // hitting this server directly for the page. This block only serves the
  // production build (`npm run build` -> dist/) so `node server.cjs` alone
  // is enough once you've built. Guard against path traversal outside DIST.
  const DIST = path.join(ROOT, 'dist');
  let filePath = path.normalize(path.join(DIST, url === '/' ? 'index.html' : url));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  // FIX (2026-10, SG office video hang): this used to always fs.readFile the
  // whole file and respond 200, with no Accept-Ranges header at all. A
  // <video>/<audio> element that wants to seek sends a `Range: bytes=...`
  // request first — without 206 + Accept-Ranges in response, Chrome has no
  // way to know seeking is supported, and a seek silently snaps playback
  // back toward 0 instead of actually moving. That's exactly what made the
  // SG office view hang on a mid-clip seek (since fixed to not seek at all
  // — see sgOfficeScript.js/SgOfficeJourneyVideo.jsx — but this gap would
  // have bitten any other range-seeking media/large-asset request too, and
  // matches how Vercel's own static hosting already behaves).
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const contentType = MIME[path.extname(filePath)] || 'application/octet-stream';
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (!match || Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Globe server running at http://localhost:${PORT}`);
  // console.log(`LLM endpoint: ${API_BASE}/${USE_OPENAI_DIALECT ? 'chat/completions' : 'messages'} (model: ${MODEL}, dialect: ${USE_OPENAI_DIALECT ? 'OpenAI-compatible' : 'Anthropic native'})`);
  // if (!API_KEY) {
  //   console.warn('WARNING: ANTHROPIC_API_KEY is not set — /api/ask will return an error until you set it and restart.');
  // }
});
