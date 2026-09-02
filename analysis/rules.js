/**
 * Tier 1: pattern matching.
 *
 * This tier is permanent, not scaffolding for the LLM. It is instant, free,
 * works offline and never sends a byte anywhere, so it runs on every policy
 * whether or not the user has an API key.
 *
 * Pure functions only -- no DOM, no storage, no network. The caller supplies
 * the rule data and the text.
 */

import { createFinding, compareFindings, CATEGORIES, SEVERITIES } from "../lib/schema.js";

/** Findings per category. One repetitive policy should not produce forty items. */
export const DEFAULT_MAX_PER_CATEGORY = 2;

/** Quotes longer than this get windowed down around the match. */
const MAX_QUOTE_CHARS = 320;

/** How far either side of a match a negation can still apply. */
const NEGATION_WINDOW = 150;

/**
 * Abbreviations whose full stop does not end a sentence. Legal text is full of
 * them, and a naive split on ". " produces quotes that start mid-clause.
 */
const ABBREVIATIONS = new Set([
    "e.g", "i.e", "etc", "vs", "no", "art", "sec", "cf", "al",
    "inc", "ltd", "llc", "co", "corp", "plc", "gmbh",
    "mr", "mrs", "ms", "dr", "st", "u.s", "u.k", "eu"
]);

/* ------------------------------------------------------------ compilation */

/**
 * `%GAP%` means "any character that does not end a sentence".
 *
 * The obvious spelling of that is `[^.]`, and it is wrong: legal text is full
 * of abbreviations, so "we share data with vendors (e.g. payment processors)
 * and other third parties" contains two full stops mid-sentence and `[^.]`
 * cannot span them.
 *
 * The tempting fix -- "a full stop followed by whitespace and a capital" --
 * does not work either, because rules compile with the `i` flag and `[A-Z]`
 * then matches lowercase too, making the test inert. So the sentence end is
 * identified without reference to case: a full stop is allowed through when
 * something non-space follows it (mid-abbreviation, decimals, clause numbers)
 * or when the token before it is a known abbreviation.
 */
const ABBREVIATION_ALTERNATION =
    "e\\.g|i\\.e|etc|inc|ltd|llc|co|corp|plc|no|vs|al|approx|est|dept";

const GAP_MACRO =
    "(?:[^.]|\\.(?=\\S)|(?<=\\b(?:" + ABBREVIATION_ALTERNATION + ")\\b)\\.)";

function expandMacros(source) {
    return source.split("%GAP%").join(GAP_MACRO);
}

function compilePattern(source) {
    try {
        return new RegExp(expandMacros(source), "gi");
    } catch (error) {
        return null;
    }
}

function compileList(sources) {
    return (sources ?? [])
        .map(compilePattern)
        .filter(Boolean);
}

/**
 * Turn the JSON rule data into runnable rules, dropping anything malformed.
 *
 * @returns {{rules: Array, errors: Array<{id: string, reason: string}>}}
 */
export function compileRules(data) {
    const rules = [];
    const errors = [];

    // Promises *not* to do something otherwise read as doing it. These apply to
    // every concern rule; `good` rules are exempt because their whole job is to
    // match the guarantee ("we do not sell your data" is the finding, not a
    // reason to suppress it).
    const defaultNot = compileList(data?.defaultNot);

    for (const raw of data?.rules ?? []) {
        if (!CATEGORIES.includes(raw.category)) {
            errors.push({ id: raw.id, reason: "unknown category " + raw.category });
            continue;
        }

        if (!SEVERITIES.includes(raw.severity)) {
            errors.push({ id: raw.id, reason: "unknown severity " + raw.severity });
            continue;
        }

        const any = compileList(raw.any);

        if (any.length === 0) {
            errors.push({ id: raw.id, reason: "no usable `any` patterns" });
            continue;
        }

        if (any.length !== (raw.any ?? []).length) {
            errors.push({ id: raw.id, reason: "some `any` patterns failed to compile" });
        }

        rules.push({
            id: raw.id,
            category: raw.category,
            severity: raw.severity,
            title: raw.title,
            description: raw.description,
            confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
            any,
            near: compileList(raw.near),
            not: raw.severity === "good"
                ? compileList(raw.not)
                : compileList(raw.not).concat(defaultNot)
        });
    }

    return { rules, errors };
}

