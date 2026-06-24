# Auto-Monitor

AI-powered, on-demand crawler and dashboard generator built on the Google Gemini API.

## Overview

Auto-Monitor is a ChatGPT-style web app. You describe what you want to monitor in
plain language, and the app uses Gemini to generate two things:

1. A working JavaScript web crawler.
2. A complete, self-contained HTML dashboard that displays the crawled data.

To improve reliability, the app first runs a Google Search grounded step to find a
public, key-free data source for your request, then generates the crawler with that
source in mind. Before saving anything, the app actually runs the generated crawler to
confirm it returns real, usable data. If the crawler errors out, comes back empty, or
looks blocked by bot protection, the app feeds that failure back to the model and
regenerates a corrected version, up to a fixed number of attempts. Each result is
marked as either verified or unverified so you always know whether the crawler was
confirmed working.

## Features

- Natural-language generation of both a crawler and a live dashboard.
- AI summarization built in: each generated crawler receives a Gemini-backed `ai`
  helper, so monitors can summarize, extract, or classify the content they scrape
  (for example "summarize today's top stories"). Summaries are produced on every
  refresh, not just the first run.
- Google Search grounding: before writing any code, the app runs a grounded
  pre-step that searches the live web for the best public, key-free JSON or REST
  API serving the requested data, then steers code generation toward that source.
  Generated crawlers also receive an `ai.research(query)` helper that returns a
  web-grounded answer plus citation links, useful for facts that change (headlines,
  prices, schedules). Grounded answers are cached for a few minutes so the 60
  second auto-refresh does not trigger a search every cycle. Grounding degrades
  gracefully: if the grounding model is rate limited (HTTP 429) or unavailable, the
  app pauses grounding briefly and continues without it rather than failing. You can
  also turn grounding off from the UI to conserve quota.
- Bot-block detection: results that contain a 403, Cloudflare, captcha, or
  "access denied" signature are treated as failures and regenerated toward a public
  API, instead of being mistaken for real data.
- Self-verification loop: the crawler is executed, and on failure it is regenerated
  with targeted feedback (up to 3 attempts).
- Configurable models: set any code-generation model name available on your API key
  from the UI (defaults to `gemma-4-31b-it`), plus a separate grounding model
  (defaults to `gemini-flash-latest`). Grounding requires a Gemini model because
  Gemma models do not support tool use.
- Live dashboards that auto-refresh every 60 seconds with a manual refresh button.

## Prerequisites

- Node.js 18 or newer.
- A Google Gemini API key. You can create one at https://aistudio.google.com/apikey

## Installation

```bash
npm install
```

## Running

Start the server:

```bash
npm start
```

Or run with auto-reload during development:

```bash
npm run dev
```

Then open http://localhost:3000 in your browser.

## Usage

1. In the sidebar, paste your Gemini API key.
2. Optionally set a model name. Leave it blank to use the default (`gemma-4-31b-it`).
3. Optionally set a grounding model. Leave it blank to use the default
   (`gemini-flash-latest`). This must be a Gemini model, since grounding uses tools.
4. Type a description of what you want to monitor, for example
   "Track the top stories on Hacker News" or "Monitor the current price of Bitcoin".
5. Send the request. The app searches the web for a good data source, generates a
   crawler, runs it to verify it works, and then shows a result card.
6. Check the badges on the card. "Verified working" means the crawler returned real
   data. "Unverified" means it could not be confirmed after the maximum number of
   attempts, so the dashboard may show no data. A "Grounded" badge means a live web
   search informed the source selection, and any citation links are listed below.
7. Open the generated dashboard to view the live data.

## API Endpoints

| Method | Path                  | Description                                          |
| ------ | --------------------- | ---------------------------------------------------- |
| POST   | `/api/generate`       | Generate, verify, and store a new crawler.           |
| GET    | `/api/crawl/:id`      | Run a stored crawler and return its current data.    |
| GET    | `/api/crawlers`       | List all stored crawlers (metadata only).            |
| DELETE | `/api/crawlers/:id`   | Delete a stored crawler.                             |
| GET    | `/dashboard/:id`      | Serve the generated HTML dashboard for a crawler.    |

## How It Works

- Delimiter-based prompt: instead of asking the model to return JSON (which forces it
  to escape every quote and newline inside the generated code), the prompt uses plain
  text section markers (`===NAME===`, `===DESCRIPTION===`, `===CRAWLER===`,
  `===DASHBOARD===`). Each section is emitted raw, which removes a large class of
  parsing failures.
