# Policy Guard — Implementation Plan

A Firefox extension that reads Terms of Service / Privacy Policies and tells you what to be cautious about, **before** you click "I agree".

Status: **All six phases complete.** 69/69 across six suites; `web-ext lint` is clean; the extension packages to a 72 KB zip and is working in Firefox. Tier 1 runs offline on every policy; tier 2 is opt-in, BYO-key, cached, and every AI finding must cite text that actually appears on the page. What remains is the AMO submission itself, which is an account and a listing rather than code.

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
  highlight.js           # find a quoted clause and scroll to it
  badge.js               # in-page panel, shadow DOM
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
welcome/
  welcome.html/.css/.js  # first run: what it does, where the two surfaces are
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

Everything in this layout exists today; `content/badge.js` replaced the planned
`badge.css` (its styles live inside the shadow root).

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

### Phase 4 — Caching, cost control, pre-agreement warning — **done**

`lib/cache.js` keys AI results by content hash, model and concern set; the popup offers "Show AI analysis" instead of a price when a result is already cached. Policies linked from a signup form can be checked in place.


- **Cache**: key on `sha256(hostname + normalizedText)` in `storage.local`. Policies change maybe twice a year; the same user hitting the same site should never pay twice. TTL 30 days, LRU-evict at ~5 MB. Expect a high hit rate once a handful of large sites are cached — this is what makes the LLM tier affordable at all.
- **Never auto-call the LLM.** Tier 1 runs automatically; tier 2 requires a click ("Deep analysis") unless the user opts into auto-analysis, and even then only for cache misses. Show an estimated token count/cost before the call.
- **Pre-agreement detection**: on any page, scan for links whose text matches terms/privacy patterns near a checkbox or submit button. If found, offer to fetch and analyze the linked policy in the background (respecting the cache) and show the floating badge from mockup 4 *on the signup page*. Fetching a third-party URL needs `host_permissions` — request it optionally, at the moment of use, via `browser.permissions.request()` rather than up front.

#### How the pre-agreement check ended up working

The plan left the mechanism open. The obvious options were to open the policy in a background tab (real rendering, but a visible tab and every tracker on the page fires) or to fetch and parse the HTML directly. Fetching won on privacy: `credentials: "omit"` sends no cookies, and `DOMParser` runs no scripts and loads no subresources, so the site cannot tell the policy was read.

The catch is that a `DOMParser` document has no layout, so `getComputedStyle` is unavailable and visibility filtering is skipped. That turned out not to matter — across all five real policies the fetched read recovers **100%** of the words the rendered read finds, Apple's collapsed accordions included, because those are hidden structurally rather than by CSS. The path is flagged `unrendered` regardless, since a site that hides content only with CSS would over-extract.

Parsing happens in the content script rather than the background, because that is where a DOM and the extraction code already are. The alternative was converting the content scripts to ES modules so the background could import them — a refactor with real breakage risk against a working extension, for no gain.

#### Cache design

Keyed on `contentHash | model | concerns`. All three belong in the key: a Haiku reading should not be served to someone who has since switched to Opus, and the concern list changes what the model is asked to look for. Concerns are sorted first so reordering preferences is not a spurious miss.

Only the tier-2 half is cached. Rule findings are recomputed on every view, so editing `patterns.json` can never be masked by a stale entry — and tier 1 is fast enough that caching it would buy nothing.

Eviction is expiry first (30 days), then least-recently-used down to 5 MB. `selectEvictions` is pure and tested; the storage wrapper around it is not, which is the right split.

#### Still open at the end of Phase 4

- **The in-page badge is still Phase 5.** The pre-agreement check currently lives in the popup, so it only helps someone who thinks to open it. The mockup-4 floating badge is what makes it work unprompted, and that is the remaining half of this idea.
- **Nothing prompts a check automatically.** Detection of an agreement-adjacent policy link is passive. Auto-fetching on page load would be faster but would mean reaching out to third-party sites without being asked, which needs its own consent decision.
- **`*://*/*` is now an optional host permission**, so any specific origin can be requested at the moment a user asks for it. Firefox shows that prompt per site; nothing is granted up front.

### Phase 5 — Full UI — **done**

`content/highlight.js` takes the reader to the cited clause; `content/badge.js` puts the summary on the page itself. Severity filter chips, preference re-ranking and a keyboard/focus pass round it out.