/* -------------------------------------------------------------- sentences */

function endsWithAbbreviation(text, dotIndex) {
    let start = dotIndex;

    while (start > 0 && /[A-Za-z.]/.test(text[start - 1])) {
        start -= 1;
    }

    return ABBREVIATIONS.has(text.slice(start, dotIndex).toLowerCase());
}

/**
 * True if the character at `index` closes a sentence: terminal punctuation,
 * followed by whitespace, followed by something that starts a new one.
 */
function isSentenceEnd(text, index) {
    if (!".!?".includes(text[index])) {
        return false;
    }

    if (text[index] === "." && endsWithAbbreviation(text, index)) {
        return false;
    }

    let cursor = index + 1;

    while (cursor < text.length && /[\s")\]]/.test(text[cursor])) {
        cursor += 1;
    }

    if (cursor === index + 1) {
        return false;
    }

    return cursor >= text.length || /[A-Z0-9(]/.test(text[cursor]);
}

/**
 * The sentence containing [start, end). Paragraph breaks are hard boundaries,
 * which matters because extraction joins blocks with "\n\n".
 */
export function sentenceBounds(text, start, end) {
    let from = start;

    while (from > 0) {
        if (text[from - 1] === "\n") {
            break;
        }

        if (isSentenceEnd(text, from - 1)) {
            break;
        }

        from -= 1;
    }

    let to = end;

    while (to < text.length) {
        if (text[to] === "\n") {
            break;
        }

        if (isSentenceEnd(text, to)) {
            to += 1;
            break;
        }

        to += 1;
    }

    while (from < to && /\s/.test(text[from])) {
        from += 1;
    }

    while (to > from && /\s/.test(text[to - 1])) {
        to -= 1;
    }

    return { from, to };
}

/**
 * Keep the quote a verbatim substring of the source -- verify.js will later
 * check LLM quotes the same way, and a quote we have edited cannot be checked.
 * Long sentences are windowed around the match rather than truncated blindly.
 */
function quoteFor(text, bounds, matchStart, matchEnd) {
    if (bounds.to - bounds.from <= MAX_QUOTE_CHARS) {
        return { from: bounds.from, to: bounds.to };
    }

    const slack = Math.floor((MAX_QUOTE_CHARS - (matchEnd - matchStart)) / 2);

    let from = Math.max(bounds.from, matchStart - slack);
    let to = Math.min(bounds.to, matchEnd + slack);

    // Snap outwards to whitespace so the quote does not start mid-word.
    while (from > bounds.from && !/\s/.test(text[from - 1])) {
        from -= 1;
    }

    while (to < bounds.to && !/\s/.test(text[to])) {
        to += 1;
    }

    return { from, to };
}

/* ---------------------------------------------------------------- matching */

function anyMatchesIn(patterns, text) {
    for (const pattern of patterns) {
        pattern.lastIndex = 0;

        if (pattern.test(text)) {
            return true;
        }
    }

    return false;
}

function allMatchIn(patterns, text) {
    for (const pattern of patterns) {
        pattern.lastIndex = 0;

        if (!pattern.test(text)) {
            return false;
        }
    }

    return true;
}

/**
 * Find the first match of a rule that survives its own negation list.
 *
 * The negation window is the containing sentence, clamped to NEGATION_WINDOW
 * either side of the match. Sentence-scoped rather than a fixed character
 * count, because "we will never share your information with third parties"
 * puts the negation far enough away that a tight window would miss it, while a
 * loose one would let a negation from an unrelated sentence leak in.
 */
function findMatch(text, rule) {
    let patternsHit = 0;
    let best = null;

    for (const pattern of rule.any) {
        pattern.lastIndex = 0;

        let match;
        let hitThisPattern = false;

        while ((match = pattern.exec(text)) !== null) {
            if (match[0].length === 0) {
                pattern.lastIndex += 1;
                continue;
            }

            const matchStart = match.index;
            const matchEnd = matchStart + match[0].length;
            const bounds = sentenceBounds(text, matchStart, matchEnd);
            const sentence = text.slice(bounds.from, bounds.to);

            if (rule.near.length > 0 && !allMatchIn(rule.near, sentence)) {
                continue;
            }

            if (rule.not.length > 0) {
                const windowText = text.slice(
                    Math.max(bounds.from, matchStart - NEGATION_WINDOW),
                    Math.min(bounds.to, matchEnd + NEGATION_WINDOW)
                );

                if (anyMatchesIn(rule.not, windowText)) {
                    continue;
                }
            }

            hitThisPattern = true;

            if (!best) {
                best = { matchStart, matchEnd, bounds };
            }

            break;
        }

        if (hitThisPattern) {
            patternsHit += 1;
        }
    }

    if (!best) {
        return null;
    }

    return { ...best, patternsHit };
}

/* -------------------------------------------------------------------- api */

/**
 * @param {string} text        extracted policy text
 * @param {Array}  rules       output of compileRules().rules
 * @param {object} [options]   { maxPerCategory, concerns }
 * @returns {{findings: Array, stats: object}}
 */
export function runRules(text, rules, options = {}) {
    const maxPerCategory = options.maxPerCategory ?? DEFAULT_MAX_PER_CATEGORY;
    const concerns = options.concerns ?? [];

    const matched = [];
    let evaluated = 0;

    for (const rule of rules) {
        evaluated += 1;

        const match = findMatch(text, rule);

        if (!match) {
            continue;
        }

        const quote = quoteFor(text, match.bounds, match.matchStart, match.matchEnd);

        // Corroboration across independent patterns is weak evidence, so it
        // nudges confidence rather than driving it.
        const confidence = Math.min(0.95, rule.confidence + (match.patternsHit - 1) * 0.08);

        matched.push(createFinding({
            id: rule.id,
            category: rule.category,
            severity: rule.severity,
            title: rule.title,
            description: rule.description,
            quote: text.slice(quote.from, quote.to),
            location: { charStart: quote.from, charEnd: quote.to },
            source: "rules",
            confidence: Math.round(confidence * 100) / 100
        }));
    }

    matched.sort(compareFindings);

    // Cap per category *after* sorting, so the cap keeps the strongest items.
    const perCategory = new Map();
    const findings = [];
    let suppressed = 0;

    for (const finding of matched) {
        const seen = perCategory.get(finding.category) ?? 0;

        if (seen >= maxPerCategory) {
            suppressed += 1;
            continue;
        }

        perCategory.set(finding.category, seen + 1);
        findings.push(finding);
    }

    // User preferences filter the view; they do not change what was found.
    const visible = concerns.length === 0
        ? findings
        : findings.filter((f) => concerns.includes(f.category));

    // Within what is shown, the categories someone said they care about come
    // first. Severity still decides the order inside each group -- a low-severity
    // preference should not outrank a high-severity surprise.
    if (concerns.length > 0) {
        visible.sort((a, b) => {
            const preferred = Number(concerns.includes(b.category)) - Number(concerns.includes(a.category));

            return preferred !== 0 ? preferred : compareFindings(a, b);
        });
    }

    return {
        findings: visible,
        stats: {
            rulesEvaluated: evaluated,
            matched: matched.length,
            suppressedByCategoryCap: suppressed,
            hiddenByPreferences: findings.length - visible.length
        }
    };
}

/** Counts the popup header needs, ignoring favourable findings. */
export function summarize(findings) {
    const concerns = findings.filter((f) => f.severity !== "good");

    return {
        concerns: concerns.length,
        high: concerns.filter((f) => f.severity === "high").length,
        medium: concerns.filter((f) => f.severity === "medium").length,
        low: concerns.filter((f) => f.severity === "low").length,
        good: findings.length - concerns.length
    };
}
