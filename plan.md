# Policy Guard — Implementation Plan

A Firefox extension that reads Terms of Service / Privacy Policies and tells you what to be cautious about, **before** you click "I agree".

Status: scaffold exists (`manifest.json`, `content.js`, `popup.js/html/css`) — the popup can detect that a page *looks* legal. Everything below is the path from there to the product in the mockups.

---

## 1. The opinionated core

Three positions that shape every decision below.

**1. The value is in the citation, not the summary.** Anyone can produce "this policy shares your data." What makes the extension trustworthy is showing *the exact sentence* that says so, and letting the user jump to it on the page. Every concern carries a verbatim quote. No quote → no concern. This also makes hallucination visible: if the quote isn't on the page, we drop the finding automatically.

**2. Keywords are a real product tier, not a throwaway prototype.** The rules engine ships permanently: it's instant, free, offline, and privacy-preserving. The LLM is an *enrichment* layer on top. If the API key is missing, rate-limited, or the user opted out, the extension still works — just with a rougher read. Don't build the rules engine as scaffolding you plan to delete.

**3. The moment that matters is the signup page, not the policy page.** Nobody voluntarily opens a 12,000-word ToS. They're on a checkout or registration form with a checkbox and a link. The highest-value feature is: detect that link, fetch and analyze it in the background, and surface the badge *while they're still on the form*. This is the differentiator over "paste text into ChatGPT" and it should be designed for from the start, even if it lands in Phase 4.

---

## 2. Architecture

```
┌───────────────┐   extract    ┌────────────────┐   analyze    ┌──────────────┐
│ content.js    │─────────────▶│ background.js  │─────────────▶│ analysis/    │
│               │              │  (orchestrator)│              │  rules.js    │
│ - detect page │◀─────────────│                │◀─────────────│  llm.js      │
│ - extract text│  highlight   │  - cache       │   findings   │  merge.js    │
│ - highlight   │              │  - dedupe      │              └──────────────┘
│ - inject badge│              │  - settings    │                     │
└───────────────┘              └────────────────┘              ┌──────────────┐
                                       ▲                       │ storage      │
                                       │                       │ - cache      │
                               ┌───────┴────────┐              │ - settings   │
                               │ popup.js       │              │ - api key    │
                               │ (view only)    │              └──────────────┘
                               └────────────────┘
```

**All logic lives in the background script.** The popup is a view — it asks the background for state and renders it. This matters because the popup is destroyed every time it closes; an in-flight LLM call owned by the popup dies with it. Firefox MV3 uses an *event page* background (`"background": { "scripts": ["background.js"] }`), which can also be evicted, so persist progress to `storage.session` as it happens rather than holding it only in memory.

**Content script does DOM work only** — extraction and highlighting. It never talks to the network and never sees the API key.

### File layout

```
manifest.json
background.js            # message router, orchestration, cache
content/
  content.js             # detect + extract + respond
  detect.js              # is this a policy page? is there a policy link?
  extract.js             # DOM → clean structured text
  highlight.js           # scroll-to + mark a quoted clause
  badge.css              # in-page floating badge styles
analysis/
  rules.js               # tier 1: pattern matching
  patterns.json          # the rule definitions (data, not code)
  llm.js                 # tier 2: provider call + JSON schema
  prompt.js              # prompt construction, chunking
  merge.js               # combine + dedupe tier 1 and tier 2
  verify.js              # quote-grounding check
lib/
  storage.js             # typed wrappers over browser.storage
  hash.js                # content hashing for cache keys
  schema.js              # Finding shape + validation
popup/
  popup.html/.css/.js
options/
  options.html/.css/.js  # API key, concern preferences, privacy toggles
test/
  fixtures/              # saved real-world policy HTML
  *.test.js
```

No build step to start. Use ES modules (`"type": "module"` in the background, `<script type="module">` in the popup) and plain JS. Add a bundler only when a dependency demands it — for a two-panel extension it's mostly ceremony.

---

## 3. The data model

One shape flows through the entire system. Define it once in `lib/schema.js` and validate at every boundary.

```js
// Finding
{
  id:          "data-sharing-3rd-party",   // stable, for dedupe + user prefs
  category:    "data_sharing",             // fixed enum, see below
  severity:    "high" | "medium" | "low" | "good",
  title:       "Personal data sharing",
  description: "Data can be shared with advertising partners.",
  quote:       "We may share your information with our advertising partners...",
  location:    { charStart: 4821, charEnd: 4903 },   // into extracted text
  source:      "rules" | "llm" | "both",
  confidence:  0.0 - 1.0
}

// Analysis
{
  url, hostname, analyzedAt, contentHash,
  riskLevel: "high" | "medium" | "low",
  summary:   "This service collects extensive user data.",
  findings:  [Finding],
  tiers:     { rules: true, llm: true },   // what actually ran
  truncated: false                         // did we drop text to fit the budget?
}
```

