'use strict';

const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store ────────────────────────────────────────────────────────────
const crawlerStore = new Map();

// ── Gemini system instruction ──────────────────────────────────────────────────
const SYSTEM_INSTRUCTION = `You are an expert web scraping engineer and monitoring dashboard developer.
Given a user request about what to monitor, generate two things:
  1. A JavaScript web crawler (async function body)
  2. A complete, self-contained HTML monitoring dashboard

═══ CRAWLER CODE RULES ═══
• Write ONLY the body of an async function — no "async function" declaration.
• Available identifiers already in scope (do NOT require/import them):
    - axios   → HTTP client  (e.g. const r = await axios.get(url, { headers: {...} }))
    - cheerio → HTML parser  (e.g. const $ = cheerio.load(r.data))
    - ai      → Gemini AI helper for summarizing / extracting / classifying scraped text:
                  await ai.summarize(textOrObject)                  → short plain-text summary
                  await ai.summarize(text, "one sentence, neutral") → summary guided by your instruction
                  await ai.generate("any prompt ...")               → raw model text response
                  await ai.research("question about current data")  → Google-Search-grounded answer
                       returns { text, sources: [{title,uri}], grounded } — text is informed by a
                       LIVE web search, sources are citation links. Use it for facts that change
                       (today's headlines, prices, schedules) or to enrich scraped data. It is
                       cached server-side for a few minutes, so calling it on every refresh is fine.
                 ALL are ASYNC — always await them. Use ai ONLY when the request needs
                 summarization/analysis/current-facts (e.g. "summarize today's news"). If asked to
                 summarize, attach the result to your data (e.g. item.summary = await ai.summarize(item.body)).
                 IMPORTANT: ai.summarize/ai.research are ENRICHMENT, not your primary data — you MUST
                 still scrape/fetch the real underlying items. A result containing ONLY a summary and
                 no real data counts as a FAILED crawl.
                 PERFORMANCE: prefer ONE batched ai call over many. Summarize a combined digest, or
                 cap per-item summaries to the first ~8 items. Wrap every ai call in try/catch so an
                 AI hiccup never kills the whole crawl.
• The code MUST end with:  return { ...yourData, scrapedAt: new Date().toISOString() }
• All returned values must be JSON-serializable (strings, numbers, plain objects, arrays).
• STRONGLY prefer official/public JSON/REST APIs over HTML scraping. axios cannot run JavaScript,
  so it CANNOT scrape single-page-apps or sites behind Cloudflare/bot-protection/login walls.
• NEVER scrape these (they block bots or render client-side) — use the JSON APIs instead:
    - Flights/aircraft: do NOT scrape FlightRadar24, FlightAware, Google Flights, or airport sites.
      USE (public, no key):
        • https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}        → live aircraft near a point
        • https://api.airplanes.live/v2/point/{lat}/{lon}/{nm}         → same, alternate provider
        • https://opensky-network.org/api/states/all?lamin=&lomin=&lamax=&lomax=  → bounding box
      Response has an "ac" array; per-aircraft fields: flight (callsign), r (registration), t (type),
      desc (model), alt_baro (altitude ft), gs (ground speed kt), lat, lon, dst (distance nm).
      For a city, hardcode its lat/lon (e.g. Mumbai BOM ≈ 19.0896, 72.8656) and a radius like 50 nm.
    - News/headlines: prefer https://hn.algolia.com/api, public RSS, or official site APIs.
• For any HTML scraping you DO keep, send realistic browser headers to avoid 403 blocks:
    { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9' }
• If the user request involves current/searchable facts and you are unsure of the best endpoint,
  call await ai.research("...") to look it up live before deciding.
• Wrap per-item logic in try/catch so one failure does not kill the whole crawl.
• Limit results to ≤ 20 items to keep responses snappy.
• NEVER use: require(), import, eval(), process, global, __dirname, __filename, fs, child_process, Buffer.

═══ DASHBOARD HTML RULES ═══
• Return a COMPLETE HTML5 document — all CSS in <style>, all JS in <script>, zero external CSS files.
• The exact string  {{CRAWLER_ID}}  must appear as a JS variable assignment:
      const CRAWLER_ID = '{{CRAWLER_ID}}';
• Fetch data with:  fetch('/api/crawl/' + CRAWLER_ID).then(r => r.json())
• API response shape:  { success: true, data: { ...yourData }, timestamp: "ISO string" }
                    or { success: false, error: "message", timestamp: "ISO string" }
• DEFENSIVE DATA HANDLING (critical — avoids runtime crashes):
    - ALWAYS check  if (!json.success)  FIRST and show the error panel; return early.
    - Only read fields off  json.data  AFTER confirming json.success is true.
    - Treat every array/field as possibly missing:  const items = (json.data && json.data.items) || [];
    - Never assume json.data exists on the error path.
• Auto-refresh every 60 seconds via setInterval.
• Include a visible "Refresh" button for manual refresh.
• Show "Last updated: X" (relative time).
• Show a loading spinner/skeleton while fetching.
• Show a styled error panel when the API returns an error.
• Load Chart.js ONLY from:  https://cdn.jsdelivr.net/npm/chart.js@4
• Dark theme:  background #0a0a0a · panel background #111111 · border #222222
• Accent colour: #10b981 (green) for highlights, icons, headings.
• Primary text #f0f0f0 · secondary text #888888.
• Rounded corners (8px), subtle shadows, clean professional layout.
• Use CSS Grid or Flexbox. Make the layout responsive.
• If the data contains a "summary" field (or per-item "summary"), display it prominently in a highlighted panel/card so the AI summary is the first thing the user sees.
• If the data contains a "sources" array (objects with title + uri), render them as a compact "Sources" list of clickable links (target="_blank") beneath the summary, so grounded citations are visible.
• KEEP OUTPUT COMPACT: no decorative comments, no unnecessary blank lines, minimal whitespace in HTML/CSS. Every token counts.`;

