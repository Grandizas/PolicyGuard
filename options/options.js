/**
 * Settings page.
 *
 * Also the consent gate: deep analysis cannot run until the disclosure on this
 * page has been read and ticked. That is deliberate -- the popup should never
 * be the place someone first learns their page text is leaving the browser.
 */

import { CATEGORIES, CATEGORY_LABELS } from "../lib/schema.js";
import { getSettings, updateSettings, getApiKey, setApiKey } from "../lib/storage.js";
import { MODELS, API_ORIGIN, typicalCost } from "../analysis/llm.js";

const els = {
    llmEnabled: document.querySelector("#llmEnabled"),
    disclosure: document.querySelector("#disclosure"),
    accepted: document.querySelector("#networkDisclosureAccepted"),
    apiKey: document.querySelector("#apiKey"),
    workspaceId: document.querySelector("#workspaceId"),
    toggleKey: document.querySelector("#toggleKey"),
    clearKey: document.querySelector("#clearKey"),
    model: document.querySelector("#model"),
    modelNote: document.querySelector("#modelNote"),
    effort: document.querySelector("#effort"),
    permissionPanel: document.querySelector("#permissionPanel"),
    grantPermission: document.querySelector("#grantPermission"),
    concerns: document.querySelector("#concerns"),
    cacheStats: document.querySelector("#cacheStats"),
    clearCache: document.querySelector("#clearCache"),
    saved: document.querySelector("#saved")
};

let savedTimer = null;

function flashSaved() {
    els.saved.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
        els.saved.hidden = true;
    }, 1600);
}

function describeModel(id) {
    const model = MODELS.find((m) => m.id === id) ?? MODELS[0];

    // Quote a per-scan figure, not just the per-million rate: the rate tells a
    // user nothing about what pressing the button will actually cost them.
    return `$${model.inputPerM.toFixed(2)} per million input tokens, ` +
        `$${model.outputPerM.toFixed(2)} per million output tokens — ` +
        `roughly $${typicalCost(id).toFixed(2)} per policy. ` +
        `You pay Anthropic directly for each analysis you run.`;
}

function buildModelOptions(selected) {
    els.model.replaceChildren();

    for (const model of MODELS) {
        const option = document.createElement("option");

        option.value = model.id;
        option.textContent = `${model.label} — ${model.note}`;
        option.selected = model.id === selected;

        els.model.append(option);
    }

    els.modelNote.textContent = describeModel(selected);
}

function buildConcerns(selected) {
    els.concerns.replaceChildren();

    for (const category of CATEGORIES) {
        const label = document.createElement("label");
        const input = document.createElement("input");

        input.type = "checkbox";
        input.value = category;
        input.checked = selected.includes(category);

        input.addEventListener("change", async () => {
            const chosen = Array.from(
                els.concerns.querySelectorAll("input:checked"),
                (el) => el.value
            );

            await updateSettings({ concerns: chosen });
            flashSaved();
        });

        label.append(input, document.createTextNode(CATEGORY_LABELS[category]));
        els.concerns.append(label);
    }
}

async function refreshPermissionPanel() {
    const settings = await getSettings();

    if (!settings.llmEnabled) {
        els.permissionPanel.hidden = true;
        return;
    }

    let granted = false;

    try {
        granted = await browser.permissions.contains({ origins: [API_ORIGIN] });
    } catch (error) {
        granted = false;
    }

    els.permissionPanel.hidden = granted;
}

function syncDisclosureVisibility(enabled) {
    els.disclosure.style.display = enabled ? "" : "none";
}

function formatBytes(bytes) {
    if (bytes < 1024) {
        return bytes + " B";
    }

    if (bytes < 1024 * 1024) {
        return Math.round(bytes / 1024) + " KB";
    }

    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function refreshCacheStats() {
    const stats = await browser.runtime.sendMessage({ type: "CACHE_STATS" });

    if (!stats || stats.entries === 0) {
        els.cacheStats.textContent = "Nothing cached yet.";
        els.clearCache.disabled = true;
        return;
    }

    els.clearCache.disabled = false;
    els.cacheStats.textContent =
        `${stats.entries} ${stats.entries === 1 ? "policy" : "policies"} cached, ` +
        `${formatBytes(stats.bytes)}. ` +
        `Reused ${stats.hits} ${stats.hits === 1 ? "time" : "times"} so far.`;
}

async function init() {
    const settings = await getSettings();
    const key = await getApiKey();

    els.llmEnabled.checked = settings.llmEnabled;
    els.accepted.checked = settings.networkDisclosureAccepted;
    els.apiKey.value = key;
    els.workspaceId.value = settings.workspaceId ?? "";
    els.effort.value = settings.effort ?? "";

    buildModelOptions(settings.model);
    buildConcerns(settings.concerns);
    syncDisclosureVisibility(settings.llmEnabled);
    await refreshPermissionPanel();
    await refreshCacheStats();
}

/* ----------------------------------------------------------------- events */

els.llmEnabled.addEventListener("change", async () => {
    const enabled = els.llmEnabled.checked;

    await updateSettings({ llmEnabled: enabled });
    syncDisclosureVisibility(enabled);
    flashSaved();

    // Ask for host access from inside the click that enabled the feature --
    // permissions.request() needs a user gesture and will be refused outside one.
    if (enabled) {
        try {
            await browser.permissions.request({ origins: [API_ORIGIN] });
        } catch (error) {
            // Declining is a legitimate answer; the panel will offer it again.
        }
    }

    await refreshPermissionPanel();
});

els.accepted.addEventListener("change", async () => {
    await updateSettings({ networkDisclosureAccepted: els.accepted.checked });
    flashSaved();
});

els.apiKey.addEventListener("change", async () => {
    await setApiKey(els.apiKey.value.trim());
    flashSaved();
});

els.workspaceId.addEventListener("change", async () => {
    await updateSettings({ workspaceId: els.workspaceId.value.trim() });
    flashSaved();
});

els.toggleKey.addEventListener("click", () => {
    const showing = els.apiKey.type === "text";

    els.apiKey.type = showing ? "password" : "text";
    els.toggleKey.textContent = showing ? "Show key" : "Hide key";
});

els.clearKey.addEventListener("click", async () => {
    els.apiKey.value = "";
    await setApiKey("");
    flashSaved();
});

els.model.addEventListener("change", async () => {
    await updateSettings({ model: els.model.value });
    els.modelNote.textContent = describeModel(els.model.value);
    flashSaved();
});

els.effort.addEventListener("change", async () => {
    await updateSettings({ effort: els.effort.value });
    flashSaved();
});

els.grantPermission.addEventListener("click", async () => {
    try {
        await browser.permissions.request({ origins: [API_ORIGIN] });
    } catch (error) {
        // Nothing to do; the panel stays visible.
    }

    await refreshPermissionPanel();
});

els.clearCache.addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "CLEAR_CACHE" });
    await refreshCacheStats();
    flashSaved();
});

init();
