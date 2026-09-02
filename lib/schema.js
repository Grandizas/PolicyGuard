/**
 * The shared vocabulary of Policy Guard.
 *
 * Every tier of the pipeline (rules engine, LLM, merge, UI, user preferences)
 * speaks in terms of the shapes defined here. Validate at every boundary.
 */

/**
 * Closed category enum. This is the join key between the rules engine, the LLM
 * output schema, the user's concern preferences and the UI. Adding a category
 * means touching all four -- that friction is deliberate.
 */
export const CATEGORIES = Object.freeze([
    "data_sharing",
    "data_selling",
    "ai_training",
    "content_license",
    "auto_renewal",
    "arbitration",
    "class_action_waiver",
    "unilateral_changes",
    "tracking_cookies",
    "data_retention",
    "account_termination",
    "liability_limits",
    "jurisdiction",
    "age_restrictions",
    "data_deletion",
    "data_portability"
]);

export const CATEGORY_LABELS = Object.freeze({
    data_sharing: "Data sharing",
    data_selling: "Data selling",
    ai_training: "AI training",
    content_license: "Content licence",
    auto_renewal: "Automatic renewal",
    arbitration: "Arbitration",
    class_action_waiver: "Class action waiver",
    unilateral_changes: "Unilateral changes",
    tracking_cookies: "Tracking and cookies",
    data_retention: "Data retention",
    account_termination: "Account termination",
    liability_limits: "Liability limits",
    jurisdiction: "Governing law",
    age_restrictions: "Age restrictions",
    data_deletion: "Data deletion",
    data_portability: "Data portability"
});

/** "good" is a first-class severity: favourable terms are worth reporting too. */
export const SEVERITIES = Object.freeze(["high", "medium", "low", "good"]);

export const SEVERITY_RANK = Object.freeze({
    high: 3,
    medium: 2,
    low: 1,
    good: 0
});

export const RISK_LEVELS = Object.freeze(["high", "medium", "low"]);

export const SOURCES = Object.freeze(["rules", "llm", "both"]);

/** Document kinds we can recognise before any analysis happens. */
export const DOC_TYPES = Object.freeze([
    "privacy_policy",
    "terms",
    "cookie_policy",
    "eula",
    "acceptable_use",
    "unknown"
]);

/**
 * @returns {object} a Finding with defaults filled in. Does not validate --
 *   call isValidFinding() on anything that came from outside this codebase.
 */
export function createFinding(input) {
    return {
        id: input.id,
        category: input.category,
        severity: input.severity,
        title: input.title,
        description: input.description,
        quote: input.quote ?? "",
        location: input.location ?? null,
        source: input.source ?? "rules",
        confidence: typeof input.confidence === "number" ? input.confidence : 0.5
    };
}

/**
 * Structural validation only. Quote grounding (does this text actually appear
 * on the page?) is a separate concern -- see analysis/verify.js.
 */
export function isValidFinding(value) {
    return Boolean(
        value &&
        typeof value.id === "string" && value.id.length > 0 &&
        CATEGORIES.includes(value.category) &&
        SEVERITIES.includes(value.severity) &&
        typeof value.title === "string" && value.title.length > 0 &&
        typeof value.description === "string" &&
        typeof value.quote === "string" &&
        SOURCES.includes(value.source) &&
        typeof value.confidence === "number" &&
        value.confidence >= 0 && value.confidence <= 1
    );
}

/**
 * Highest severity present wins, but a lone medium is not a "medium risk"
 * document -- it takes a couple of them to move the needle.
 */
export function riskLevelFromFindings(findings) {
    const concerns = findings.filter((f) => f.severity !== "good");

    if (concerns.some((f) => f.severity === "high")) {
        return "high";
    }

    const mediums = concerns.filter((f) => f.severity === "medium").length;

    if (mediums >= 2) {
        return "medium";
    }

    return concerns.length > 0 ? "low" : "low";
}

/** Sort order for the UI: worst first, "good" items last. */
export function compareFindings(a, b) {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];

    if (bySeverity !== 0) {
        return bySeverity;
    }

    return b.confidence - a.confidence;
}

/**
 * The top-level record the popup renders and the cache stores.
 *
 * `detection` and `extraction` carry the Phase 1 metadata; `findings` stays
 * empty until the rules engine lands.
 */
export function createAnalysis(input) {
    const findings = (input.findings ?? []).slice().sort(compareFindings);

    return {
        url: input.url,
        hostname: input.hostname,
        analyzedAt: input.analyzedAt,
        contentHash: input.contentHash ?? null,
        riskLevel: input.riskLevel ?? riskLevelFromFindings(findings),
        summary: input.summary ?? "",
        findings,
        tiers: {
            rules: Boolean(input.tiers?.rules),
            llm: Boolean(input.tiers?.llm)
        },
        truncated: Boolean(input.truncated),
        detection: input.detection ?? null,
        extraction: input.extraction ?? null
    };
}