Note `severity: "good"` — the mockup's green "Account deletion / Data deletion is available" item. Surfacing *reassuring* findings is what stops the extension from reading as a fearmongering machine, and it's the cheapest credibility win available.

### Categories (fixed enum)

`data_sharing`, `data_selling`, `ai_training`, `content_license`, `auto_renewal`, `arbitration`, `class_action_waiver`, `unilateral_changes`, `tracking_cookies`, `data_retention`, `account_termination`, `liability_limits`, `jurisdiction`, `age_restrictions`, `data_deletion` (often `good`), `data_portability` (often `good`).

Keep this list closed. It is the join key between the rules engine, the LLM output schema, the user's concern preferences, and the UI icons. Open-ended categories from an LLM would break all four.

---

## 4. Phases

### Phase 1 — Detection & extraction (foundation)

Make the extension reliably answer "is there a policy here, and what is its text?"

- **`detect.js`**: score a page on URL patterns (`/terms`, `/privacy`, `/legal`, `/eula`, `/tos`), `<h1>`/`<title>` matching, and legal-phrase density (occurrences per 1000 words of "hereby", "shall", "warranties", "indemnify", "governing law"). Density is the important signal — it's what separates an actual policy from a blog post *about* privacy policies. Require a combined threshold, not any single hit.
- **`extract.js`**: replace `document.body.innerText`. Walk the DOM, drop `nav`, `header`, `footer`, `script`, `style`, `[aria-hidden]`, and cookie banners. Prefer `<main>` / `<article>` / the densest text container. Preserve heading structure — section titles ("Arbitration", "Your Rights") are strong evidence and measurably improve LLM results. Emit `{ sections: [{heading, text, charStart}], fullText }`.
- Also handle policies rendered inside a scrollable `<div>` or `<iframe>` on signup pages — common, and `innerText` on body misses them.
- **Deliverable**: popup shows "Policy detected — 8,400 words, 14 sections" with correct extraction on 10 real sites.

### Phase 2 — Rules engine (first real output)

- Move patterns out of code into `analysis/patterns.json`:

```json
{
  "id": "data-sharing-3rd-party",
  "category": "data_sharing",
  "severity": "high",
  "title": "Personal data sharing",
  "description": "Your information may be shared with third parties.",
  "any": ["share (your |the )?(personal )?(data|information) with",
          "third[- ]part(y|ies)", "affiliates and partners"],
  "not": ["will not share", "do not share", "never share"],
  "confidence": 0.6
}
```

  The `not` list is the part naive keyword matching always gets wrong: "we will never share your data with third parties" trips the third-party rule and reports a privacy *guarantee* as a risk. Negation handling within a ±80-character window is the single biggest quality lever in this phase.
- Every match captures the surrounding sentence as `quote` plus char offsets.
- Cap findings per category (2–3) so one repetitive policy doesn't produce 40 items.
- **Deliverable**: the first mockup's UI — severity dots, category titles, plain-language descriptions — working with zero network calls.

### Phase 3 — LLM enrichment

- **Provider**: default to the Claude API (`claude-sonnet-5` for quality, `claude-haiku-4-5-20251001` for cheap/fast); keep the provider behind an interface in `llm.js` so an OpenAI-compatible endpoint or a local Ollama can drop in.
- **Key handling**: BYO key stored in `browser.storage.local`, entered in the options page. **Be honest in the UI that this key is readable by anything with access to the browser profile**, and recommend a scoped/limited key. A hosted proxy is the correct long-term answer (Phase 6) — don't pretend the BYO model is secure.
- **Chunking**: policies routinely exceed a comfortable single call. Chunk on section boundaries to ~6–8k tokens with 200-token overlap, analyze chunks in parallel (limit ~4 concurrent), then a cheap reduce pass to dedupe and write the summary.
- **Structured output**: use tool-use / JSON schema forcing rather than "reply with JSON" — parse failures on a 12k-word input are expensive to retry. Schema mirrors `Finding` exactly, with `category` as an enum.
- **Prompt**: give it the closed category list, demand a verbatim quote per finding, and explicitly instruct it to report *favorable* terms as `severity: "good"`. Add: "if a clause is standard and unremarkable, omit it" — the failure mode is 30 findings of noise, not too few.
- **`verify.js`**: for every LLM finding, confirm `quote` appears in the extracted text (normalized whitespace, fuzzy to ~90% for minor rewording). Drop findings that fail; count the drops. A hard, mechanical anti-hallucination gate that costs nothing.
- **`merge.js`**: a rules hit and an LLM finding in the same category with overlapping offsets collapse into one item with `source: "both"` and boosted confidence. Prefer the LLM's wording, keep the rules engine's severity floor.
- **Deliverable**: the JSON from mockup 3, rendered.

### Phase 4 — Caching, cost control, pre-agreement warning