function buildPrompt(description, feedback, sourceHint) {
  const retryBlock = feedback ? `
⚠️ YOUR PREVIOUS ATTEMPT FAILED AUTOMATED VERIFICATION:
${feedback}

Produce a DIFFERENT, genuinely working solution this time. Critical guidance:
- axios CANNOT execute JavaScript — never scrape single-page-apps or JS-rendered pages with it.
- STRONGLY prefer a public JSON/REST API that returns real data without authentication.
- Make sure your endpoint/selectors return actual populated data, not empty containers.
` : '';

  const sourceBlock = sourceHint ? `
✅ VERIFIED DATA SOURCE (from a live web search — prefer this strongly):
${sourceHint}
` : '';

  return `Generate a web crawler and monitoring dashboard for this request:

"${description}"
${sourceBlock}${retryBlock}
Respond using EXACTLY this plain-text section format, in this exact order:

===NAME===
(a short display name, max 40 chars, on a single line)
===DESCRIPTION===
(a one-sentence summary of what is monitored, max 120 chars, single line)
===CRAWLER===
(the async function body — RAW JavaScript)
===DASHBOARD===
(the complete HTML document — RAW HTML)

ABSOLUTE OUTPUT RULES:
- Your VERY FIRST characters must be ===NAME===. Do NOT write any planning, reasoning, analysis, notes, or commentary before it.
- Do NOT think out loud. Do NOT explain your approach. Output ONLY the four sections.
- Emit the four markers EXACTLY: ===NAME===, ===DESCRIPTION===, ===CRAWLER===, ===DASHBOARD===
- Put raw content directly beneath each marker.
- This is NOT JSON. Do NOT escape quotes, newlines, or backslashes. Write code/HTML normally.
- Do NOT wrap any section in markdown code fences (no \`\`\`).
- Output nothing before ===NAME=== and nothing after the dashboard HTML.`;
}

// ── Section markers (order defines parse sequence) ─────────────────────────────
const SECTION_MARKERS = [
  { key: 'name',          tag: '===NAME===' },
  { key: 'description',   tag: '===DESCRIPTION===' },
  { key: 'crawlerCode',   tag: '===CRAWLER===' },
  { key: 'dashboardHtml', tag: '===DASHBOARD===' },
];

function stripFence(s) {
  return s
    .replace(/^```[a-zA-Z]*\s*\r?\n?/, '')
    .replace(/\r?\n?```\s*$/, '')
    .trim();
}

