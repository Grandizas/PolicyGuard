# Policy Guard — Implementation Plan

A Firefox extension that reads Terms of Service / Privacy Policies and tells you what to be cautious about, **before** you click "I agree".

Status: **Phases 1-3 complete.** Detection, extraction, the rules engine and the AI pass total 50/50 across the fixture corpus, the negation suite and the grounding/merge/chunking suite; `web-ext lint` is clean. Tier 1 runs offline on every policy; tier 2 is opt-in, BYO-key, and every AI finding must cite text that actually appears on the page. Phases 1-2 confirmed working in Firefox; the tier-2 path has not been exercised against the live API.

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
  runner.html            # assertion suite over the fixture corpus
  analysis-suite.js      # grounding / merge / chunking assertions
  negation-cases.json    # sentences that must and must not fire
  popup-preview.html     # the real popup, real extraction, stubbed APIs
  options-preview.html   # the real options page, stubbed storage
  fixtures/
    index.json           # fixture -> original URL + expectations
    *.html               # saved real-world policy HTML
```

Everything exists today except `content/highlight.js` and `content/badge.css`,
which arrive with Phases 4 and 5.

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

### Phase 1 — Detection & extraction (foundation) — **done**

Make the extension reliably answer "is there a policy here, and what is its text?"

- **`detect.js`**: scores a page on URL patterns (`/terms`, `/privacy`, `/legal`, `/eula`, `/tos`), `<h1>`/`<title>` matching, legal-phrase density, and — added after the corpus proved it necessary — how much the text addresses its reader. Caps are URL 25 / title 25 / density 20 / variety 10 / address 20, threshold 45.
- **`extract.js`**: replaces `document.body.innerText`. Drops `nav`, `header`, `footer`, `script`, `style`, form controls and cookie banners; prefers `<main>` / `<article>` / the densest low-link-density container; preserves heading structure. Emits `{ sections, fullText }` with char offsets.
- Same-origin `<iframe>` content is extracted and adopted when it beats the host document — the signup-page case.
- **Delivered**: popup reports "Policy detected — 4,431 words, 15 sections" with the detection breakdown, on a 9-fixture corpus that passes 9/9.

#### Two things the corpus changed

**1. Legalese density does not separate a policy from an article about policies.** The plan assumed it would. It does not: GitHub's ToS scores 7.9 markers per 1000 words and Wikipedia's *article* on privacy policies scores 7.0. With URL and title both matching, that article scored 72/100 and was confidently misclassified.

What does separate them is **voice**. A policy addresses its reader; an encyclopedia article describes policies in the third person. Measured across the corpus, real policies run 45–85 first/second-person pronouns per 1000 words; the Wikipedia article sits at 3.4 and the article on cats at 0.3. That is a 13× gap where density had none.

It is implemented as a **veto, not another summand** — adding 20 more points to a page already scoring 72 changes nothing, so `isPolicy` requires the address density to clear 10 per 1000 regardless of total score.

**2. Hiding markers cannot be blanket exclusions.** Apple's privacy policy keeps its body in `<div class="accordion-panel">` elements marked `aria-hidden="true"` until expanded. Excluding those on sight yielded **239 words out of 22,700** — and nothing about that result looked wrong from the outside. We would have analyzed 8% of the document and reported it clean.

The rule is now size-based: `aria-hidden`, `[hidden]`, `display:none` and `visibility:hidden` elements are dropped only under 400 characters of text. Above that they are collapsed content, not chrome, and the count is surfaced in the popup ("11 collapsed sections were opened up to read the full document"). Apple went 239 → 4,431 words. `opacity: 0` was removed as a hiding signal entirely — scroll-reveal animations leave real content at zero opacity until script runs.

Both failures share a shape worth remembering: **silent under-extraction looks exactly like a clean policy.** That is the argument for the `degraded` flag, the collapsed-section count, and eventually for a word-count sanity check against the page's own text.

#### Still open at the end of Phase 1

- **Not yet loaded in Firefox.** Everything is verified through the fixture harness and `web-ext lint`; nothing has run in a real profile via `about:debugging`. Expect the first real load to surface something — most likely around the event-page background or the `scripting.executeScript` fallback path, neither of which the harness exercises.
- **Cross-origin iframes are counted, not read.** Same-origin frames are extracted and adopted; cross-origin ones are reported to the user as unreadable. Reading them needs `all_frames: true` plus frame-to-frame messaging.
- **The 400-character collapsed-content threshold is a judgement call**, tuned against one accordion layout. It will need revisiting as the corpus grows — a page with hidden translations of its own content would over-extract.

### Phase 2 — Rules engine (first real output) — **done**

27 rules across 14 categories in `analysis/patterns.json`, matched by
`analysis/rules.js`. Runs on every detected policy, no network, no key, no
consent needed. The popup renders the mockup: risk pill, concern count,
severity-labelled findings, plain-language descriptions, and the citation
behind each one.

- Patterns live in `analysis/patterns.json`:

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
- Every match captures the surrounding sentence as `quote` plus char offsets. Quotes are verbatim substrings, and the suite asserts that on every finding — the same gate that will police LLM output in Phase 3.
- Findings are capped at 2 per category, applied after sorting so the cap keeps the strongest items.

#### What the corpus changed, again

**Negation needs morphology, not keywords.** The plan called negation "the single biggest quality lever" and it was right, but underestimated it. Wikimedia's policy says *"Never selling your information or sharing it with third parties for marketing purposes"* — a promise. My `not` list had `never sell`, which does not match `never sell**ing**`. The result was three **high-severity** findings on the most privacy-friendly policy in the corpus. Reporting a guarantee as a risk is worse than missing a risk: it destroys the reason to trust anything else on the list.

Fixing it properly meant a shared `defaultNot` list applied to every non-`good` rule, with unterminated verb stems (`shar` covers share/shares/sharing) and a gap after `not` so *"do not rent or sell"* is caught. Three sentence classes mention a practice without being it, and each was found by running the corpus rather than by reasoning up front:

| Class | Example found in the corpus |
| --- | --- |
| Guarantee | "Never selling your information or sharing it with third parties" |
| Scope disclaimer | "this policy does not address the practices of third parties" |
| User control | "you can disable Personalized Ads by going to Settings" |

**A `[^.]` gap cannot cross an abbreviation.** Patterns pair a verb with an object a few words later, and the obvious way to keep that inside one sentence is `[^.]{0,60}`. It silently fails on *"we share your data with vendors (e.g. payment processors) and other third parties"* — two full stops mid-sentence. Patterns now use a `%GAP%` macro that expands to a sentence-aware character class.

The first attempt at that macro was `\.(?!\s+[A-Z])` — "a full stop not followed by a capital" — which is **inert**, because rules compile with the `i` flag and `[A-Z]` then matches lowercase too. The working version identifies sentence ends without reference to case.

**One "false positive" turned out to be the test being wrong.** After the guarantee sentence was suppressed, `data-sharing-third-parties` re-fired on Wikimedia at *"We disclose Personal Information to our third-party service providers"* — which is true, and which the earlier bug had been masking. The expectation was corrected rather than the rule.

- **Delivered**: mockup 1's UI, zero network calls, 33/33 green.

### Phase 3 — LLM enrichment — **done**

Opt-in, BYO-key, one request per policy. `analysis/llm.js` calls the Messages API, `analysis/verify.js` throws away anything it cannot find on the page, and `analysis/merge.js` reconciles what is left with tier 1.


- **Provider**: default to the Claude API (`claude-sonnet-5` for quality, `claude-haiku-4-5-20251001` for cheap/fast); keep the provider behind an interface in `llm.js` so an OpenAI-compatible endpoint or a local Ollama can drop in.
- **Key handling**: BYO key stored in `browser.storage.local`, entered in the options page. **Be honest in the UI that this key is readable by anything with access to the browser profile**, and recommend a scoped/limited key. A hosted proxy is the correct long-term answer (Phase 6) — don't pretend the BYO model is secure.
- **Chunking**: policies routinely exceed a comfortable single call. Chunk on section boundaries to ~6–8k tokens with 200-token overlap, analyze chunks in parallel (limit ~4 concurrent), then a cheap reduce pass to dedupe and write the summary.
- **Structured output**: use tool-use / JSON schema forcing rather than "reply with JSON" — parse failures on a 12k-word input are expensive to retry. Schema mirrors `Finding` exactly, with `category` as an enum.
- **Prompt**: give it the closed category list, demand a verbatim quote per finding, and explicitly instruct it to report *favorable* terms as `severity: "good"`. Add: "if a clause is standard and unremarkable, omit it" — the failure mode is 30 findings of noise, not too few.
- **`verify.js`**: for every LLM finding, confirm `quote` appears in the extracted text (normalized whitespace, fuzzy to ~90% for minor rewording). Drop findings that fail; count the drops. A hard, mechanical anti-hallucination gate that costs nothing.
- **`merge.js`**: a rules hit and an LLM finding in the same category with overlapping offsets collapse into one item with `source: "both"` and boosted confidence. Prefer the LLM's wording, keep the rules engine's severity floor.
- **Deliverable**: the JSON from mockup 3, rendered.

#### Four things that changed from the plan

**Chunking was solved for the wrong problem.** The plan specified 6-8k-token chunks with 200-token overlap and a reduce pass, written on the assumption that policies would not fit in context. With a 1M-token window they comfortably do: a 12,000-word policy is about 16k tokens. Chunking now triggers only above 200,000 characters, which no fixture in the corpus reaches. The normal path is one request, no overlap cost, no reduce pass, and two fewer ways to fail. The chunking code stays for the genuinely enormous document and is tested, but it is the exception now, not the design.

**The default model is `claude-opus-5`, not Sonnet.** The plan picked Sonnet for quality and Haiku for cost. Model choice is the user's call, not a default to quietly economise on, so the capable model is the default and both cheaper ones are one click away in settings with their real per-policy cost shown.

**Cost is bigger than the plan implied and is stated plainly.** A single deep analysis of a mid-sized policy costs roughly $0.09 on Opus 5, $0.04 on Sonnet 5, $0.02 on Haiku 4.5 — output tokens dominate. An early draft of the settings copy said "well under a cent", which the estimator itself contradicted at $0.07 for a small policy. Both the settings page and the button now quote a figure derived from the same function.

**Structured output, not tool-use.** The plan said to force JSON via tool-use. The current API does this directly with `output_config.format` and a JSON schema, which is simpler and needs no tool round-trip. Constraints the schema cannot express — numeric ranges, array length caps — are enforced when the response is normalised rather than trusted.

#### The grounding gate

Every model finding must quote the document. Verification normalises both sides for case, smart quotes, dashes and whitespace while keeping a character-level index back to the original, so a match yields exact offsets and the quote shown to the reader is the page's own characters rather than the model's copy of them. A quote that is not found verbatim is retried as word-trigram containment; below 90% the finding is discarded, and above it the finding survives flagged as approximate with its confidence reduced.

This is the cheapest useful safety property in the whole project: no extra request, no model judging itself, no prompt engineering. The popup shows the discard count and lists what was thrown away, because a check nobody can see is a check nobody should believe. The suite asserts it directly — a fabricated clause and a plausible paraphrase are both rejected against a real policy.

#### Still open at the end of Phase 3

- **First live request found one thing.** Keys created inside an Anthropic workspace are identity-linked and are rejected until the request says which workspace it acts in, via an `anthropic-workspace-id` header. There is now an optional Workspace ID setting, and that specific API error is rewritten to name the setting rather than the header. The rest of the path — auth, CORS from the extension, the request body — reached the API correctly on the first attempt, and the error surfaced in the popup as intended.
- **The key is stored unencrypted** in extension storage, and the settings page says so rather than implying otherwise. The hosted proxy in Phase 6 is the actual fix.
- **A settings race, found and fixed here**: `updateSettings` was a read-modify-write of one object, so two quick changes clobbered each other — ticking the consent box and changing the model lost the consent. Writes are now serialised through a queue. Worth remembering for any other shared stored object.

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

- `web-ext lint` is clean (0 errors) and runs with `npx --yes web-ext lint --source-dir . --ignore-files "test/**"`. Note `data_collection_permissions` forces `strict_min_version` to 140 — the key did not exist before Firefox 140, and the linter fails the combination.
- Manifest hygiene: `data_collection_permissions` currently declares `["none"]`. **That becomes false the moment the LLM tier ships** — page content leaves the browser. Update it, and put a clear first-run disclosure in front of the first network call. AMO review will look at exactly this.
- A privacy policy for the extension itself (yes, really).
- Optional hosted proxy: removes BYO keys, enables rate limiting and a shared cache across users (one analysis of a major ToS serves everyone). Introduces a server, an abuse surface, and a cost model; only worth it with real usage.
- Chrome port: the code is nearly portable already, but `browser.*` and returning a promise from `onMessage` are Firefox idioms. A `browser = globalThis.browser ?? chrome` shim plus `sendResponse` handling covers most of it. Firefox first, though — MV3 there is friendlier and the audience overlaps with privacy-minded users.

---

## 5. Testing

The thing most likely to sink this project is quality regressions you can't see.

**The harness exists as of Phase 1.** It needs no dependencies and no build step:

```bash
python -m http.server 8765
```

Then open `http://localhost:8765/test/runner.html` for the assertion suite, or `http://localhost:8765/test/popup-preview.html?fixture=apple-privacy.html` to see the real popup rendered against a real extraction. The runner loads each fixture into a `sandbox="allow-same-origin"` iframe — same origin so the DOM is readable, no `allow-scripts` so the fixture's own JavaScript never runs — and passes the recorded original URL to detection, since the fixture itself is served from localhost.

