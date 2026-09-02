/**
 * Orchestrator.
 *
 * All logic lives here because the popup is destroyed the moment it closes --
 * anything it owns dies with it. That matters most for tier 2: an LLM call can
 * take a minute, and the user will close the popup during it. The job runs
 * here, writes progress to session storage as it goes, and the popup simply
 * reads whatever the current state is.
 */

import { createAnalysis, riskLevelFromFindings } from "./lib/schema.js";
import { contentHash } from "./lib/hash.js";
import { compileRules, runRules, summarize } from "./analysis/rules.js";
import { analysePolicy, estimateCost, API_ORIGIN, LlmError } from "./analysis/llm.js";
import { verifyFindings } from "./analysis/verify.js";
import { mergeFindings } from "./analysis/merge.js";
import { getSettings, getApiKey, getTabAnalysis, setTabAnalysis, clearTabAnalysis } from "./lib/storage.js";

/** Kept in sync with the content_scripts entry in the manifest. */
const CONTENT_FILES = [
    "content/detect.js",
    "content/extract.js",
    "content/content.js"
];

function isScannable(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url);
}

/**
 * Patterns are data, loaded and compiled once per background-script lifetime.
 * An event page can be evicted, so this is a warm cache rather than a global.
 */
let rulesPromise = null;

function loadRules() {
    if (!rulesPromise) {
        rulesPromise = (async () => {
            const url = browser.runtime.getURL("analysis/patterns.json");
            const data = await (await fetch(url)).json();
            const { rules, errors } = compileRules(data);

            for (const error of errors) {
                console.warn("Policy Guard: rule", error.id, "-", error.reason);
            }

            return rules;
        })().catch((error) => {
            // Do not cache a failure; the next scan should get another chance.
            rulesPromise = null;
            throw error;
        });
    }

    return rulesPromise;
}

/* ------------------------------------------------------------ content link */

async function pingTab(tabId) {
    try {
        const response = await browser.tabs.sendMessage(tabId, { type: "PG_PING" });

        return Boolean(response && response.ready);
    } catch (error) {
        return false;
    }
}

/**
 * Manifest-declared content scripts are not present in tabs that were already
 * open when the extension started, so inject on demand. Clicking the toolbar
 * button grants activeTab, which is what makes this permitted.
 */
async function ensureContentScript(tabId) {
    if (await pingTab(tabId)) {
        return true;
    }

    await browser.scripting.executeScript({
        target: { tabId },
        files: CONTENT_FILES
    });

    return pingTab(tabId);
}

/** Full page text is never cached -- it is large, and the tab still has it. */
async function scanPayload(tabId) {
    const ready = await ensureContentScript(tabId);

    if (!ready) {
        return null;
    }

    const response = await browser.tabs.sendMessage(tabId, { type: "PG_SCAN" });

    return response && response.ok ? response.payload : null;
}

/* ----------------------------------------------------------------- tier 1 */

async function scanTab(tabId) {
    const tab = await browser.tabs.get(tabId);

    if (!isScannable(tab.url)) {
        return {
            supported: false,
            reason: "Policy Guard only runs on http and https pages."
        };
    }

    const payload = await scanPayload(tabId);

    if (!payload) {
        return {
            supported: false,
            reason: "This page blocks extensions from reading its content."
        };
    }

    // Tier 1 runs on every policy: it is free, offline, and needs no consent.
    let ruleFindings = [];
    let ruleStats = null;

    if (payload.detection.isPolicy) {
        try {
            const settings = await getSettings();
            const rules = await loadRules();
            const result = runRules(payload.fullText, rules, { concerns: settings.concerns });

            ruleFindings = result.findings;
            ruleStats = result.stats;
        } catch (error) {
            console.warn("Policy Guard: rules engine failed -", error);
        }
    }

    const analysis = createAnalysis({
        url: payload.url,
        hostname: payload.hostname,
        analyzedAt: new Date().toISOString(),
        contentHash: payload.extraction.wordCount > 0
            ? await contentHash(payload.hostname, payload.fullText)
            : null,
        riskLevel: riskLevelFromFindings(ruleFindings),
        summary: "",
        findings: ruleFindings,
        tiers: { rules: ruleStats !== null, llm: false },
        truncated: false,
        detection: payload.detection,
        extraction: payload.extraction
    });

    const report = {
        supported: true,
        title: payload.title,
        preview: payload.preview,
        policyLinks: payload.policyLinks ?? [],
        counts: summarize(ruleFindings),
        ruleStats,
        // Kept pristine so a repeated deep analysis merges against tier 1
        // rather than against its own previous output.
        ruleFindings,
        deep: await describeDeepAvailability(payload),
        analysis
    };

    await setTabAnalysis(tabId, report);

    return report;
}

/* ----------------------------------------------------------------- tier 2 */

/**
 * Everything the popup needs to decide what to offer, computed up front so the
 * button is never shown in a state that cannot work.
 */