function parseSections(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Empty response from AI.');

  const found = SECTION_MARKERS
    .map(m => ({ ...m, idx: raw.lastIndexOf(m.tag) }))
    .filter(m => m.idx !== -1)
    .sort((a, b) => a.idx - b.idx);

  const haveCrawler = found.some(f => f.key === 'crawlerCode');
  const haveDash    = found.some(f => f.key === 'dashboardHtml');
  if (!haveCrawler || !haveDash) {
    console.error('[parseSections] Markers found:', found.map(f => f.tag).join(', ') || '(none)');
    console.error('[parseSections] First 600 chars:\n', raw.slice(0, 600));
    throw new Error('AI response was not in the expected format (missing CRAWLER or DASHBOARD section). Try again or pick a different model.');
  }

  const out = {};
  for (let i = 0; i < found.length; i++) {
    const start = found[i].idx + found[i].tag.length;
    const end   = i + 1 < found.length ? found[i + 1].idx : raw.length;
    out[found[i].key] = stripFence(raw.slice(start, end).trim());
  }

  if (!/<!doctype html|<html[\s>]/i.test(out.dashboardHtml)) {
    console.error('[parseSections] Dashboard does not look like HTML. First 300 chars:\n', out.dashboardHtml.slice(0, 300));
    throw new Error('AI produced an invalid dashboard (not valid HTML). Please try again or use a different model.');
  }

  return out;
}

// ── Gemini call with auto-retry on 503 ────────────────────────────────────────
const GEN_DELAYS = [4000, 8000, 16000];
const AI_DELAYS  = [1500, 3000];
const MAX_RETRIES = GEN_DELAYS.length;

