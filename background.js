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
import { cacheKey, readCache, writeCache, cacheStats, clearCache } from "./lib/cache.js";

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

    const hash = payload.extraction.wordCount > 0
        ? await contentHash(payload.hostname, payload.fullText)
        : null;

    const analysis = createAnalysis({
        url: payload.url,
        hostname: payload.hostname,
        analyzedAt: new Date().toISOString(),
        contentHash: hash,
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
        deep: await describeDeepAvailability(payload, hash),
        linked: {},
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
async function describeDeepAvailability(payload, hash) {
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

    // A cache hit means the button costs nothing, which changes what it should
    // say -- so the popup needs to know before it is drawn.
    let cached = false;

    if (available && hash) {
        const key = cacheKey({ contentHash: hash, model: settings.model, concerns: settings.concerns });

        cached = (await readCache(key)) !== null;
    }

    return {
        status: "idle",
        available,
        cached,
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

    const hash = await contentHash(payload.hostname, payload.fullText);
    const key = cacheKey({ contentHash: hash, model: settings.model, concerns: settings.concerns });

    // Cache first. The same policy re-read on a later visit should never be
    // paid for twice, and this is what makes tier 2 affordable at all.
    const hit = await readCache(key);

    let result;
    let verified;
    let fromCache = false;

    if (hit) {
        result = hit.value;
        verified = { findings: result.findings, dropped: result.dropped ?? [], stats: result.verifyStats };
        fromCache = true;
    } else {
        result = await analysePolicy({
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
        verified = verifyFindings(result.findings, payload.fullText);

        // Cache the verified half only. Rule findings are recomputed every time
        // so that a patterns.json change is never served from a stale entry.
        await writeCache(
            key,
            {
                findings: verified.findings,
                dropped: verified.dropped,
                verifyStats: verified.stats,
                riskLevel: result.riskLevel,
                summary: result.summary,
                usage: result.usage,
                chunks: result.chunks,
                model: result.model
            },
            { hostname: payload.hostname, model: settings.model }
        );
    }

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
        cached: fromCache,
        cachedAt: fromCache ? hit.storedAt : null,
        stats: {
            ...merged.stats,
            quotesChecked: verified.stats.checked,
            quotesExact: verified.stats.exact,
            quotesFuzzy: verified.stats.fuzzy,
            quotesDropped: verified.stats.dropped,
            dropped: verified.dropped,
            usage: result.usage,
            chunks: result.chunks,
            model: result.model,
            fromCache
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

/* -------------------------------------------------- linked policies (P4) */

/** A policy page that will not fit in a reasonable fetch is not worth reading. */
const MAX_LINKED_BYTES = 3 * 1024 * 1024;

async function patchLinked(tabId, href, patch) {
    const report = await getTabAnalysis(tabId);

    if (!report) {
        return;
    }

    report.linked = report.linked ?? {};
    report.linked[href] = { ...(report.linked[href] ?? {}), ...patch };

    await setTabAnalysis(tabId, report);
}

/**
 * Read a policy that is linked from the current page without navigating to it.
 *
 * This is the point of the whole extension: nobody opens a 12,000-word terms
 * document voluntarily, but they will glance at a summary while a signup form
 * is still in front of them.
 *
 * The fetch sends no cookies and DOMParser runs no scripts, so the site cannot
 * tell the policy was read, and none of its trackers fire.
 */
async function checkLinkedPolicy(tabId, href) {
    await patchLinked(tabId, href, { status: "running", error: null });

    let origin;

    try {
        origin = new URL(href).origin + "/*";
    } catch (error) {
        await patchLinked(tabId, href, { status: "error", error: "That link is not a valid address." });
        return;
    }

    if (!(await browser.permissions.contains({ origins: [origin] }))) {
        await patchLinked(tabId, href, {
            status: "error",
            error: "Policy Guard needs permission to read that site."
        });
        return;
    }

    let html;

    try {
        const response = await fetch(href, { credentials: "omit", redirect: "follow" });

        if (!response.ok) {
            await patchLinked(tabId, href, {
                status: "error",
                error: `The policy page returned ${response.status}.`
            });
            return;
        }

        html = await response.text();
    } catch (error) {
        await patchLinked(tabId, href, { status: "error", error: "Could not fetch that page." });
        return;
    }

    if (html.length > MAX_LINKED_BYTES) {
        await patchLinked(tabId, href, { status: "error", error: "That page is too large to read." });
        return;
    }

    // Parsing needs a DOM, and the content script already has one plus the
    // extraction code loaded, so the work happens there rather than here.
    await ensureContentScript(tabId);

    const response = await browser.tabs.sendMessage(tabId, {
        type: "PG_SCAN_HTML",
        html,
        url: href
    });

    if (!response || !response.ok) {
        await patchLinked(tabId, href, { status: "error", error: "Could not read that page's text." });
        return;
    }

    const payload = response.payload;

    if (!payload.detection.isPolicy) {
        await patchLinked(tabId, href, {
            status: "done",
            isPolicy: false,
            error: null,
            wordCount: payload.extraction.wordCount,
            findings: [],
            counts: null
        });
        return;
    }

    let findings = [];

    try {
        const settings = await getSettings();
        const rules = await loadRules();

        findings = runRules(payload.fullText, rules, { concerns: settings.concerns }).findings;
    } catch (error) {
        console.warn("Policy Guard: rules engine failed on linked policy -", error);
    }

    await patchLinked(tabId, href, {
        status: "done",
        isPolicy: true,
        error: null,
        title: payload.title,
        docType: payload.detection.docType,
        wordCount: payload.extraction.wordCount,
        riskLevel: riskLevelFromFindings(findings),
        counts: summarize(findings),
        findings
    });
}

const linkedInFlight = new Set();

function startLinkedCheck(tabId, href) {
    const token = tabId + "|" + href;

    if (linkedInFlight.has(token)) {
        return Promise.resolve({ started: false });
    }

    linkedInFlight.add(token);

    checkLinkedPolicy(tabId, href)
        .catch(async (error) => {
            await patchLinked(tabId, href, {
                status: "error",
                error: String(error && error.message ? error.message : error)
            });
        })
        .finally(() => linkedInFlight.delete(token));

    return Promise.resolve({ started: true });
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

        case "CHECK_LINK":
            return startLinkedCheck(message.tabId, message.href);

        case "CACHE_STATS":
            return cacheStats();

        case "CLEAR_CACHE":
            return clearCache();

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