- **Cache**: key on `sha256(hostname + normalizedText)` in `storage.local`. Policies change maybe twice a year; the same user hitting the same site should never pay twice. TTL 30 days, LRU-evict at ~5 MB. Expect a high hit rate once a handful of large sites are cached — this is what makes the LLM tier affordable at all.
- **Never auto-call the LLM.** Tier 1 runs automatically; tier 2 requires a click ("Deep analysis") unless the user opts into auto-analysis, and even then only for cache misses. Show an estimated token count/cost before the call.
- **Pre-agreement detection**: on any page, scan for links whose text matches terms/privacy patterns near a checkbox or submit button. If found, offer to fetch and analyze the linked policy in the background (respecting the cache) and show the floating badge from mockup 4 *on the signup page*. Fetching a third-party URL needs `host_permissions` — request it optionally, at the moment of use, via `browser.permissions.request()` rather than up front.

### Phase 5 — Full UI

- **Popup**: risk-level header, count, the concern list, per-item expand to reveal the quote and a "Show on page" button that messages the content script to scroll and `<mark>` it. Filter chips by severity.
- **In-page badge** (mockup 4): a small floating pill, dismissible, remembers dismissal per hostname. Shadow DOM + `all: initial` so host-page CSS can't wreck it.
- **Options / concern preferences** (mockup 5): checkboxes over the category enum. These *filter and re-rank* — a user who doesn't care about analytics shouldn't see analytics findings, and one who checks "AI training" should get it pinned to the top with severity bumped. Feed the selected categories into the LLM prompt too, so attention goes where the user cares.
- Accessibility: real semantics, keyboard nav, `prefers-color-scheme` (the mockups are dark; light mode shouldn't be an afterthought), and never encode severity in color alone — the dots need a shape or text label beside them.

### Phase 6 — Distribution

- Manifest hygiene: `data_collection_permissions` currently declares `["none"]`. **That becomes false the moment the LLM tier ships** — page content leaves the browser. Update it, and put a clear first-run disclosure in front of the first network call. AMO review will look at exactly this.
- A privacy policy for the extension itself (yes, really).
- Optional hosted proxy: removes BYO keys, enables rate limiting and a shared cache across users (one analysis of a major ToS serves everyone). Introduces a server, an abuse surface, and a cost model; only worth it with real usage.
- Chrome port: the code is nearly portable already, but `browser.*` and returning a promise from `onMessage` are Firefox idioms. A `browser = globalThis.browser ?? chrome` shim plus `sendResponse` handling covers most of it. Firefox first, though — MV3 there is friendlier and the audience overlaps with privacy-minded users.

---

## 5. Testing

The thing most likely to sink this project is quality regressions you can't see.

- **Fixture corpus**: save the raw HTML of 20–30 real policies (big tech, SaaS, banks, a couple of deliberately user-friendly ones) into `test/fixtures/`. Never test against the live web — it changes under you.
- **Extraction tests**: assert word count within a range and that known section headings survive.
- **Rules tests**: hand-label the expected findings for ~10 fixtures. Track precision/recall as `patterns.json` grows; a new pattern that raises recall 2% and drops precision 15% is a bad trade and you want to *see* that.
- **Negation regression suite**: a flat file of tricky sentences ("we do not sell your personal information") that must produce zero or `good` findings.
- **LLM tests**: mock the provider by default. Keep a separate, manually-run `test/live/` script for real calls so CI stays free.

---

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Hallucinated clauses that don't exist | Quote-grounding gate in `verify.js`; drop unverifiable findings |
| Sounds like legal advice | Persistent, non-dismissible "not legal advice — informational only" line in the popup footer. Take this seriously; it's the one thing that turns a hobby project into a liability |
| Alarmism (everything is HIGH RISK) | `good` findings; calibrate severity against the fixture corpus; "standard for this type of service" framing on common clauses |
| LLM cost | Cache-first, manual trigger, cheap model for the reduce pass, shared cache in Phase 6 |
| Sending page text to a third party | Explicit opt-in, honest manifest declaration, tier 1 fully offline, visible indicator when text is about to leave the browser |
| Extraction breaks on a redesign | Fixture corpus + graceful degradation to `innerText` when structured extraction yields too little |

---

## 7. Suggested order of work

1. `lib/schema.js` + `lib/storage.js` — the shared vocabulary, first.
2. Phase 1 extraction/detection. **Do not skip to the LLM** — every downstream tier is only as good as the text it receives, and bad extraction looks like a bad model.
3. Phase 2 rules engine + the popup list UI. The first thing worth showing anyone.
4. Fixture corpus + tests, before the rules grow past ~15 patterns.
5. Phase 3 LLM behind a feature flag.
6. Cache, then cost controls, then the signup-page badge.
7. Preferences, polish, AMO submission.

Phases 1–2 alone are a genuinely useful extension. Ship that, then add intelligence.