async function callWithRetry(model, prompt, delays = GEN_DELAYS) {
  const maxRetries = delays.length;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await model.generateContent(prompt);
    } catch (err) {
      const msg = err.message ?? '';

      const transient =
        err.status === 503 || err.status === 500 ||
        /\b50[03]\b|Service Unavailable|overloaded|high demand|Internal error|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i.test(msg);
      if (transient && attempt < maxRetries) {
        const delay = delays[attempt];
        console.log(`[Retry ${attempt + 1}/${maxRetries}] Transient API failure (${err.status || 'network'}) — waiting ${delay / 1000}s…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

const GROUNDING_MODEL = 'gemini-flash-latest';

const GROUNDING_TTL_MS = 5 * 60_000;
const groundingCache = new Map();

function groundingCacheGet(key) {
  const hit = groundingCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > GROUNDING_TTL_MS) { groundingCache.delete(key); return null; }
  return hit.value;
}

function groundingCacheSet(key, value) {
  groundingCache.set(key, { at: Date.now(), value });
}

const GROUNDING_MAX_RETRIES     = Number(process.env.GROUNDING_MAX_RETRIES     ?? 1);
const GROUNDING_RETRY_DELAY_MS  = Number(process.env.GROUNDING_RETRY_DELAY_MS  ?? 5_000);
const GROUNDING_RETRY_CAP_MS    = 15_000; 
const GROUNDING_COOLDOWN_MS     = Number(process.env.GROUNDING_COOLDOWN_MS     ?? 15_000);
const GROUNDING_COOLDOWN_MAX_MS = 5 * 60_000;
let groundingCooldownUntil = 0;

function groundingOnCooldown() {
  return Date.now() < groundingCooldownUntil;
}

function startGroundingCooldown(ms = GROUNDING_COOLDOWN_MS) {
  groundingCooldownUntil = Date.now() + Math.min(Math.max(ms, 0), GROUNDING_COOLDOWN_MAX_MS);
}

function isRateLimit(err) {
  return err?.status === 429 ||
    /\b429\b|quota|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(err?.message || '');
}

function parseRetryDelayMs(err) {
  let secStr = null;
  const details = err?.errorDetails;
  if (Array.isArray(details)) {
    const ri = details.find(d => typeof d?.['@type'] === 'string' && d['@type'].includes('RetryInfo'));
    if (ri?.retryDelay) secStr = String(ri.retryDelay);
  }
  if (!secStr && err?.message) {
    const m = err.message.match(/retryDelay["\s:=]+"?(\d+(?:\.\d+)?)s/i);
    if (m) secStr = m[1];
  }
  if (!secStr) return null;
  const n = parseFloat(secStr);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

function groundingTurnedOff(modelId) {
  return !modelId || /^(off|none|no|disable[d]?|false)$/i.test(String(modelId).trim());
}

function extractSources(resp) {
  const meta = resp?.candidates?.[0]?.groundingMetadata;
  if (!meta) return [];
  const chunks = meta.groundingChunks || meta.groundingChuncks || [];
  const seen = new Set();
  const out = [];
  for (const c of chunks) {
    const web = c && c.web;
    if (!web || !web.uri || seen.has(web.uri)) continue;
    seen.add(web.uri);
    out.push({ title: web.title || web.uri, uri: web.uri });
  }
  return out;
}

function createAiHelper(apiKey, modelId, groundingModelId) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  });

  const groundModelId = groundingModelId || GROUNDING_MODEL;
  let groundModel = null;
  let groundingDisabled = groundingTurnedOff(groundingModelId); // also flips on if proven unsupported
  function getGroundModel() {
    if (!groundModel) {
      groundModel = genAI.getGenerativeModel({
        model: groundModelId,
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      });
    }
    return groundModel;
  }

  async function generate(prompt) {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('ai.generate(prompt): prompt must be a non-empty string.');
    }
    const result = await callWithRetry(model, prompt, AI_DELAYS);
    return (result.response.text() || '').trim();
  }

  async function summarize(input, instruction) {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    if (!text || !text.trim()) return '';
    const ask = (instruction && String(instruction).trim()) ||
      'Summarize the following content in 2-3 concise sentences. Return plain text only, no preamble.';
    try {
      return await generate(`${ask}\n\n--- CONTENT START ---\n${text.slice(0, 24000)}\n--- CONTENT END ---`);
    } catch (e) {
      console.warn('[ai.summarize] failed, returning empty summary:', e.message);
      return '';
    }
  }

  async function research(query, instruction) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) return { text: '', sources: [], grounded: false };

    const cacheKey = `${groundModelId}\n${instruction || ''}\n${q}`;
    const cached = groundingCacheGet(cacheKey);
    if (cached) return cached;

    const prompt = instruction
      ? `${instruction}\n\nQuestion: ${q}`
      : q;

    if (!groundingDisabled && !groundingOnCooldown()) {
      const toolVariants = [
        [{ googleSearch: {} }],
        [{ googleSearchRetrieval: { dynamicRetrievalConfig: { mode: 'MODE_DYNAMIC', dynamicThreshold: 0.3 } } }],
      ];
      let rlRetries = GROUNDING_MAX_RETRIES; 
      attemptLoop:
      while (true) {
        let allUnsupported = true; // only disable if EVERY failure was "unsupported"
        for (const tools of toolVariants) {
          try {
            const result = await callWithRetry(
              getGroundModel(),
              { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools },
              AI_DELAYS,
            );
            const value = {
              text: (result.response.text() || '').trim(),
              sources: extractSources(result.response),
              grounded: true,
            };
            groundingCacheSet(cacheKey, value);
            return value;
          } catch (e) {
            console.warn(`[ai.research] grounded attempt failed (${e.status || 'err'}): ${e.message}`);

            if (isRateLimit(e)) {
              const serverDelay = parseRetryDelayMs(e);
              if (rlRetries > 0) {
                rlRetries--;
                const waitMs = Math.min(serverDelay ?? GROUNDING_RETRY_DELAY_MS, GROUNDING_RETRY_CAP_MS);
                console.warn(`[ai.research] rate limited (429); retrying grounding in ${Math.round(waitMs / 1000)}s${serverDelay != null ? ' (server-suggested)' : ''}.`);
                await new Promise(r => setTimeout(r, waitMs));
                continue attemptLoop;
              }
              const cd = Math.max(serverDelay ?? 0, GROUNDING_COOLDOWN_MS);
              startGroundingCooldown(cd);
              console.warn(`[ai.research] still rate limited after retries; pausing grounding ~${Math.round(Math.min(cd, GROUNDING_COOLDOWN_MAX_MS) / 1000)}s and continuing ungrounded.`);
              return { text: '', sources: [], grounded: false };
            }

            const unsupported = e.status === 400 || /tool|googleSearch|not supported|invalid|function calling/i.test(e.message || '');
            if (!unsupported) { allUnsupported = false; break; }
          }
        }
        if (allUnsupported) {
          groundingDisabled = true;
          console.warn('[ai.research] grounding unsupported for this model; using ungrounded answers from now on.');
        }
        break;
      }
    }

    try {
      const text = await generate(prompt);
      const value = { text, sources: [], grounded: false };
      groundingCacheSet(cacheKey, value);
      return value;
    } catch (e) {
      console.warn('[ai.research] ungrounded fallback failed:', e.message);
      return { text: '', sources: [], grounded: false };
    }
  }

  return { generate, summarize, research };
}

function makeUnavailableAi() {
  const fail = async () => {
    throw new Error('AI helper unavailable: no API key is stored for this crawler. Regenerate it to enable summarization.');
  };
  return {
    generate: fail,
    summarize: async () => '',
    research: async () => ({ text: '', sources: [], grounded: false }),
  };
}

async function runCrawler(code, ai) {
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFn('axios', 'cheerio', 'ai', code);
  return fn(axios, cheerio, ai || makeUnavailableAi());
}

function runCrawlerWithTimeout(code, ai, ms = 60_000) {
  return Promise.race([
    runCrawler(code, ai),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Crawl timed out (${Math.round(ms / 1000)} s)`)), ms)),
  ]);
}

