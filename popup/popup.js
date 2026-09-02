/**
 * The popup is a view. It asks the background for the report and renders it --
 * no DOM walking, no network, no analysis.
 */

import { API_ORIGIN } from "../analysis/llm.js";

const view = document.querySelector("#view");
const rescanButton = document.querySelector("#rescan");

/** Tab whose report is on screen, so polling knows what to re-read. */
let currentTabId = null;
let pollTimer = null;

/** Severity filter. Empty means show everything. */
let severityFilter = null;

const DOC_TYPE_LABELS = {
    privacy_policy: "Privacy policy",
    terms: "Terms of service",
    cookie_policy: "Cookie policy",
    eula: "Licence agreement",
    acceptable_use: "Acceptable use policy",
    unknown: "Legal document"
};

const EXTRACTION_LABELS = {
    semantic: "main/article element",
    density: "densest text block",
    body: "whole page body",
    innertext: "rendered text (fallback)"
};

const SEVERITY_LABELS = {
    high: "High",
    medium: "Medium",
    low: "Low",
    good: "In your favour"
};

const RISK_LABELS = {
    high: "High risk",
    medium: "Medium risk",
    low: "Low risk"
};

function el(tag, className, text) {
    const node = document.createElement(tag);

    if (className) {
        node.className = className;
    }

    if (text !== undefined) {
        node.textContent = text;
    }

    return node;
}

function formatNumber(value) {
    return value.toLocaleString();
}

function methodLabel(method) {
    if (method.startsWith("iframe:")) {
        return "embedded frame";
    }

    return EXTRACTION_LABELS[method] ?? method;
}

/* ---------------------------------------------------------------- findings */

function renderFinding(finding) {
    const item = el("li", "finding");

    const head = el("div", "f-head");

    head.append(el("span", "dot sev-" + finding.severity));
    head.append(el("span", "f-title", finding.title));

    // Severity is never carried by colour alone.
    head.append(el("span", "chip sev-" + finding.severity, SEVERITY_LABELS[finding.severity]));

    item.append(head);
    item.append(el("p", "f-desc", finding.description));

    if (finding.source !== "rules") {
        head.append(el("span", "src", finding.source === "both" ? "AI + rules" : "AI"));
    }

    if (finding.quote) {
        const details = el("details", "f-quote");

        details.append(el("summary", null, "Show the wording"));
        details.append(el("blockquote", null, finding.quote));

        if (finding.quoteApproximate) {
            details.append(el(
                "p",
                "f-meta",
                "The wording was matched approximately, so this quote may differ slightly from the page."
            ));
        }

        const actions = el("div", "f-actions");
        const show = el("button", "linkish", "Show on page");
        const outcome = el("span", "f-meta");

        show.addEventListener("click", async () => {
            outcome.textContent = "";

            const result = await browser.runtime.sendMessage({
                type: "HIGHLIGHT",
                tabId: currentTabId,
                quote: finding.quote
            });

            if (!result || !result.found) {
                // Usually means the clause is behind a collapsed section, which
                // is worth saying rather than failing silently.
                outcome.textContent = "Could not find that wording on the page.";
            } else if (result.partial) {
                outcome.textContent = "Jumped to the start of it.";
            }
        });

        actions.append(show, outcome);
        details.append(actions);

        details.append(el(
            "p",
            "f-meta",
            `${finding.id} · confidence ${finding.confidence.toFixed(2)}`
        ));

        item.append(details);
    }

    return item;
}

/**
 * Severity filter. Only offered when there is enough to filter -- three chips
 * over four findings is clutter, not a feature.
 */
