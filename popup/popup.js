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

function renderReport(report) {
    view.replaceChildren();

    if (!report.supported) {
        view.append(el("p", "muted", report.reason));
        return;
    }

    const { detection, extraction } = report.analysis;

    const verdict = el("p", "verdict");

    if (detection.isPolicy) {
        verdict.append(el("strong", null, "Policy detected"));
        verdict.append(el("span", "doc-type", DOC_TYPE_LABELS[detection.docType]));
    } else {
        verdict.append(el("strong", null, "No policy on this page"));
    }

    view.append(verdict);

    if (detection.isPolicy) {
        view.append(renderStats(extraction));

        if (extraction.degraded) {
            view.append(el(
                "p",
                "notice",
                "Structured extraction came up short, so the text below is a rough fallback. Findings from this page will be less reliable."
            ));
        }

        if (extraction.collapsedSections > 0) {
            view.append(el(
                "p",
                "notice",
                `${extraction.collapsedSections} collapsed section(s) were opened up to read the full document.`
            ));
        }

        if (extraction.unreadableFrames > 0) {
            view.append(el(
                "p",
                "notice",
                `${extraction.unreadableFrames} embedded frame(s) could not be read from this page.`
            ));
        }

        if (extraction.sectionCount > 0) {
            view.append(renderSections(extraction));
        }

        if (report.preview) {
            view.append(renderPreview(report.preview));
        }
    } else {
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
    }

    view.append(renderSignals(detection, extraction));

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
