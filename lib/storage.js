/**
 * Typed wrappers over browser.storage.
 *
 * Three areas, three lifetimes:
 *   - local   settings and (from Phase 4) the analysis cache
 *   - session per-tab analysis results, cleared when the browser closes
 *   - local   the API key, kept under its own key so it is easy to wipe
 */

import { CATEGORIES } from "./schema.js";

const SETTINGS_KEY = "settings";
const API_KEY_KEY = "apiKey";
const SESSION_PREFIX = "analysis:";

export const DEFAULT_SETTINGS = Object.freeze({
    /** Tier 1 is free and offline, so it always runs. Tier 2 never runs unattended. */
    autoAnalyze: true,
    llmEnabled: false,
    autoLlm: false,
    provider: "anthropic",
    model: "claude-sonnet-5",
    /** Categories the user cares about; empty array means "all of them". */
    concerns: [],
    showInPageBadge: true,
    /** Set once the user has seen the "text leaves your browser" disclosure. */
    networkDisclosureAccepted: false
});

/**
 * browser.storage.session is not available on every Firefox build we support,
 * so fall back to an in-memory map. Losing per-tab state on a background-script
 * restart is acceptable; failing to start is not.
 */
const sessionArea = browser.storage.session ?? createMemoryArea();

function createMemoryArea() {
    const store = new Map();

    return {
        async get(keys) {
            const wanted = typeof keys === "string" ? [keys] : Object.keys(keys ?? {});
            const out = {};

            for (const key of wanted) {
                if (store.has(key)) {
                    out[key] = store.get(key);
                }
            }

            return out;
        },
        async set(items) {
            for (const [key, value] of Object.entries(items)) {
                store.set(key, value);
            }
        },
        async remove(keys) {
            for (const key of [].concat(keys)) {
                store.delete(key);
            }
        }
    };
}

export async function getSettings() {
    const stored = await browser.storage.local.get(SETTINGS_KEY);
    const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };

    // Drop any category that no longer exists in the enum.
    settings.concerns = settings.concerns.filter((c) => CATEGORIES.includes(c));

    return settings;
}

export async function updateSettings(patch) {
    const next = { ...(await getSettings()), ...patch };

    await browser.storage.local.set({ [SETTINGS_KEY]: next });

    return next;
}

export async function getApiKey() {
    const stored = await browser.storage.local.get(API_KEY_KEY);

    return stored[API_KEY_KEY] ?? "";
}

export async function setApiKey(key) {
    if (key) {
        await browser.storage.local.set({ [API_KEY_KEY]: key });
    } else {
        await browser.storage.local.remove(API_KEY_KEY);
    }
}

export async function getTabAnalysis(tabId) {
    const key = SESSION_PREFIX + tabId;
    const stored = await sessionArea.get(key);

    return stored[key] ?? null;
}

export async function setTabAnalysis(tabId, analysis) {
    await sessionArea.set({ [SESSION_PREFIX + tabId]: analysis });
}

export async function clearTabAnalysis(tabId) {
    await sessionArea.remove(SESSION_PREFIX + tabId);
}
