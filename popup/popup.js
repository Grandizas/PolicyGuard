/**
 * The popup is a view. It asks the background for the report and renders it --
 * no DOM walking, no network, no analysis.
 */

const view = document.querySelector("#view");
const rescanButton = document.querySelector("#rescan");

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

    if (finding.quote) {
        const details = el("details", "f-quote");

        details.append(el("summary", null, "Show the wording"));
        details.append(el("blockquote", null, finding.quote));
        details.append(el(
            "p",
            "f-meta",
            `rule ${finding.id} · confidence ${finding.confidence.toFixed(2)}`
        ));

        item.append(details);
    }

    return item;
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

    if (findings.length > 0) {
        const list = el("ul", "findings");

        for (const finding of findings) {
            list.append(renderFinding(finding));
        }

        wrap.append(list);
    }

    // Tier 1 is pattern matching. Silence from it is not a clean bill of health,
    // and saying so is the difference between a useful tool and a misleading one.
    wrap.append(el(
        "p",
        "tier-note",
        counts.concerns > 0
            ? "Found by pattern matching. Wording it does not recognise will be missed."
            : "Pattern matching found nothing it recognises. That is not the same as the policy being safe — read it yourself for anything that matters."
    ));

    if (report.ruleStats && report.ruleStats.hiddenByPreferences > 0) {
        wrap.append(el(
            "p",
            "tier-note",
            `${report.ruleStats.hiddenByPreferences} finding(s) hidden by your concern preferences.`
        ));
    }

    return wrap;
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

function renderPolicyLinks(links) {
    const details = el("details");

    details.open = links.some((link) => link.nearAgreement);
    details.append(el("summary", null, `Policy links on this page (${links.length})`));

    const list = el("ul", "links");

    for (const link of links.slice(0, 12)) {
        const item = el("li");
        const label = el("div", null, link.text);

        if (link.nearAgreement) {
            label.append(el("span", "flag", "beside an agree control"));
        }

        item.append(label);
        item.append(el("div", "kind", DOC_TYPE_LABELS[link.kind] ?? link.kind));

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
            view.append(renderPolicyLinks(report.policyLinks));
        }

        view.append(renderPageDetails(report));
    }

    rescanButton.hidden = false;
}

async function load(force) {
    view.replaceChildren(el("p", "muted", "Scanning this page…"));

    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
        view.replaceChildren(el("p", "muted", "No active tab."));
        return;
    }

    try {
        const report = await browser.runtime.sendMessage({
            type: force ? "RESCAN" : "GET_REPORT",
            tabId: tab.id
        });

        renderReport(report);
    } catch (error) {
        view.replaceChildren(el("p", "muted", `Could not scan this page: ${error.message}`));
    }
}

rescanButton.addEventListener("click", () => load(true));

load(false);