const META_KEYS = new Set([
  'scrapedat', 'timestamp', 'updatedat', 'fetchedat', 'lastupdated',
  'error', 'source', 'url', 'status', 'ok', 'success',
  'totalfound', 'total', 'count', 'length', 'page',
]);

const DERIVED_KEYS = new Set(['summary', 'summaries', 'sources', 'citations', 'analysis', 'insights']);

function isEffectivelyEmpty(data) {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'string') return data.trim().length === 0;
  if (typeof data === 'number') return !Number.isFinite(data) || data === 0;
  if (typeof data !== 'object') return false;

  for (const [k, v] of Object.entries(data)) {
    const lk = k.toLowerCase();
    if (META_KEYS.has(lk) || DERIVED_KEYS.has(lk)) continue;
    if (Array.isArray(v)) { if (v.length > 0) return false; }
    else if (v && typeof v === 'object') { if (Object.keys(v).length > 0) return false; }
    else if (typeof v === 'string') { if (v.trim().length > 0) return false; }
    else if (typeof v === 'number') { if (Number.isFinite(v) && v !== 0) return false; }
  }
  return true;
}

const BLOCK_RE = /\b40[13]\b|forbidden|access denied|unauthorized|blocked|captcha|cloudflare|are you a robot|enable javascript|request failed with status code 40[13]|failed to fetch|could not (?:load|fetch|retrieve)/i;

function looksBlocked(data) {
  if (data === null || data === undefined) return false;
  let s;
  try { s = typeof data === 'string' ? data : JSON.stringify(data); }
  catch { return false; }
  return BLOCK_RE.test(s || '');
}

async function validateCrawler(code, ai) {
  let data;
  try {
    data = await runCrawlerWithTimeout(code, ai, 50_000);
  } catch (e) {
    return {
      ok: false, data: null, reason: 'threw',
      feedback: `The crawler THREW an error when executed: "${e.message}". The code is broken or the target is unreachable/blocked. Write a corrected crawler — preferably using a public JSON/REST API that returns data directly.`,
    };
  }

  if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
    return {
      ok: false, data, reason: 'error-field',
      feedback: `The crawler executed but reported an internal error: "${String(data.error).slice(0, 200)}". Fix the request (headers, URL, parsing) or switch to a reliable public JSON API.`,
    };
  }

  if (looksBlocked(data)) {
    return {
      ok: false, data, reason: 'blocked',
      feedback: `The target BLOCKED the request (403 / bot-protection / "access denied" signature in the result). axios cannot bypass Cloudflare, login walls, or bot protection. Do NOT scrape consumer sites like FlightRadar24, FlightAware, Google Flights, or airport pages. Instead use a PUBLIC, key-free JSON API. For flights near a location use https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nauticalMiles} or https://api.airplanes.live/v2/point/{lat}/{lon}/{radiusNm} (both return JSON with an "ac" array of live aircraft). Return real, populated data from such an API.`,
    };
  }

  if (isEffectivelyEmpty(data)) {
    return {
      ok: false, data, reason: 'empty',
      feedback: `The crawler ran WITHOUT errors but returned NO usable data (empty arrays / zero values). This almost always means the target page renders its content with JavaScript (a SPA), so axios only receives an empty HTML shell — or the CSS selectors are wrong. Do NOT scrape that page with axios. Instead, find a PUBLIC JSON/REST API endpoint that returns the data directly (inspect the site for /api/ JSON endpoints, or use a well-known public API for this topic). Return real, populated data.`,
    };
  }

  return { ok: true, data, reason: 'ok' };
}

