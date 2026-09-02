# Policy Guard

A Firefox extension that reads Terms of Service and Privacy Policies and tells
you what to be cautious about — **before** you click "I agree".

It works on the page you are reading, and on the signup form that is asking you
to accept a document nobody opens.

## What it does

**Pattern matching, always on.** 27 rules across 14 categories run on every
policy page. Instant, free, offline, and nothing leaves your browser. This tier
is permanent, not a placeholder — if the AI half is off or unavailable, the
extension still works.

**AI analysis, optional.** Bring your own Anthropic API key and a second pass
reads the policy properly. Off by default, never automatic, and it tells you
what a scan will cost before you spend anything.

**Every finding cites the document.** A concern without a sentence behind it is
not a finding. Anything the model claims that cannot be located in the text
verbatim is discarded rather than shown to you — and the popup reports how many
were thrown away. *Show on page* scrolls to the clause and selects it.

**Favourable terms are reported too.** A policy that lets you delete your data
or keeps your content ownership says so, in green. A list of only bad news is
not an honest reading.

## Install (development)

No build step, no dependencies to compile.

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Select `manifest.json`

Requires Firefox 140 or later.

## Using AI analysis

Optional. Open the extension's settings, enable deep analysis, accept the
disclosure, and paste an Anthropic API key.

- A key created inside a workspace also needs its **Workspace ID**; a personal
  key does not.
- Cost is roughly **$0.09 per policy** on Claude Opus 5, **$0.04** on Sonnet 5,
  **$0.02** on Haiku 4.5. You pay Anthropic directly.
- Results are cached for 30 days keyed on the policy's text, so re-reading a
  document you have already analysed is free.

Your key is stored unencrypted in extension storage — see
[PRIVACY.md](PRIVACY.md) for exactly what that means and what is sent where.

## Development

```bash
npm run lint     # web-ext lint
npm run build    # package into web-ext-artifacts/
npm run dev      # load into a temporary Firefox profile
npm run serve    # test server on :8765, then open the URLs below
```

The test suite runs in a browser and needs no dependencies:

| Page | What it covers |
| --- | --- |
| `localhost:8765/test/runner.html` | The full suite — detection, extraction, negation, rules, quote grounding, merge, chunking, cache eviction, fetched parsing, show-on-page |
| `localhost:8765/test/popup-preview.html` | The real popup against a real extraction |
| `localhost:8765/test/options-preview.html` | The real settings page with storage stubbed |
| `localhost:8765/test/ui-preview.html` | The on-page panel and highlighter on a real policy |

Fixtures are saved copies of real policies in `test/fixtures/`, loaded into a
script-free same-origin iframe. Never test against the live web — it changes
under you.

## Layout

```
background.js       orchestration; all logic lives here
content/            DOM only — detect, extract, highlight, on-page panel
analysis/           rules engine, LLM client, quote verification, merge
lib/                schema, storage, cache, hashing
popup/ options/ welcome/
test/               fixtures and browser-based suites
```

[plan.md](plan.md) is the design document: what was built, what changed during
building, and why. It records the bugs the fixture corpus caught, which is most
of what is worth knowing about this codebase.

## Status

Feature-complete against the plan and working in Firefox. Not yet submitted to
addons.mozilla.org. The AI path has been exercised against the live API but not
broadly.

Informational only. Not legal advice, and no substitute for reading anything
that matters to you.
