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
const crawlerStore = new Map(); // crawlerId → crawler entry

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
                Both are ASYNC — always await them. Use ai ONLY when the request needs
                summarization/analysis (e.g. "summarize today's news"). If asked to summarize,
                attach the result to your data (e.g. item.summary = await ai.summarize(item.body)).
                PERFORMANCE: prefer ONE batched ai call over many. Summarize a combined digest, or
                cap per-item summaries to the first ~8 items. Wrap every ai call in try/catch so an
                AI hiccup never kills the whole crawl.
• The code MUST end with:  return { ...yourData, scrapedAt: new Date().toISOString() }
• All returned values must be JSON-serializable (strings, numbers, plain objects, arrays).
• Prefer official JSON/REST APIs over HTML scraping when available.
• For HTML scraping add a realistic browser User-Agent header to avoid 403 blocks.
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
• KEEP OUTPUT COMPACT: no decorative comments, no unnecessary blank lines, minimal whitespace in HTML/CSS. Every token counts.`;

// ── Prompt template (delimiter-based, NOT JSON) ────────────────────────────────
// Returning code/HTML inside JSON strings forces the model to escape every
// quote, newline and backslash — which it frequently gets wrong, producing
// unparseable output. A delimiter format lets each section be emitted RAW,
// eliminating the escaping problem entirely.
function buildPrompt(description, feedback) {
  const retryBlock = feedback ? `
⚠️ YOUR PREVIOUS ATTEMPT FAILED AUTOMATED VERIFICATION:
${feedback}

Produce a DIFFERENT, genuinely working solution this time. Critical guidance:
- axios CANNOT execute JavaScript — never scrape single-page-apps or JS-rendered pages with it.
- STRONGLY prefer a public JSON/REST API that returns real data without authentication.
- Make sure your endpoint/selectors return actual populated data, not empty containers.
` : '';

  return `Generate a web crawler and monitoring dashboard for this request:

"${description}"
${retryBlock}
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

// Strip an accidental leading/trailing markdown fence from a section body.
function stripFence(s) {
  return s
    .replace(/^```[a-zA-Z]*\s*\r?\n?/, '')
    .replace(/\r?\n?```\s*$/, '')
    .trim();
}

// ── Robust section parser ──────────────────────────────────────────────────────
// IMPORTANT: some models (especially "thinking" / reasoning models) dump their
// chain-of-thought into the response, and that prose often *echoes the marker
// names* (e.g. a bullet list mentioning `===CRAWLER===`). The real, final output
// is always the LAST block, so we anchor on lastIndexOf() — not indexOf() — to
// skip past any reasoning that repeats the markers earlier in the text.
function parseSections(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('Empty response from AI.');

  // Locate the LAST occurrence of every marker, then order by position.
  const found = SECTION_MARKERS
    .map(m => ({ ...m, idx: raw.lastIndexOf(m.tag) }))
    .filter(m => m.idx !== -1)
    .sort((a, b) => a.idx - b.idx);

  // The two essential sections must be present
  const haveCrawler = found.some(f => f.key === 'crawlerCode');
  const haveDash    = found.some(f => f.key === 'dashboardHtml');
  if (!haveCrawler || !haveDash) {
    console.error('[parseSections] Markers found:', found.map(f => f.tag).join(', ') || '(none)');
    console.error('[parseSections] First 600 chars:\n', raw.slice(0, 600));
    throw new Error('AI response was not in the expected format (missing CRAWLER or DASHBOARD section). Try again or pick a different model.');
  }

  // Slice content between consecutive markers
  const out = {};
  for (let i = 0; i < found.length; i++) {
    const start = found[i].idx + found[i].tag.length;
    const end   = i + 1 < found.length ? found[i + 1].idx : raw.length;
    out[found[i].key] = stripFence(raw.slice(start, end).trim());
  }

  // Guard: a corrupt parse can leave the dashboard non-HTML (e.g. leftover
  // reasoning). Require a recognizable HTML opening so we fail fast & clearly.
  if (!/<!doctype html|<html[\s>]/i.test(out.dashboardHtml)) {
    console.error('[parseSections] Dashboard does not look like HTML. First 300 chars:\n', out.dashboardHtml.slice(0, 300));
    throw new Error('AI produced an invalid dashboard (not valid HTML). Please try again or use a different model.');
  }

  return out;
}