Two caveats to keep in mind when reading results: fixtures are static HTML, so anything a site renders client-side is missing (this is why the Apple accordion bug was visible at all), and their stylesheets load from the original hosts or not at all, so `getComputedStyle` results are approximate.

- **Fixture corpus**: 5 real policies, 3 real negatives, 1 hand-written signup page. Grow toward 20–30, adding banks and deliberately user-friendly policies. Never test against the live web — it changes under you.
- **Hard negatives matter more than positives.** The corpus earns its keep through `neg-wikipedia-privacy` (an article about privacy policies) and `neg-mozilla-home` (marketing copy that says "you" and "we" constantly). Both were misclassified by an approach that looked reasonable on paper.
- **Extraction tests**: assert word count within a range and that known section headings survive.
- **Rules tests**: hand-label the expected findings for ~10 fixtures. Track precision/recall as `patterns.json` grows; a new pattern that raises recall 2% and drops precision 15% is a bad trade and you want to *see* that.
- **Negation regression suite**: `test/negation-cases.json` — 19 hand-written sentences asserting both what must fire and what must not. This is where every negation bug gets locked down; grow it whenever the corpus surfaces a new false positive. Each case also asserts quote grounding.
- **Rule expectations** live beside each fixture in `test/fixtures/index.json` as `mustInclude` / `mustNotInclude`. Not full precision/recall — labelling an 8,000-word policy exhaustively is not honest work — but enough to catch drift, and every locked expectation records a real bug.
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

1. ~~`lib/schema.js` + `lib/storage.js` — the shared vocabulary, first.~~ **Done.**
2. ~~Phase 1 extraction/detection.~~ **Done** — and the warning was justified: two extraction bugs would each have looked like a bad model rather than bad text.
3. ~~Fixture corpus + tests.~~ **Done**, pulled forward from step 4 — Phase 1 could not be called finished without something to verify it against, and the corpus immediately found two real bugs.
4. ~~Phase 2 rules engine + the popup list UI.~~ **Done** — and worth showing someone.
5. ~~Phase 3 LLM behind a feature flag.~~ **Done** — opt-in, off by default, and gated behind an explicit consent tick.
6. Cache, then cost controls, then the signup-page badge.
7. Preferences, polish, AMO submission.

Phases 1–2 alone are a genuinely useful extension. Ship that, then add intelligence.