function renderFilters(findings) {
    const present = ["high", "medium", "low", "good"]
        .filter((sev) => findings.some((f) => f.severity === sev));

    if (findings.length < 5 || present.length < 2) {
        return null;
    }

    const bar = el("div", "filters");

    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Filter findings by severity");

    const makeChip = (value, label) => {
        const active = severityFilter === value;
        const chip = el("button", "filter-chip" + (active ? " active" : ""), label);

        chip.setAttribute("aria-pressed", String(active));
        chip.addEventListener("click", () => {
            severityFilter = active ? null : value;
            load(false, true);
        });

        return chip;
    };

    bar.append(makeChip(null, "All"));

    for (const sev of present) {
        const count = findings.filter((f) => f.severity === sev).length;

        bar.append(makeChip(sev, `${SEVERITY_LABELS[sev]} (${count})`));
    }

    return bar;
}

function renderFindings(report) {
    const findings = report.analysis.findings;
    const counts = report.counts;
    const wrap = document.createDocumentFragment();

    if (counts.concerns > 0) {
        const header = el("div", "risk-head");

        header.append(el(
            "span",
            "risk-pill risk-" + report.analysis.riskLevel,
            RISK_LABELS[report.analysis.riskLevel]
        ));

        header.append(el(
            "span",
            "concern-count",
            counts.concerns === 1 ? "1 concern found" : `${counts.concerns} concerns found`
        ));

        wrap.append(header);
    } else {
        wrap.append(el("p", "verdict-clear", "No concerns matched"));
    }

    const filters = renderFilters(findings);

    if (filters) {
        wrap.append(filters);
    }

    const visible = severityFilter
        ? findings.filter((f) => f.severity === severityFilter)
        : findings;

    if (visible.length > 0) {
        const list = el("ul", "findings");

        for (const finding of visible) {
            list.append(renderFinding(finding));
        }

        wrap.append(list);
    }

    // Silence from either tier is not a clean bill of health, and saying so is
    // the difference between a useful tool and a misleading one.
    const ranLlm = report.analysis.tiers.llm;

    let note;

    if (counts.concerns > 0) {
        note = ranLlm
            ? "Read by pattern matching and AI. Both can miss things, and neither is a lawyer."
            : "Found by pattern matching. Wording it does not recognise will be missed.";
    } else {
        note = ranLlm
            ? "Neither pass found anything notable. That is not a guarantee — read it yourself for anything that matters."
            : "Pattern matching found nothing it recognises. That is not the same as the policy being safe — read it yourself for anything that matters.";
    }

    wrap.append(el("p", "tier-note", note));

    if (report.ruleStats && report.ruleStats.hiddenByPreferences > 0) {
        wrap.append(el(
            "p",
            "tier-note",
            `${report.ruleStats.hiddenByPreferences} finding(s) hidden by your concern preferences.`
        ));
    }

    return wrap;
}

/* ----------------------------------------------------------- deep analysis */

function formatUsd(value) {
    return value < 0.01 ? "<$0.01" : "$" + value.toFixed(2);
}

function renderDeepStats(stats) {
    const details = el("details", "deep-stats");

    details.append(el("summary", null, "What the AI pass did"));

    const wrap = el("div", "signals");

    const rows = [
        ["Quotes checked", String(stats.quotesChecked)],
        ["Verified against the page", String(stats.quotesExact + stats.quotesFuzzy)],
        ["Discarded as unfindable", String(stats.quotesDropped)],
        ["Agreed with pattern matching", String(stats.agreements)],
        ["Model", stats.model],
        ["Requests", String(stats.usage.requests)]
    ];

    if (stats.usage.cacheReadTokens > 0) {
        rows.push(["Cached input tokens", formatNumber(stats.usage.cacheReadTokens)]);
    }

    for (const [label, value] of rows) {
        const row = el("div");

        row.append(el("span", null, label), el("b", null, value));
        wrap.append(row);
    }

    details.append(wrap);

    // Showing what was thrown away is the point: it is evidence the check runs.
    if (stats.dropped && stats.dropped.length > 0) {
        details.append(el(
            "p",
            "f-meta",
            "Discarded because their wording could not be found on the page:"
        ));

        const list = el("ul", "dropped");

        for (const item of stats.dropped.slice(0, 5)) {
            list.append(el("li", null, `${item.title} — "${item.quote.slice(0, 70)}…"`));
        }

        details.append(list);
    }

    return details;
}