// ── Gemini call with auto-retry on 503 ────────────────────────────────────────
const MAX_RETRIES = 3;

async function callWithRetry(model, prompt) {
  const DELAYS = [4000, 8000, 16000]; // backoff: 4 s, 8 s, 16 s
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await model.generateContent(prompt);
    } catch (err) {
      const msg = err.message ?? '';
      // Retry transient server/network failures: 503 (overloaded), 500
      // (internal error), and low-level fetch/connection errors. Do NOT retry
      // auth (401/403), quota (429), or model-not-found (404) — those are not
      // going to fix themselves.
      const transient =
        err.status === 503 || err.status === 500 ||
        /\b50[03]\b|Service Unavailable|overloaded|high demand|Internal error|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network/i.test(msg);
      if (transient && attempt < MAX_RETRIES) {
        const delay = DELAYS[attempt];
        console.log(`[Retry ${attempt + 1}/${MAX_RETRIES}] Transient API failure (${err.status || 'network'}) — waiting ${delay / 1000}s…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ── Gemini AI helper exposed to generated crawlers ─────────────────────────────
// Generated crawlers run with `axios`, `cheerio`, and this `ai` object in scope.
// It lets a crawler call Gemini to summarize / extract / classify the content it
// scrapes (the user's "summarizing agent"). It deliberately uses NO
// systemInstruction so it works with any model the user picked, and caps output
// so summaries stay fast and cheap.
function createAiHelper(apiKey, modelId) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  });

  // Raw prompt -> text. Reuses the same 503/500/network backoff as generation.
  async function generate(prompt) {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('ai.generate(prompt): prompt must be a non-empty string.');
    }
    const result = await callWithRetry(model, prompt);
    return (result.response.text() || '').trim();
  }

  // Summarize a string or any JSON-serializable value. Optional instruction lets
  // the crawler steer it ("one sentence", "extract sentiment", "bullet points").
  async function summarize(input, instruction) {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    if (!text || !text.trim()) return '';
    const ask = (instruction && String(instruction).trim()) ||
      'Summarize the following content in 2-3 concise sentences. Return plain text only, no preamble.';
    // Cap input so a huge page body can't blow the token budget.
    return generate(`${ask}\n\n--- CONTENT START ---\n${text.slice(0, 24000)}\n--- CONTENT END ---`);
  }

  return { generate, summarize };
}

// Fallback used when a stored crawler has no API key available to re-run with
// (e.g. created before keys were stored). Any AI call surfaces a clear message
// instead of an opaque "ai is not defined".
function makeUnavailableAi() {
  const fail = async () => {
    throw new Error('AI helper unavailable: no API key is stored for this crawler. Regenerate it to enable summarization.');
  };
  return { generate: fail, summarize: fail };
}

// ── Crawler executor ──────────────────────────────────────────────────────────
// NOTE: AsyncFunction runs in the module scope (not sandboxed). Fine for a POC;
// for production, replace with isolated-vm or a Worker thread.
async function runCrawler(code, ai) {
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFn('axios', 'cheerio', 'ai', code);
  return fn(axios, cheerio, ai || makeUnavailableAi());
}

// AI summarization makes crawls slower, so the timeout is generous.
function runCrawlerWithTimeout(code, ai, ms = 60_000) {
  return Promise.race([
    runCrawler(code, ai),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Crawl timed out (${Math.round(ms / 1000)} s)`)), ms)),
  ]);
}

// ── Verification: does the crawler actually return usable data? ─────────────────
// Metadata-only keys don't count as "real" data — an empty crawl often still
// returns these, so we ignore them when judging emptiness.
const META_KEYS = new Set([
  'scrapedat', 'timestamp', 'updatedat', 'fetchedat', 'lastupdated',
  'error', 'source', 'url', 'status', 'ok', 'success',
  'totalfound', 'total', 'count', 'length', 'page',
]);

function isEffectivelyEmpty(data) {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'string') return data.trim().length === 0;
  if (typeof data === 'number') return !Number.isFinite(data) || data === 0;
  if (typeof data !== 'object') return false;

  for (const [k, v] of Object.entries(data)) {
    if (META_KEYS.has(k.toLowerCase())) continue;
    if (Array.isArray(v)) { if (v.length > 0) return false; }
    else if (v && typeof v === 'object') { if (Object.keys(v).length > 0) return false; }
    else if (typeof v === 'string') { if (v.trim().length > 0) return false; }
    else if (typeof v === 'number') { if (Number.isFinite(v) && v !== 0) return false; }
  }
  return true;
}