- **Popup**: risk-level header, count, the concern list, per-item expand to reveal the quote and a "Show on page" button that messages the content script to scroll and `<mark>` it. Filter chips by severity.
- **In-page badge** (mockup 4): a small floating pill, dismissible, remembers dismissal per hostname. Shadow DOM + `all: initial` so host-page CSS can't wreck it.
- **Options / concern preferences** (mockup 5): checkboxes over the category enum. These *filter and re-rank* — a user who doesn't care about analytics shouldn't see analytics findings, and one who checks "AI training" should get it pinned to the top with severity bumped. Feed the selected categories into the LLM prompt too, so attention goes where the user cares.
- Accessibility: real semantics, keyboard nav, `prefers-color-scheme` (the mockups are dark; light mode shouldn't be an afterthought), and never encode severity in color alone — the dots need a shape or text label beside them.

#### Show on page

Findings carry char offsets into the extracted text, but highlighting does not use them — it searches the live DOM for the quote instead. Offsets go stale the moment the page changes, and the extracted text is not the DOM; searching is both simpler and more robust. The page's text nodes are normalised the same way quotes are (case, smart quotes, dashes, whitespace) with an index back to each node, so a match becomes a real `Range`.

Nothing is rewritten. The match is shown as an actual selection plus a temporary outline on the containing block, both of which undo cleanly — wrapping text in `<mark>` would mean mutating a document someone is in the middle of reading. If the exact wording is not found, the opening 60 characters are tried, and the popup says it jumped to the start rather than pretending.

Measured across the corpus: **30 of 30 findings locate**, and the fabricated quote locates nowhere. One selection out of thirty differs from its quote by two whitespace characters where an inline element sits mid-sentence; it still lands on the right clause.

#### The on-page panel

Lives in a closed shadow root with `all: initial`. This runs on arbitrary sites, so the host page's CSS must not be able to reshape it and ours must not leak out — verified against a fixture whose own stylesheet mangles the surrounding page while the panel renders untouched.

Two forms: a summary on a policy page, and the pre-agreement warning on a form. The second is what Phase 4 was missing — the check existed but only helped someone who thought to open the popup.

**Cost of running on every page.** Full extraction is 100ms+ on a large document, which is not a price worth paying on every page load just in case. A near-free gate runs first — URL, `<title>` and `<h1>` only — and real policies almost always announce themselves in one of those. The signup case is gated on a cheap `querySelector` for a form control before any anchor walking.

**A permission the badge cannot request.** `browser.permissions.request()` is not available to content scripts, so the panel's "Read it" button cannot ask for host access the way the popup can. Rather than have the button fail, settings now carry one explicit opt-in for reading linked policies across sites. Without it the panel still raises the warning and points at the toolbar, which asks per site.

#### Discovery: the panel should not depend on the toolbar

Testing on a real page surfaced a gap the harness could never show. The panel said *"3 more in the toolbar popup"* — which assumes the reader knows there is a toolbar button, knows which icon it is, and that Firefox has it pinned rather than tucked inside the puzzle-piece menu. For a new user that line is a dead end.

Pointing harder at the toolbar would have been the wrong fix. Two changes instead:

**The panel is now sufficient on its own.** *Show all N* expands it in place to every finding, each with its quote and a *Show on page* link that scrolls the page to that sentence. Nothing about the analysis is toolbar-only any more; the button is a second route to the same thing, not the way to see the rest. The toolbar is mentioned once, as a fact rather than an instruction.

**A first-run page explains both surfaces once.** `browser.runtime.onInstalled` opens `welcome/` on install, covering what runs automatically, what the panel is, where the toolbar icon lives, and how to pin it. Without it the first thing a new user sees is a panel appearing unannounced on a page.

The general lesson: a feature discovered only by people who already know the product exists is not really shipped. That is not visible from tests — it needed someone opening the extension for the first time.

#### Two bugs found by using it on a real dev server

**The panel could not be closed.** `remove()` deleted the DOM node and nulled the shadow root, but every link-check result calls `showAgreementPrompt` again, which calls `ensureRoot()` and rebuilds it. On a form with two policies there are four such messages in flight, so pressing close was followed almost immediately by the panel returning. Dismissal is now a flag that outlives the node: once set, both render entry points are no-ops for the rest of the page's life.

It only reproduced on a page where a link check was running, which is why it looked like "closeable on Meta's terms, not on my app".

**Settings had no permanent entry point.** The popup only offered a settings link while deep analysis was *unconfigured*, as part of the "you need a key" message. Finishing setup therefore removed the only way back into settings from the toolbar — the on-page panel had a Settings link, the popup did not. It is now a button in the popup header alongside Rescan, visible in every state.

**The panel appeared on a home page.** `nearAgreementControl` treated *being inside a `<form>`* as evidence of agreement. An ordinary app home page has a search form, a newsletter form, and footer links to Terms and Privacy — enough to satisfy that, with nobody agreeing to anything. Being inside a form is not consent; agreement now has to be *stated*, matched against a broadened phrase list. `neg-app-home.html` is the regression fixture, and it is a hand-written home page rather than a captured one so the shape is unambiguous.

Dismissal is also keyed on `location.host` rather than `hostname`, so `localhost:4200` and `localhost:3000` are no longer the same site.

#### Still open at the end of Phase 5

- **Auto-analysis is tier 1 only.** The panel never triggers a paid AI call on its own, and should not — but that means the on-page summary is always the rougher read.
- **Dismissal is permanent per host** and only resettable by clearing extension storage. A "show these again" control belongs in settings.
- **The agreement heuristic now errs toward silence.** A signup form that puts a bare "Terms" link beside a checkbox with no agreement wording will be missed. That is the right side to err on for something that appears uninvited, but it is a real gap.
- **The panel has not been tried on a hostile layout** — a site with its own fixed bottom-right element will collide with it. Nothing breaks, but it may overlap.

### Phase 6 — Distribution — **done, up to submission**

Icons, manifest metadata, a privacy policy, a README, and npm scripts for lint/build/run. The package builds clean and contains only what should ship.


- `web-ext lint` is clean (0 errors) and runs with `npx --yes web-ext lint --source-dir . --ignore-files "test/**"`. Note `data_collection_permissions` forces `strict_min_version` to 140 — the key did not exist before Firefox 140, and the linter fails the combination.
- Manifest hygiene: `data_collection_permissions` currently declares `["none"]`. **That becomes false the moment the LLM tier ships** — page content leaves the browser. Update it, and put a clear first-run disclosure in front of the first network call. AMO review will look at exactly this.
- A privacy policy for the extension itself (yes, really).
- Optional hosted proxy: removes BYO keys, enables rate limiting and a shared cache across users (one analysis of a major ToS serves everyone). Introduces a server, an abuse surface, and a cost model; only worth it with real usage.
- Chrome port: the code is nearly portable already, but `browser.*` and returning a promise from `onMessage` are Firefox idioms. A `browser = globalThis.browser ?? chrome` shim plus `sendResponse` handling covers most of it. Firefox first, though — MV3 there is friendlier and the audience overlaps with privacy-minded users.

---

#### What shipping actually needed

**An icon, which had simply been forgotten.** Five phases in, the extension had no `icons` key and no `action.default_icon` — the toolbar button was a generic puzzle piece, which is part of why it was hard to find in the first place. One flat SVG covers every size; detail is deliberately coarse because 16px in a toolbar is where the icon has to work, and anything finer turns to mush.

**Checking what goes in the box.** The build is 72 KB and 34 entries. Without an ignore list it would also have carried `test/fixtures/` — 2.8 MB of other companies' saved web pages, which is both wasteful and a strange thing to redistribute. The `webExt.ignoreFiles` list in `package.json` keeps tests, docs and tooling out, and the contents are asserted rather than assumed.

**A privacy policy that is short because the extension does little.** `PRIVACY.md` states what runs locally, the exact two destinations anything is ever sent to, a table of what is stored and for how long, and the plain admission that the API key is not encrypted. AMO reviewers will read this against the manifest, so it names the same optional permissions the manifest declares.

#### Deliberately not done

- **No hosted proxy.** It would remove BYO keys and allow a shared cache across users — one analysis of a major ToS serving everyone — but it means running a server, an abuse surface, and someone else's bill. Not worth it before there are users.
- **No Chrome port.** The code is close: `browser.*` and returning a promise from `onMessage` are the Firefox idioms, and a `globalThis.browser ?? chrome` shim plus `sendResponse` handling covers most of it. But MV3 background pages differ (`service_worker` versus event page), and Firefox-first was the right call for an audience that cares about this.
- **No AMO submission.** That needs a developer account, listing copy, screenshots and a review cycle — decisions for the author, not the code.

#### Submission checklist

1. `npm run lint` — must be 0 errors (one Android-only warning is expected and is a `strict_min_version` artefact).
2. `npm run build` — produces `web-ext-artifacts/policy_guard-<version>.zip`.
3. Confirm the archive has no `test/`, `node_modules/` or docs.
4. Paste `PRIVACY.md` into the AMO privacy-policy field (it takes text; no hosting needed).
5. Select **MIT** as the licence, matching `LICENSE` in the repository.
6. In the listing, state plainly that AI analysis is optional, off by default, and uses the user's own API key.
7. Declare data collection to match `data_collection_permissions`: none required, `websiteContent` optional.
8. Note for reviewers: no build step — the submitted source is the code that runs.

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
6. ~~Cache, then cost controls, then the signup-page check.~~ **Done** — the badge itself is Phase 5.
7. ~~Preferences, polish, packaging.~~ **Done.** The AMO submission itself is what remains.

Phases 1–2 alone are a genuinely useful extension. Ship that, then add intelligence.
