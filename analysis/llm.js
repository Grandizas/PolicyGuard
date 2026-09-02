/**
 * Tier 2: the Claude API client.
 *
 * Raw HTTP rather than the official SDK, deliberately. This extension has no
 * build step and no package manager -- bundling `@anthropic-ai/sdk` would mean
 * adding both, and shipping generated code to AMO review. The provider surface
 * is small enough that one `fetch` is honest here.
 *
 * Everything below the `callMessages` boundary is provider-specific; the rest
 * of the codebase only sees `analysePolicy()`.
 */

import { buildSystemPrompt, buildUserMessage, FINDINGS_SCHEMA, chunkPolicy, estimateTokens } from "./prompt.js";
import { CATEGORIES, SEVERITIES, createFinding } from "../lib/schema.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export const API_ORIGIN = "https://api.anthropic.com/*";

/**
 * Model choices offered in the options page. Prices are per million tokens and
 * exist so the user can see what a scan costs before running one.
 */
export const MODELS = Object.freeze([
    { id: "claude-opus-5", label: "Claude Opus 5", inputPerM: 5, outputPerM: 25, note: "Most capable" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", inputPerM: 2, outputPerM: 10, note: "Cheaper" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", inputPerM: 1, outputPerM: 5, note: "Cheapest, least thorough" }
]);

export const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/** Non-streaming, so keep output under the SDK-equivalent HTTP timeout. */
const MAX_TOKENS = 16000;

const MAX_ATTEMPTS = 3;

export function modelById(id) {
    return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

/** Tokens the system prompt adds on top of the policy itself. */
const SYSTEM_PROMPT_TOKENS = 600;

/**
 * Assumed response size. Output dominates the bill at these rates -- on Opus 5
 * it is most of the cost of a scan -- so this is deliberately not optimistic.
 */
const ASSUMED_OUTPUT_TOKENS = 2000;

/** A mid-sized real policy, for the "what does this generally cost" line. */
const TYPICAL_POLICY_TOKENS = 8000;

function priceOf(inputTokens, outputTokens, model) {
    return (inputTokens / 1e6) * model.inputPerM + (outputTokens / 1e6) * model.outputPerM;
}

/** Rough cost of scanning this specific page. */
export function estimateCost(text, modelId) {
    const model = modelById(modelId);
    const inputTokens = estimateTokens(text) + SYSTEM_PROMPT_TOKENS;

    return {
        inputTokens,
        outputTokens: ASSUMED_OUTPUT_TOKENS,
        usd: priceOf(inputTokens, ASSUMED_OUTPUT_TOKENS, model)
    };
}

/** Cost of a representative policy, so the model picker can be compared. */
export function typicalCost(modelId) {
    const model = modelById(modelId);

    return priceOf(TYPICAL_POLICY_TOKENS + SYSTEM_PROMPT_TOKENS, ASSUMED_OUTPUT_TOKENS, model);
}

/* ------------------------------------------------------------------ errors */

export class LlmError extends Error {
    constructor(message, { status = null, retryable = false, code = null } = {}) {
        super(message);
        this.name = "LlmError";
        this.status = status;
        this.retryable = retryable;
        this.code = code;
    }
}

function describeStatus(status, body) {
    const apiMessage = body?.error?.message;

    // Identity-linked keys are rejected until they say which workspace they act
    // in. The raw API text names a header the user cannot set, so point them at
    // the setting that does it instead.
    if (apiMessage && /workspace/i.test(apiMessage)) {
        return new LlmError(
            "This API key belongs to a workspace. Add your workspace ID in Policy Guard's settings and try again.",
            { status, code: "workspace" }
        );
    }

    switch (status) {
        case 401:
            return new LlmError("The API key was rejected. Check it in Policy Guard's settings.", { status, code: "auth" });
        case 403:
            return new LlmError("This API key is not allowed to use the Messages API.", { status, code: "forbidden" });
        case 404:
            return new LlmError("The selected model is not available to this account.", { status, code: "model" });
        case 413:
            return new LlmError("This policy is too large to send in one request.", { status, code: "too_large" });
        case 429:
            return new LlmError("Rate limited by the API. Try again shortly.", { status, retryable: true, code: "rate_limit" });
        default:
            break;
    }

    if (status >= 500) {
        return new LlmError("The API had a server error. Try again shortly.", { status, retryable: true, code: "server" });
    }

    return new LlmError(apiMessage ?? `Request failed with status ${status}.`, { status, code: "http" });
}

/* -------------------------------------------------------------------- call */

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One Messages API call with retries on the failures worth retrying.
 *
 * `anthropic-dangerous-direct-browser-access` is what makes a call from inside
 * the browser work at all. It is named that way because it means the key lives
 * on the client -- which is exactly the trade this BYO-key design makes, and
 * which the options page states plainly.
 */
async function callMessages({ apiKey, workspaceId, model, effort, system, userText, signal }) {
    const body = {
        model,
        max_tokens: MAX_TOKENS,
        system: [
            {
                type: "text",
                text: system,
                // Stable across every request, so it is worth caching.
                cache_control: { type: "ephemeral" }
            }
        ],
        messages: [{ role: "user", content: userText }],
        output_config: {
            format: { type: "json_schema", schema: FINDINGS_SCHEMA }
        }
    };

    if (effort) {
        body.output_config.effort = effort;
    }

    const headers = {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true"
    };

    // Only identity-linked keys need this, and sending an empty one is an error.
    if (workspaceId) {
        headers["anthropic-workspace-id"] = workspaceId;
    }

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let response;

        try {
            response = await fetch(API_URL, {
                method: "POST",
                signal,
                headers,
                body: JSON.stringify(body)
            });
        } catch (error) {
            if (error.name === "AbortError") {
                throw error;
            }

            lastError = new LlmError("Could not reach the API. Check your connection.", { retryable: true, code: "network" });

            if (attempt < MAX_ATTEMPTS) {
                await sleep(attempt * 1000);
                continue;
            }

            throw lastError;
        }

        if (response.ok) {
            return response.json();
        }

        let payload = null;

        try {
            payload = await response.json();
        } catch (error) {
            payload = null;
        }

        lastError = describeStatus(response.status, payload);

        if (!lastError.retryable || attempt === MAX_ATTEMPTS) {
            throw lastError;
        }

        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : attempt * 1500;

        await sleep(delay);
    }

    throw lastError;
}