function renderDeep(report) {
    const deep = report.deep;

    if (!deep) {
        return null;
    }

    const box = el("div", "deep");

    if (deep.status === "running") {
        const progress = deep.progress;
        const label = progress && progress.chunks > 1
            ? `Reading part ${progress.chunk} of ${progress.chunks}…`
            : "Reading the policy…";

        box.append(el("p", "deep-status", label));
        box.append(el("p", "f-meta", "This can take up to a minute. You can close this popup."));

        return box;
    }

    if (deep.status === "error") {
        box.append(el("p", "deep-error", deep.error));
        box.append(makeDeepButton(report, "Try again"));

        return box;
    }

    if (deep.status === "done") {
        if (deep.cached) {
            const when = deep.cachedAt
                ? new Date(deep.cachedAt).toLocaleDateString()
                : null;

            box.append(el(
                "p",
                "f-meta",
                when
                    ? `Loaded from the cache, analysed ${when}. No request was made.`
                    : "Loaded from the cache. No request was made."
            ));
        }

        if (deep.stats) {
            box.append(renderDeepStats(deep.stats));
        }

        box.append(makeDeepButton(report, "Run AI analysis again"));

        return box;
    }

    if (!deep.available) {
        if (deep.blockedReason) {
            const line = el("p", "deep-offer", deep.blockedReason);
            const link = el("button", "linkish", "Open settings");

            link.addEventListener("click", () => browser.runtime.openOptionsPage());
            line.append(" ");
            line.append(link);
            box.append(line);
        }

        return box.childNodes.length > 0 ? box : null;
    }

    const estimate = deep.estimate;

    // A cache hit costs nothing, so offering it as a purchase would be a lie.
    if (deep.cached) {
        box.append(makeDeepButton(report, "Show AI analysis"));
        box.append(el(
            "p",
            "f-meta",
            "Already analysed. Loads from the cache with no request and no cost."
        ));

        return box;
    }

    box.append(makeDeepButton(report, "Run AI analysis"));

    if (estimate) {
        box.append(el(
            "p",
            "f-meta",
            `Sends this page's text to Anthropic. About ${formatNumber(estimate.inputTokens)} ` +
            `input tokens, roughly ${formatUsd(estimate.usd)}.`
        ));
    }

    return box;
}

function makeDeepButton(report, label) {
    const button = el("button", "primary", label);

    button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Starting…";

        // permissions.request() only works inside a user gesture, so it has to
        // happen here rather than in the background script.
        if (report.deep.needsPermission) {
            try {
                const granted = await browser.permissions.request({ origins: [API_ORIGIN] });

                if (!granted) {
                    button.disabled = false;
                    button.textContent = label;
                    return;
                }
            } catch (error) {
                button.disabled = false;
                button.textContent = label;
                return;
            }
        }

        await browser.runtime.sendMessage({ type: "DEEP_ANALYZE", tabId: currentTabId });
        startPolling();
        load(false);
    });

    return button;
}

/* ------------------------------------------------------------ page details */

function renderStats(extraction) {
    const stats = el("div", "stats");

    const items = [
        [formatNumber(extraction.wordCount), "words"],
        [formatNumber(extraction.sectionCount), "sections"],
        [formatNumber(extraction.blockCount), "blocks"]
    ];

    for (const [value, label] of items) {
        const stat = el("div", "stat");

        stat.append(el("b", null, value), el("span", null, label));
        stats.append(stat);
    }

    return stats;
}

function renderSections(extraction) {
    const details = el("details");

    details.append(el("summary", null, `Sections (${extraction.sectionCount})`));

    const list = el("ol", "sections");

    for (const section of extraction.sections) {
        const item = el("li");

        item.append(document.createTextNode(section.heading ?? "(untitled)"));
        item.append(el("span", "wc", ` — ${formatNumber(section.wordCount)} words`));

        list.append(item);
    }

    details.append(list);

    return details;
}

