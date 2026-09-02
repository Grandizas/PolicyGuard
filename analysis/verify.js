/**
 * Quote grounding.
 *
 * A finding whose quote does not appear in the document is discarded. This is
 * the whole anti-hallucination story for tier 2, and it is mechanical: no
 * prompt engineering, no model judging itself, no cost. If the model invents a
 * clause, the clause is not in the text, and the finding does not survive.
 *
 * Pure functions -- no network, no storage.
 */

/** Word-trigram overlap below this is treated as ungrounded. */
export const FUZZY_THRESHOLD = 0.9;

/** Characters that differ between a document and a faithful copy of it. */
const FOLD = new Map([
    ["‘", "'"], ["’", "'"], ["‚", "'"], ["‛", "'"],
    ["“", '"'], ["”", '"'], ["„", '"'], ["‟", '"'],
    ["‐", "-"], ["‑", "-"], ["‒", "-"], ["–", "-"],
    ["—", "-"], ["―", "-"], ["−", "-"],
    // Non-breaking, narrow no-break, and thin spaces.
    ["\u00A0", " "], ["\u202F", " "], ["\u2009", " "]
]);

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/;

/**
 * Normalise while remembering where every surviving character came from, so a
 * match in normalised space can be reported as offsets into the original.
 *
 * @returns {{norm: string, map: number[]}} map[i] is the source index of norm[i]
 */
export function normalizeWithMap(text) {
    const chars = [];
    const map = [];
    let pendingSpace = false;

    for (let i = 0; i < text.length; i += 1) {
        const raw = text[i];

        if (ZERO_WIDTH.test(raw)) {
            continue;
        }

        const folded = FOLD.get(raw) ?? raw;

        if (/\s/.test(folded)) {
            // Collapse runs; never emit a leading space.
            pendingSpace = chars.length > 0;
            continue;
        }

        if (pendingSpace) {
            chars.push(" ");
            map.push(i);
            pendingSpace = false;
        }

        const lowered = folded.toLowerCase();

        // Some characters lengthen when lowercased; keeping those would break
        // the 1:1 index mapping, so they stay as they are.
        chars.push(lowered.length === 1 ? lowered : folded);
        map.push(i);
    }

    return { norm: chars.join(""), map };
}

function normalizeQuote(quote) {
    return normalizeWithMap(quote).norm;
}

/* -------------------------------------------------------------------- fuzzy */

function wordsOf(norm) {
    const words = norm.match(/[^\s]+/g);

    return words ?? [];
}

function trigramsOf(words) {
    const grams = [];

    if (words.length < 3) {
        return words.length > 0 ? [words.join(" ")] : [];
    }

    for (let i = 0; i + 2 < words.length; i += 1) {
        grams.push(words[i] + " " + words[i + 1] + " " + words[i + 2]);
    }

    return grams;
}

/**
 * What fraction of the quote's trigrams appear anywhere in the document.
 * Trigrams rather than bare words so that reordered text does not pass.
 */
function containment(quoteWords, textTrigramIndex) {
    const grams = trigramsOf(quoteWords);

    if (grams.length === 0) {
        return { score: 0, first: -1, last: -1 };
    }

    let hits = 0;
    let first = -1;
    let last = -1;

    for (const gram of grams) {
        const positions = textTrigramIndex.get(gram);

        if (!positions) {
            continue;
        }

        hits += 1;

        const at = positions[0];

        if (first === -1 || at < first) {
            first = at;
        }

        if (at > last) {
            last = at;
        }
    }

    return { score: hits / grams.length, first, last };
}

/**
 * Precomputed once per document and reused across findings -- building it per
 * finding turns verification into the slowest part of an analysis.
 */
export function buildDocumentIndex(text) {
    const { norm, map } = normalizeWithMap(text);
    const words = [];
    const wordStarts = [];
    const wordEnds = [];

    const pattern = /[^\s]+/g;
    let match;

    while ((match = pattern.exec(norm)) !== null) {
        words.push(match[0]);
        wordStarts.push(match.index);
        wordEnds.push(match.index + match[0].length);
    }

    const trigramIndex = new Map();
    const grams = trigramsOf(words);

    for (const [i, gram] of grams.entries()) {
        const existing = trigramIndex.get(gram);

        if (existing) {
            existing.push(i);
        } else {
            trigramIndex.set(gram, [i]);
        }
    }

    return { text, norm, map, words, wordStarts, wordEnds, trigramIndex };
}

/* -------------------------------------------------------------------- api */

function originalRange(index, normStart, normEnd) {
    const from = index.map[normStart];
    const to = index.map[Math.min(normEnd, index.map.length - 1)];

    return { charStart: from, charEnd: to + 1 };
}

/**
 * @returns {{grounded: boolean, method: string, score: number, location: object|null, quote: string|null}}
 */
export function groundQuote(quote, index) {
    const normQuote = normalizeQuote(quote ?? "");

    if (normQuote.length === 0) {
        return { grounded: false, method: "empty", score: 0, location: null, quote: null };
    }

    const at = index.norm.indexOf(normQuote);

    if (at !== -1) {
        const location = originalRange(index, at, at + normQuote.length - 1);

        return {
            grounded: true,
            method: "exact",
            score: 1,
            location,
            // Prefer the document's own characters over the model's copy of
            // them, so "show on page" highlights exactly what is displayed.
            quote: index.text.slice(location.charStart, location.charEnd)
        };
    }

    const quoteWords = wordsOf(normQuote);
    const { score, first, last } = containment(quoteWords, index.trigramIndex);

    if (score < FUZZY_THRESHOLD || first === -1) {
        return { grounded: false, method: "missing", score, location: null, quote: null };
    }

    const startWord = Math.max(0, first);
    const endWord = Math.min(index.words.length - 1, last + 2);
    const location = originalRange(index, index.wordStarts[startWord], index.wordEnds[endWord] - 1);

    return {
        grounded: true,
        method: "fuzzy",
        score,
        location,
        quote: index.text.slice(location.charStart, location.charEnd)
    };
}

/**
 * Drop every finding whose quote is not in the document.
 *
 * @param {Array}  findings
 * @param {string} text
 * @returns {{findings: Array, dropped: Array, stats: object}}
 */
export function verifyFindings(findings, text) {
    const index = buildDocumentIndex(text);

    const kept = [];
    const dropped = [];
    const stats = { checked: 0, exact: 0, fuzzy: 0, dropped: 0 };

    for (const finding of findings) {
        stats.checked += 1;

        const result = groundQuote(finding.quote, index);

        if (!result.grounded) {
            stats.dropped += 1;
            dropped.push({
                id: finding.id,
                category: finding.category,
                title: finding.title,
                quote: finding.quote,
                score: Math.round(result.score * 100) / 100
            });
            continue;
        }

        if (result.method === "exact") {
            stats.exact += 1;
        } else {
            stats.fuzzy += 1;
        }

        kept.push({
            ...finding,
            quote: result.quote,
            location: result.location,
            // A fuzzy match means the model reworded slightly; the finding is
            // still anchored, but the reader deserves to know.
            quoteApproximate: result.method === "fuzzy",
            // An unverifiable quote is a bad sign about the rest of the finding.
            confidence: result.method === "fuzzy"
                ? Math.round(finding.confidence * 0.9 * 100) / 100
                : finding.confidence
        });
    }

    return { findings: kept, dropped, stats };
}