/* ---------------------------------------------------------------- response */

/**
 * Structured output still arrives as a text block; the schema guarantees its
 * shape, not that a block exists.
 */
function extractJson(message) {
    if (message.stop_reason === "refusal") {
        throw new LlmError(
            "The model declined to analyse this document.",
            { code: "refusal" }
        );
    }

    if (message.stop_reason === "max_tokens") {
        throw new LlmError(
            "The response was cut off before it finished. Try a smaller policy or a different model.",
            { code: "truncated" }
        );
    }

    const block = (message.content ?? []).find((b) => b.type === "text");

    if (!block) {
        throw new LlmError("The API returned no readable content.", { code: "empty" });
    }

    try {
        return JSON.parse(block.text);
    } catch (error) {
        throw new LlmError("The API returned malformed JSON.", { code: "parse" });
    }
}

function clamp01(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return 0.5;
    }

    return Math.min(1, Math.max(0, value));
}

/**
 * The schema cannot express "at most N findings" or "confidence between 0 and
 * 1", so both are enforced here rather than trusted.
 */
function normalizeFindings(raw, index) {
    const findings = [];

    for (const [position, item] of (raw.findings ?? []).entries()) {
        if (!CATEGORIES.includes(item.category) || !SEVERITIES.includes(item.severity)) {
            continue;
        }

        if (typeof item.quote !== "string" || item.quote.trim().length === 0) {
            continue;
        }

        findings.push(createFinding({
            id: `llm-${item.category}-${index}-${position}`,
            category: item.category,
            severity: item.severity,
            title: String(item.title ?? "").trim() || item.category,
            description: String(item.description ?? "").trim(),
            quote: item.quote,
            location: null,
            source: "llm",
            confidence: clamp01(item.confidence)
        }));
    }

    return findings;
}

/* --------------------------------------------------------------------- api */

/**
 * Analyse a policy. Chunks only when the document is genuinely huge.
 *
 * @param {object} options
 * @param {string} options.text        the extracted policy
 * @param {Array}  options.sections    extraction outline, for chunk boundaries
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {string} [options.effort]
 * @param {object} [options.context]   hostname, docType, concerns
 * @param {AbortSignal} [options.signal]
 * @param {(progress: object) => void} [options.onProgress]
 */
export async function analysePolicy(options) {
    const { text, sections = [], apiKey, workspaceId, model, effort, context = {}, signal, onProgress } = options;

    if (!apiKey) {
        throw new LlmError("No API key is set.", { code: "no_key" });
    }

    const chunks = chunkPolicy(text, sections);
    const system = buildSystemPrompt();

    const findings = [];
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0 };
    const summaries = [];

    let riskLevel = "low";

    for (const [index, chunk] of chunks.entries()) {
        if (onProgress) {
            onProgress({ stage: "analysing", chunk: index + 1, chunks: chunks.length });
        }

        const userText = buildUserMessage(chunk.text, {
            ...context,
            chunkIndex: index,
            chunkCount: chunks.length
        });

        const message = await callMessages({ apiKey, workspaceId, model, effort, system, userText, signal });
        const parsed = extractJson(message);

        findings.push(...normalizeFindings(parsed, index));

        if (typeof parsed.summary === "string" && parsed.summary.trim()) {
            summaries.push({ text: parsed.summary.trim(), riskLevel: parsed.riskLevel });
        }

        if (parsed.riskLevel === "high" || (parsed.riskLevel === "medium" && riskLevel === "low")) {
            riskLevel = parsed.riskLevel;
        }

        usage.requests += 1;
        usage.inputTokens += message.usage?.input_tokens ?? 0;
        usage.outputTokens += message.usage?.output_tokens ?? 0;
        usage.cacheReadTokens += message.usage?.cache_read_input_tokens ?? 0;
    }

    // With one chunk this is just that chunk's summary. With several, take the
    // summary from the part that found the worst, rather than spending another
    // request to reconcile them.
    const chosen =
        summaries.find((s) => s.riskLevel === riskLevel) ?? summaries[0] ?? { text: "" };

    return {
        findings,
        riskLevel,
        summary: chosen.text,
        usage,
        chunks: chunks.length,
        model
    };
}