function renderSignals(detection, extraction) {
    const details = el("details");

    details.append(el("summary", null, `Detection score ${detection.score}/100`));

    const wrap = el("div", "signals");

    const rows = [
        ["URL match", `${Math.round(detection.signals.url.score)}`],
        ["Title match", `${Math.round(detection.signals.title.score)}`],
        ["Legalese density", `${detection.signals.density.per1000} / 1000 words`],
        ["Distinct markers", `${detection.signals.density.distinct}`],
        ["Addresses the reader", `${detection.signals.address.per1000} / 1000 words`],
        ["Extracted from", methodLabel(extraction.method)]
    ];

    for (const [label, value] of rows) {
        const row = el("div");

        row.append(el("span", null, label), el("b", null, value));
        wrap.append(row);
    }

    details.append(wrap);

    return details;
}

function renderPreview(preview) {
    const details = el("details");

    details.append(el("summary", null, "Extracted text preview"));
    details.append(el("pre", "preview", preview + "…"));

    return details;
}

function renderPageDetails(report) {
    const { detection, extraction } = report.analysis;
    const outer = el("details", "page-details");

    outer.append(el("summary", null, "Page details"));

    outer.append(renderStats(extraction));

    if (extraction.degraded) {
        outer.append(el(
            "p",
            "notice",
            "Structured extraction came up short, so the text is a rough fallback. Findings from this page are less reliable."
        ));
    }

    if (extraction.collapsedSections > 0) {
        outer.append(el(
            "p",
            "notice",
            `${extraction.collapsedSections} collapsed section(s) were opened up to read the full document.`
        ));
    }

    if (extraction.unreadableFrames > 0) {
        outer.append(el(
            "p",
            "notice",
            `${extraction.unreadableFrames} embedded frame(s) could not be read from this page.`
        ));
    }

    if (extraction.sectionCount > 0) {
        outer.append(renderSections(extraction));
    }

    if (report.preview) {
        outer.append(renderPreview(report.preview));
    }

    outer.append(renderSignals(detection, extraction));

    return outer;
}

/* ------------------------------------------------------------ policy links */

function renderLinkedResult(state) {
    if (state.status === "running") {
        return el("p", "f-meta", "Reading it…");
    }

    if (state.status === "error") {
        return el("p", "deep-error", state.error);
    }

    if (state.status !== "done") {
        return null;
    }

    if (!state.isPolicy) {
        return el("p", "f-meta", "That link did not lead to a readable policy.");
    }

    const wrap = document.createDocumentFragment();
    const head = el("div", "risk-head");

    head.append(el("span", "risk-pill risk-" + state.riskLevel, RISK_LABELS[state.riskLevel]));
    head.append(el(
        "span",
        "concern-count",
        state.counts.concerns === 1 ? "1 concern" : `${state.counts.concerns} concerns`
    ));

    wrap.append(head);

    if (state.findings.length > 0) {
        const list = el("ul", "findings");

        for (const finding of state.findings) {
            list.append(renderFinding(finding));
        }

        wrap.append(list);
    }

    wrap.append(el("p", "f-meta", `${formatNumber(state.wordCount)} words read without opening the page.`));

    return wrap;
}

/**
 * The signup-page case: the policy is one click away behind a checkbox, and
 * this is the moment it is worth reading. Checking it fetches the document
 * directly rather than navigating, so the form the user is filling in is
 * never disturbed.
 */
