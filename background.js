/**
 * Orchestrator.
 *
 * All logic lives here because the popup is destroyed the moment it closes --
 * anything it owns dies with it. The background is an event page and can itself
 * be evicted, so results are persisted to session storage as they are produced
 * rather than held in memory.
 */

import { createAnalysis, riskLevelFromFindings } from "./lib/schema.js";
import { contentHash } from "./lib/hash.js";
import { compileRules, runRules, summarize } from "./analysis/rules.js";
import { getSettings, getTabAnalysis, setTabAnalysis, clearTabAnalysis } from "./lib/storage.js";

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

async function scanTab(tabId) {
    const tab = await browser.tabs.get(tabId);

    if (!isScannable(tab.url)) {
        return {
            supported: false,
            reason: "Policy Guard only runs on http and https pages."
        };
    }

    const ready = await ensureContentScript(tabId);

    if (!ready) {
        return {
            supported: false,
            reason: "This page blocks extensions from reading its content."
        };
    }

    const response = await browser.tabs.sendMessage(tabId, { type: "PG_SCAN" });

    if (!response || !response.ok) {
        return {
            supported: false,
            reason: response ? response.error : "The page did not respond."
        };
    }

    const payload = response.payload;

    // Tier 1 runs on every policy: it is free, offline, and needs no consent.
    let findings = [];
    let ruleStats = null;

    if (payload.detection.isPolicy) {
        try {
            const settings = await getSettings();
            const rules = await loadRules();
            const result = runRules(payload.fullText, rules, { concerns: settings.concerns });

            findings = result.findings;
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
        riskLevel: riskLevelFromFindings(findings),
        summary: "",
        findings,
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
        counts: summarize(findings),
        ruleStats,
        analysis
    };

    await setTabAnalysis(tabId, report);

    return report;
}

/**
 * Full page text is deliberately not cached -- it is large and the tab can
 * always be asked again. Phase 2 will call this from the rules engine.
 */
async function getPageText(tabId) {
    await ensureContentScript(tabId);

    const response = await browser.tabs.sendMessage(tabId, { type: "PG_SCAN" });

    if (!response || !response.ok) {
        return null;
    }

    return response.payload.fullText;
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

        case "GET_PAGE_TEXT":
            return getPageText(message.tabId);

        default:
            return undefined;
    }
});

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

// A navigation invalidates whatever we knew about the tab.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "loading") {
        clearTabAnalysis(tabId);
    }
});

browser.tabs.onRemoved.addListener((tabId) => {
    clearTabAnalysis(tabId);
});