// Run the generated crawler and classify the outcome.
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

  if (isEffectivelyEmpty(data)) {
    return {
      ok: false, data, reason: 'empty',
      feedback: `The crawler ran WITHOUT errors but returned NO usable data (empty arrays / zero values). This almost always means the target page renders its content with JavaScript (a SPA), so axios only receives an empty HTML shell — or the CSS selectors are wrong. Do NOT scrape that page with axios. Instead, find a PUBLIC JSON/REST API endpoint that returns the data directly (inspect the site for /api/ JSON endpoints, or use a well-known public API for this topic). Return real, populated data.`,
    };
  }

  return { ok: true, data, reason: 'ok' };
}

// ── Generate + self-verify, regenerating with feedback until it works ──────────
const MAX_GEN_ATTEMPTS = 3;

async function generateAndValidate(model, description, ai) {
  let feedback = null;
  let lastGood = null; // most recent parseable attempt (sections + validation)

  for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
    console.log(`[Generate] Attempt ${attempt}/${MAX_GEN_ATTEMPTS}${feedback ? ' (with fix feedback)' : ''}…`);

    // Call the model. Transport/API errors (overload, internal error, network,
    // auth, quota) are NOT fixable by re-prompting — callWithRetry already backed
    // off on the transient ones, so propagate to the route for a precise message
    // instead of burning attempts with misleading "fix your format" feedback.
    let rawText;
    try {
      const result = await callWithRetry(model, buildPrompt(description, feedback));
      rawText = result.response.text();
    } catch (apiErr) {
      console.error(`[Generate] Attempt ${attempt} API call failed: ${apiErr.message}`);
      throw apiErr;
    }

    // Parsing / format failures ARE retryable via re-prompting.
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

  // Exhausted attempts — return the last usable generation, flagged unverified
  if (lastGood) {
    return { sections: lastGood.sections, validation: lastGood.validation, attempts: MAX_GEN_ATTEMPTS, verified: false };
  }
  throw new Error('Could not produce a valid crawler after multiple attempts. Try rephrasing or a different model.');
}

// Default generation model. Users can override this from the UI.
const DEFAULT_MODEL = 'gemma-4-31b-it';

// ── POST /api/generate ─────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { apiKey, description, model: modelName } = req.body ?? {};
  const modelId = modelName?.trim() || DEFAULT_MODEL;

  if (!apiKey?.trim())       return res.status(400).json({ error: 'Gemini API key is required.' });
  if (!description?.trim())  return res.status(400).json({ error: 'A monitoring description is required.' });

  try {
    const genAI = new GoogleGenerativeAI(apiKey.trim());
    const model = genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: {
        temperature: 0.2,
        // Note: responseMimeType intentionally omitted — we use a delimiter
        // format (parseSections), not JSON, so the model never has to escape
        // the crawler/HTML content.
        maxOutputTokens: 65536,
      },
    });

    // AI helper handed to the generated crawler so it can summarize / extract
    // with Gemini at crawl time.
    const aiHelper = createAiHelper(apiKey.trim(), modelId);

    // Generate, then actually RUN the crawler to verify it works — regenerating
    // with targeted feedback (up to MAX_GEN_ATTEMPTS) if it errors or returns
    // no usable data.
    const { sections, validation, attempts, verified } =
      await generateAndValidate(model, description.trim(), aiHelper);

    const crawlerId = crypto.randomUUID();
    const dashboardHtml = sections.dashboardHtml.replaceAll('{{CRAWLER_ID}}', crawlerId);

    const entry = {
      id: crawlerId,
      name:        (sections.name        || 'Unnamed Monitor').slice(0, 60),
      description: (sections.description || description.trim()).slice(0, 150),
      code:        sections.crawlerCode,
      dashboardHtml,
      // Stored so /api/crawl/:id re-runs can rebuild the AI helper. POC-only:
      // keeping the key in memory is acceptable here; it is never sent to clients
      // (see GET /api/crawlers, which omits it).
      apiKey:      apiKey.trim(),
      model:       modelId,
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
    // Rebuild the AI helper from the key stored at creation time so the crawler
    // can summarize on every refresh, not just the first run.
    const ai = entry.apiKey ? createAiHelper(entry.apiKey, entry.model) : makeUnavailableAi();
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