function renderPolicyLinks(report) {
    const links = report.policyLinks;
    const linked = report.linked ?? {};

    const details = el("details");
    const beside = links.filter((link) => link.nearAgreement);

    details.open = beside.length > 0;
    details.append(el(
        "summary",
        null,
        beside.length > 0
            ? `Policies you are about to agree to (${beside.length})`
            : `Policy links on this page (${links.length})`
    ));

    if (beside.length > 0) {
        details.append(el(
            "p",
            "f-meta",
            "These sit next to an agree control on this page."
        ));
    }

    const list = el("ul", "links");
    const shown = beside.length > 0 ? beside : links.slice(0, 8);

    for (const link of shown) {
        const item = el("li");
        const label = el("div", null, link.text);

        if (link.nearAgreement) {
            label.append(el("span", "flag", "beside an agree control"));
        }

        item.append(label);
        item.append(el("div", "kind", DOC_TYPE_LABELS[link.kind] ?? link.kind));

        const state = linked[link.href];

        if (state) {
            const rendered = renderLinkedResult(state);

            if (rendered) {
                item.append(rendered);
            }
        }

        if (!state || state.status === "error") {
            const button = el("button", "primary small", state ? "Try again" : "Check this policy");

            button.addEventListener("click", async () => {
                button.disabled = true;
                button.textContent = "Starting…";

                // Reading another site needs its own host permission, and the
                // request has to happen inside this click to be allowed.
                let origin;

                try {
                    origin = new URL(link.href).origin + "/*";
                } catch (error) {
                    return;
                }

                try {
                    const granted = await browser.permissions.request({ origins: [origin] });

                    if (!granted) {
                        button.disabled = false;
                        button.textContent = "Check this policy";
                        return;
                    }
                } catch (error) {
                    button.disabled = false;
                    button.textContent = "Check this policy";
                    return;
                }

                await browser.runtime.sendMessage({
                    type: "CHECK_LINK",
                    tabId: currentTabId,
                    href: link.href
                });

                startPolling();
                load(false, true);
            });

            item.append(button);
        }

        list.append(item);
    }

    details.append(list);

    return details;
}

/* ------------------------------------------------------------------ render */

function renderReport(report) {
    view.replaceChildren();

    if (!report.supported) {
        view.append(el("p", "muted", report.reason));
        return;
    }

    const { detection } = report.analysis;

    if (detection.isPolicy) {
        const verdict = el("p", "verdict");

        verdict.append(el("strong", null, "Policy detected"));
        verdict.append(el("span", "doc-type", DOC_TYPE_LABELS[detection.docType]));
        view.append(verdict);

        view.append(renderFindings(report));

        const deep = renderDeep(report);

        if (deep) {
            view.append(deep);
        }

        view.append(renderPageDetails(report));
    } else {
        view.append(el("p", "verdict", "No policy on this page"));

        let why = "Nothing on this page reads like a terms or privacy document.";

        if (detection.impersonal && detection.score >= detection.threshold) {
            why = "This page discusses policies but never addresses you directly, so it reads as writing about policies rather than a policy you are agreeing to.";
        } else if (detection.tooShort && detection.score >= detection.threshold) {
            why = "Legal wording is present, but there is not enough text here to be the full document.";
        }

        view.append(el("p", "muted", why));

        if (report.policyLinks.length > 0) {
            view.append(renderPolicyLinks(report));
        }

        view.append(renderPageDetails(report));
    }

    rescanButton.hidden = false;
}

/**
 * The deep pass runs in the background and outlives this popup, so the popup
 * polls rather than holding the job. Polling stops as soon as it is not needed.
 */
function startPolling() {
    if (pollTimer) {
        return;
    }

    pollTimer = setInterval(() => load(false, true), 1500);
}

function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
}

async function load(force, quiet) {
    if (!quiet) {
        view.replaceChildren(el("p", "muted", "Scanning this page…"));
    }

    if (currentTabId === null) {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

        if (!tab) {
            view.replaceChildren(el("p", "muted", "No active tab."));
            return;
        }

        currentTabId = tab.id;
    }

    try {
        const report = await browser.runtime.sendMessage({
            type: force ? "RESCAN" : "GET_REPORT",
            tabId: currentTabId
        });

        renderReport(report);

        const linkedRunning = Object.values(report.linked ?? {})
            .some((state) => state.status === "running");

        if ((report.deep && report.deep.status === "running") || linkedRunning) {
            startPolling();
        } else {
            stopPolling();
        }
    } catch (error) {
        stopPolling();
        view.replaceChildren(el("p", "muted", `Could not scan this page: ${error.message}`));
    }
}

rescanButton.addEventListener("click", () => load(true, false));

load(false, false);