- Robust parsing: `parseSections` anchors on the last occurrence of each marker. Some
  reasoning models echo the marker names inside their chain-of-thought, and the real
  output is always the final block, so anchoring on the last occurrence skips the
  noise.
- Crawler execution: generated code runs as an async function body via the
  AsyncFunction constructor, with `axios`, `cheerio`, and an `ai` helper provided in
  scope and a hard timeout to prevent runaway crawls.
- AI helper: the injected `ai` object exposes `await ai.summarize(textOrObject, instruction?)`,
  `await ai.generate(prompt)`, and `await ai.research(query, instruction?)`. The
  `research` call returns `{ text, sources, grounded }`, where `text` is informed by a
  live Google Search and `sources` is a list of `{ title, uri }` citations. All three
  are backed by Gemini using the same API key. The key is stored with the crawler
  server-side so re-runs from the dashboard can summarize and research too. It is never
  returned to the browser.
- Grounded source discovery: before generation, the app asks a grounded Gemini model
  which public, key-free JSON or REST endpoint currently serves the requested data, and
  injects that recommendation into the generation prompt. This steers the model away
  from bot-protected or JavaScript-rendered consumer sites and toward sources that
  axios can actually read. The step is best effort, so generation continues normally if
  grounding is unavailable. Grounded answers are cached per model and query for a few
  minutes to limit search cost.
- Verification: after running, the result is checked for thrown errors, an internal
  error field, bot-block signatures (403, Cloudflare, captcha, "access denied"), or
  effectively empty output. Metadata-only keys such as `scrapedAt` and derived keys
  such as `summary` or `sources` do not count as real data, so an AI summary alone
  cannot mask a failed scrape.
- Storage: crawlers are kept in an in-memory map. They are cleared when the server
  restarts.

## Configuration

- `PORT`: the port the server listens on. Defaults to `3000`.
- Model name: set per request from the UI. Defaults to `gemma-4-31b-it`.
- Grounding model: set per request from the UI. Defaults to `gemini-flash-latest`.
  Must be a Gemini model with tool support; Gemma models cannot ground. Set this
  field to `off` (or `none`) to disable grounding entirely and conserve API quota.

## Troubleshooting

- HTTP 429 / quota exceeded: your Gemini API plan hit its rate or usage limit. This
  is a billing and rate-limit condition on your key, not an app bug. The grounding
  pre-step and the in-crawl `ai` helpers each make additional API calls, so they can
  push a low free-tier quota over the edge. Options: wait for the limit window to
  reset, raise your quota in Google AI Studio, choose models with higher limits, or
  set the grounding model field to `off` to remove the extra grounding calls. When
  grounding hits a 429 the app first retries a bounded number of times, honoring the
  API's own suggested retry delay when one is provided; only if those quick retries
  still fail does it pause grounding for a short cooldown and continue ungrounded, so
  generation still works. Tune this with the `GROUNDING_MAX_RETRIES` (default 1),
  `GROUNDING_RETRY_DELAY_MS` (default 5000), and `GROUNDING_COOLDOWN_MS` (default
  15000) environment variables.
- Unverified result: the crawler could not be confirmed to return real data after the
  maximum attempts. Try a more specific request, or one that maps to a public API.
- Empty or blocked dashboard: the target likely renders with JavaScript or blocks
  bots. Rephrase toward a source that exposes a public JSON or REST API.

## Deployment

The app is a standard Node.js Express server, so it runs on most platforms:

- Railway, Render, or Fly.io: point the platform at the repository and use
  `npm start` as the start command.
- Google Cloud Run: containerize with a simple Node base image and deploy.
- A VPS: clone the repository, run `npm install`, then `npm start` behind a reverse
  proxy such as Nginx.

Set the `PORT` environment variable if your platform assigns one.

## Security Notes

This project is a proof of concept and is not hardened for production:

- It executes AI-generated JavaScript via the AsyncFunction constructor in the module
  scope. This is not sandboxed. For production use, run generated code in an isolated
  environment such as isolated-vm or a worker with strict limits.
- There is no authentication. Anyone who can reach the server can generate and run
  crawlers.
- Crawler data is stored in memory only and is lost on restart.
- To support summarization on dashboard refreshes, each crawler's API key is held in
  memory server-side. It is never sent to the browser, but it does live in process
  memory until restart. Do not run this on an untrusted host.

Use it for experimentation and demos, not for untrusted public exposure.