const MAX_GEN_ATTEMPTS = 3;

async function generateAndValidate(model, description, ai, sourceHint) {
  let feedback = null;
  let lastGood = null; // most recent parseable attempt (sections + validation)

  for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
    console.log(`[Generate] Attempt ${attempt}/${MAX_GEN_ATTEMPTS}${feedback ? ' (with fix feedback)' : ''}…`);

    let rawText;
    try {
      const result = await callWithRetry(model, buildPrompt(description, feedback, sourceHint));
      rawText = result.response.text();
    } catch (apiErr) {
      console.error(`[Generate] Attempt ${attempt} API call failed: ${apiErr.message}`);
      throw apiErr;
    }

    let sections;
    try {
      sections = parseSections(rawText);
    } catch (e) {
      feedback = `Your previous response could not be used: ${e.message} Follow the exact section format with ===NAME===, ===DESCRIPTION===, ===CRAWLER===, ===DASHBOARD===.`;
      console.warn(`[Generate] Attempt ${attempt} parse failed: ${e.message}`);
      continue;
    }

    const validation = await validateCrawler(sections.crawlerCode, ai);
    lastGood = { sections, validation };
    console.log(`[Generate] Attempt ${attempt} verification: ${validation.ok ? 'PASS' : 'FAIL (' + validation.reason + ')'}`);

    if (validation.ok) {
      return { sections, validation, attempts: attempt, verified: true };
    }
    feedback = validation.feedback;
  }

  if (lastGood) {
    return { sections: lastGood.sections, validation: lastGood.validation, attempts: MAX_GEN_ATTEMPTS, verified: false };
  }
  throw new Error('Could not produce a valid crawler after multiple attempts. Try rephrasing or a different model.');
}

async function discoverSource(description, ai) {
  if (!ai || typeof ai.research !== 'function') return null;
  const instruction =
    'You are helping a backend engineer pick a data source for a Node.js crawler that uses only axios (no browser, no JavaScript execution) and an optional API key the user already has. ' +
    'Recommend the single best PUBLIC, no-auth (or widely-free) JSON/REST API endpoint that currently returns the requested data. ' +
    'Give the concrete base URL and an example request path, the key response fields to read, and any required headers. ' +
    'Avoid sites that require login, heavy bot protection, or client-side JavaScript rendering. Keep it under 120 words.';
  try {
    const { text, sources, grounded } = await ai.research(description, instruction);
    if (!text || !text.trim()) return null;
    console.log(`[discoverSource] ${grounded ? 'grounded' : 'ungrounded'} hint (${sources.length} source${sources.length === 1 ? '' : 's'}).`);
    return { text: text.trim(), sources: sources || [], grounded: !!grounded };
  } catch (e) {
    console.warn('[discoverSource] failed, proceeding without a hint:', e.message);
    return null;
  }
}

const DEFAULT_MODEL = 'gemma-4-31b-it';

