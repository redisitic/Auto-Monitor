# Auto-Monitor

AI-powered, on-demand crawler and dashboard generator built on the Google Gemini API.

## Overview

Auto-Monitor is a ChatGPT-style web app. You describe what you want to monitor in
plain language, and the app uses Gemini to generate two things:

1. A working JavaScript web crawler.
2. A complete, self-contained HTML dashboard that displays the crawled data.

Before saving anything, the app actually runs the generated crawler to confirm it
returns real, usable data. If the crawler errors out or comes back empty, the app
feeds that failure back to the model and regenerates a corrected version, up to a
fixed number of attempts. Each result is marked as either verified or unverified so
you always know whether the crawler was confirmed working.

## Features

- Natural-language generation of both a crawler and a live dashboard.
- AI summarization built in: each generated crawler receives a Gemini-backed `ai`
  helper, so monitors can summarize, extract, or classify the content they scrape
  (for example "summarize today's top stories"). Summaries are produced on every
  refresh, not just the first run.
- Self-verification loop: the crawler is executed, and on failure it is regenerated
  with targeted feedback (up to 3 attempts).
- Configurable model: set any model name available on your API key from the UI.
  Defaults to `gemma-4-31b-it`.
- Live dashboards that auto-refresh every 60 seconds with a manual refresh button.
- Dark themed, single-page chat interface.
- Your API key is supplied from the browser and is never hard-coded into the app.
- Automatic retry with exponential backoff on transient API failures (HTTP 503
  overload, HTTP 500 internal errors, and network or fetch failures).

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
3. Type a description of what you want to monitor, for example
   "Track the top stories on Hacker News" or "Monitor the current price of Bitcoin".
4. Send the request. The app generates a crawler, runs it to verify it works, and
   then shows a result card.
5. Check the verification badge on the card. "Verified working" means the crawler
   returned real data. "Unverified" means it could not be confirmed after the maximum
   number of attempts, so the dashboard may show no data.
6. Open the generated dashboard to view the live data.

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
- AI helper: the injected `ai` object exposes `await ai.summarize(textOrObject, instruction?)`
  and `await ai.generate(prompt)`, both backed by Gemini using the same API key and
  model. The key is stored with the crawler server-side so re-runs from the dashboard
  can summarize too. It is never returned to the browser.
- Verification: after running, the result is checked for thrown errors, an internal
  error field, or effectively empty output. Metadata-only keys such as `scrapedAt` do
  not count as real data.
- Storage: crawlers are kept in an in-memory map. They are cleared when the server
  restarts.

## Configuration

- `PORT`: the port the server listens on. Defaults to `3000`.
- Model name: set per request from the UI. Defaults to `gemma-4-31b-it`.

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