async function describeDeepAvailability(payload) {
    const settings = await getSettings();
    const apiKey = await getApiKey();

    let hasPermission = false;

    try {
        hasPermission = await browser.permissions.contains({ origins: [API_ORIGIN] });
    } catch (error) {
        hasPermission = false;
    }

    const available =
        payload.detection.isPolicy &&
        settings.llmEnabled &&
        settings.networkDisclosureAccepted &&
        Boolean(apiKey);

    let blockedReason = null;

    if (payload.detection.isPolicy && !available) {
        if (!settings.llmEnabled) {
            blockedReason = "Deep analysis is switched off in settings.";
        } else if (!apiKey) {
            blockedReason = "Add an API key in settings to use deep analysis.";
        } else {
            blockedReason = "Deep analysis needs your consent in settings before it can send page text.";
        }
    }

    return {
        status: "idle",
        available,
        blockedReason,
        needsPermission: available && !hasPermission,
        model: settings.model,
        estimate: payload.detection.isPolicy
            ? estimateCost(payload.fullText, settings.model)
            : null,
        progress: null,
        error: null,
        stats: null
    };
}

const inFlight = new Map();

async function patchDeep(tabId, patch) {
    const report = await getTabAnalysis(tabId);

    if (!report) {
        return;
    }

    report.deep = { ...report.deep, ...patch };
    await setTabAnalysis(tabId, report);
}

async function runDeepAnalysis(tabId, settings, apiKey) {
    await patchDeep(tabId, { status: "running", error: null, progress: { chunk: 1, chunks: 1 } });

    const payload = await scanPayload(tabId);

    if (!payload) {
        await patchDeep(tabId, { status: "error", error: "Could not read the page again." });
        return;
    }

    const result = await analysePolicy({
        text: payload.fullText,
        sections: payload.extraction.sections,
        apiKey,
        workspaceId: settings.workspaceId,
        model: settings.model,
        effort: settings.effort || undefined,
        context: {
            hostname: payload.hostname,
            docType: payload.detection.docType,
            concerns: settings.concerns
        },
        onProgress: (progress) => {
            patchDeep(tabId, { progress: { chunk: progress.chunk, chunks: progress.chunks } });
        }
    });

    // Nothing the model says survives without a quote we can find in the page.
    const verified = verifyFindings(result.findings, payload.fullText);

    const report = await getTabAnalysis(tabId);
    const ruleFindings = report?.ruleFindings ?? [];
    const merged = mergeFindings(ruleFindings, verified.findings, { concerns: settings.concerns });

    if (!report) {
        return;
    }

    report.analysis.findings = merged.findings;
    report.analysis.riskLevel = result.riskLevel ?? riskLevelFromFindings(merged.findings);
    report.analysis.summary = result.summary ?? "";
    report.analysis.tiers = { ...report.analysis.tiers, llm: true };
    report.counts = summarize(merged.findings);
    report.deep = {
        ...report.deep,
        status: "done",
        progress: null,
        error: null,
        stats: {
            ...merged.stats,
            quotesChecked: verified.stats.checked,
            quotesExact: verified.stats.exact,
            quotesFuzzy: verified.stats.fuzzy,
            quotesDropped: verified.stats.dropped,
            dropped: verified.dropped,
            usage: result.usage,
            chunks: result.chunks,
            model: result.model
        }
    };

    await setTabAnalysis(tabId, report);
}

async function startDeepAnalysis(tabId) {
    if (inFlight.has(tabId)) {
        return { started: false, reason: "already running" };
    }

    const settings = await getSettings();
    const apiKey = await getApiKey();

    if (!settings.llmEnabled || !settings.networkDisclosureAccepted || !apiKey) {
        return { started: false, reason: "Deep analysis is not set up." };
    }

    const job = runDeepAnalysis(tabId, settings, apiKey)
        .catch(async (error) => {
            const message = error instanceof LlmError
                ? error.message
                : `Deep analysis failed: ${error && error.message ? error.message : error}`;

            await patchDeep(tabId, { status: "error", error: message, progress: null });
        })
        .finally(() => {
            inFlight.delete(tabId);
        });

    inFlight.set(tabId, job);

    return { started: true };
}

/* ---------------------------------------------------------------- messages */

async function handleGetReport(tabId, force) {
    try {
        if (!force) {
            const cached = await getTabAnalysis(tabId);

            if (cached) {
                return { ...cached, fromSession: true };
            }
        }

        return await scanTab(tabId);
    } catch (error) {
        return { supported: false, reason: String(error && error.message ? error.message : error) };
    }
}

browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message.type !== "string") {
        return undefined;
    }

    switch (message.type) {
        case "GET_REPORT":
            return handleGetReport(message.tabId, false);

        case "RESCAN":
            return handleGetReport(message.tabId, true);

        case "DEEP_ANALYZE":
            return startDeepAnalysis(message.tabId);

        case "GET_PAGE_TEXT":
            return scanPayload(message.tabId).then((p) => (p ? p.fullText : null));

        default:
            return undefined;
    }
});

// A navigation invalidates whatever we knew about the tab.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "loading") {
        clearTabAnalysis(tabId);
    }
});

browser.tabs.onRemoved.addListener((tabId) => {
    clearTabAnalysis(tabId);
});