// ── POST /api/generate ─────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { apiKey, description, model: modelName, groundingModel: groundingName } = req.body ?? {};
  const modelId = modelName?.trim() || DEFAULT_MODEL;
  const groundingModelId = groundingName?.trim() || GROUNDING_MODEL;

  if (!apiKey?.trim())       return res.status(400).json({ error: 'Gemini API key is required.' });
  if (!description?.trim())  return res.status(400).json({ error: 'A monitoring description is required.' });

  try {
    const genAI = new GoogleGenerativeAI(apiKey.trim());
    const model = genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 65536,
      },
    });

    const aiHelper = createAiHelper(apiKey.trim(), modelId, groundingModelId);

    const sourceHint = groundingTurnedOff(groundingModelId)
      ? null
      : await discoverSource(description.trim(), aiHelper);

    const { sections, validation, attempts, verified } =
      await generateAndValidate(model, description.trim(), aiHelper, sourceHint ? sourceHint.text : null);

    const crawlerId = crypto.randomUUID();
    const dashboardHtml = sections.dashboardHtml.replaceAll('{{CRAWLER_ID}}', crawlerId);

    const entry = {
      id: crawlerId,
      name:        (sections.name        || 'Unnamed Monitor').slice(0, 60),
      description: (sections.description || description.trim()).slice(0, 150),
      code:        sections.crawlerCode,
      dashboardHtml,
      apiKey:         apiKey.trim(),
      model:          modelId,
      groundingModel: groundingModelId,
      createdAt:   new Date().toISOString(),
      lastRun:     validation.ok ? new Date().toISOString() : null,
      lastResult:  validation.ok ? validation.data : null,
      lastError:   validation.ok ? null : validation.reason,
    };

    crawlerStore.set(crawlerId, entry);

    const verifyNote = verified
      ? `Verified working — the crawler returned real data${attempts > 1 ? ` after ${attempts} attempts` : ''}.`
      : `Could not verify after ${attempts} attempts (${validation.reason}). The dashboard may show no data.` +
        (validation.reason === 'empty'
          ? ' The target is likely JavaScript-rendered — try a source that exposes a public API.'
          : validation.reason === 'blocked'
          ? ' The target blocked the request (bot protection) — try a source that exposes a public API.'
          : '');

    return res.json({
      crawlerId,
      name:         entry.name,
      description:  entry.description,
      code:         sections.crawlerCode,
      verified,
      attempts,
      verifyReason: validation.reason,
      verifyNote,
      grounded:     sourceHint ? sourceHint.grounded : false,
      sources:      sourceHint ? sourceHint.sources : [],
      initialData:  validation.data ?? null,
      initialError: verified ? null : validation.feedback,
    });

  } catch (err) {
    const msg = err.message ?? String(err);
    console.error('[/api/generate]', err);

    if (err.status === 503 || /503|Service Unavailable|overloaded|high demand/i.test(msg)) {
      return res.status(503).json({ error: `Model '${modelId}' is overloaded after ${MAX_RETRIES} retries. Please wait a minute and try again.` });
    }
    if (/API_KEY|api[_\s]key|invalid.*key|403|401/i.test(msg) || err.status === 403 || err.status === 401) {
      return res.status(401).json({ error: 'Invalid Gemini API key. Please check and try again.' });
    }
    if (/quota|RESOURCE_EXHAUSTED|429/i.test(msg)) {
      return res.status(429).json({ error: 'Gemini API quota exceeded. Please wait a moment and retry.' });
    }
    if (/not found|404|unknown model/i.test(msg)) {
      return res.status(404).json({ error: `Model '${modelId}' not found. Check the model name or ensure your API key has access to it.` });
    }
    return res.status(500).json({ error: msg });
  }
});

// ── GET /api/crawl/:id ─────────────────────────────────────────────────────────
app.get('/api/crawl/:id', async (req, res) => {
  const entry = crawlerStore.get(req.params.id);
  if (!entry) return res.status(404).json({ success: false, error: 'Crawler not found.' });

  try {
    const ai = entry.apiKey ? createAiHelper(entry.apiKey, entry.model, entry.groundingModel) : makeUnavailableAi();
    const data = await runCrawlerWithTimeout(entry.code, ai, 60_000);
    entry.lastResult = data;
    entry.lastRun    = new Date().toISOString();
    entry.lastError  = null;
    return res.json({ success: true, data, timestamp: entry.lastRun });
  } catch (err) {
    entry.lastError = err.message;
    return res.status(500).json({ success: false, error: err.message, timestamp: new Date().toISOString() });
  }
});

// ── GET /api/crawlers ──────────────────────────────────────────────────────────
app.get('/api/crawlers', (_req, res) => {
  res.json(
    Array.from(crawlerStore.values()).map(({ id, name, description, createdAt, lastRun, lastError }) => ({
      id, name, description, createdAt, lastRun, lastError,
    }))
  );
});

// ── DELETE /api/crawlers/:id ───────────────────────────────────────────────────
app.delete('/api/crawlers/:id', (req, res) => {
  res.json({ success: crawlerStore.delete(req.params.id) });
});

// ── GET /dashboard/:id ────────────────────────────────────────────────────────
app.get('/dashboard/:id', (req, res) => {
  const entry = crawlerStore.get(req.params.id);
  if (!entry) {
    return res.status(404).send(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0a0a0a;color:#f0f0f0;' +
      'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
      '<h2 style="color:#888">Dashboard not found</h2></body></html>'
    );
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(entry.dashboardHtml);
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n  ┌────────────────────────────────────┐');
  console.log('  │   Auto-Monitor — AI Crawler Gen     │');
  console.log('  └────────────────────────────────────┘');
  console.log(`\n  Running at → http://localhost:${PORT}\n`);
});
