/**
 * Combine tier 1 and tier 2 findings.
 *
 * Both tiers read the same document and cite offsets into the same text, so
 * agreement is detectable rather than guessed: two findings in the same
 * category pointing at overlapping spans are one finding.
 *
 * Pure functions -- no network, no storage.
 */

import { SEVERITY_RANK, compareFindings } from "../lib/schema.js";

/** Combined cap per category. Slightly looser than tier 1 alone. */
export const DEFAULT_MAX_PER_CATEGORY = 3;

function rangesOverlap(a, b) {
    if (!a || !b) {
        return false;
    }

    return a.charStart < b.charEnd && b.charStart < a.charEnd;
}

function normalizeQuote(quote) {
    return (quote ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function quotesOverlap(a, b) {
    const left = normalizeQuote(a.quote);
    const right = normalizeQuote(b.quote);

    if (left.length === 0 || right.length === 0) {
        return false;
    }

    return left.includes(right) || right.includes(left);
}

function sameFinding(a, b) {
    if (a.category !== b.category) {
        return false;
    }

    return rangesOverlap(a.location, b.location) || quotesOverlap(a, b);
}

function worse(a, b) {
    return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * The LLM writes better prose; the rules engine is better calibrated on
 * severity, because its severities were tuned against the fixture corpus. So
 * take wording from one and the severity floor from the other.
 */
function combine(ruleFinding, llmFinding) {
    return {
        ...llmFinding,
        id: ruleFinding.id,
        severity: worse(ruleFinding.severity, llmFinding.severity),
        title: llmFinding.title || ruleFinding.title,
        description: llmFinding.description || ruleFinding.description,
        source: "both",
        // Two independent methods agreeing is the strongest signal tier 1 and
        // tier 2 can produce together.
        confidence: Math.min(
            0.95,
            Math.round((Math.max(ruleFinding.confidence, llmFinding.confidence) + 0.15) * 100) / 100
        )
    };
}

/**
 * @param {Array} ruleFindings  tier 1 output
 * @param {Array} llmFindings   tier 2 output, already quote-verified
 * @param {object} [options]    { maxPerCategory, concerns }
 * @returns {{findings: Array, stats: object}}
 */
export function mergeFindings(ruleFindings, llmFindings, options = {}) {
    const maxPerCategory = options.maxPerCategory ?? DEFAULT_MAX_PER_CATEGORY;
    const concerns = options.concerns ?? [];

    const claimed = new Set();
    const merged = [];
    let agreements = 0;

    for (const ruleFinding of ruleFindings) {
        const match = llmFindings.find(
            (candidate, i) => !claimed.has(i) && sameFinding(ruleFinding, candidate)
        );

        if (!match) {
            merged.push(ruleFinding);
            continue;
        }

        claimed.add(llmFindings.indexOf(match));
        agreements += 1;
        merged.push(combine(ruleFinding, match));
    }

    for (const [i, llmFinding] of llmFindings.entries()) {
        if (!claimed.has(i)) {
            merged.push(llmFinding);
        }
    }

    merged.sort(compareFindings);

    const perCategory = new Map();
    const capped = [];
    let suppressed = 0;

    for (const finding of merged) {
        const seen = perCategory.get(finding.category) ?? 0;

        if (seen >= maxPerCategory) {
            suppressed += 1;
            continue;
        }

        perCategory.set(finding.category, seen + 1);
        capped.push(finding);
    }

    const visible = concerns.length === 0
        ? capped
        : capped.filter((f) => concerns.includes(f.category));

    return {
        findings: visible,
        stats: {
            fromRules: ruleFindings.length,
            fromLlm: llmFindings.length,
            agreements,
            suppressedByCategoryCap: suppressed,
            hiddenByPreferences: capped.length - visible.length
        }
    };
}
