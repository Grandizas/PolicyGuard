/**
 * Prompt construction and chunking for tier 2.
 *
 * Pure functions -- no network, no storage. `llm.js` does the talking.
 */

import { CATEGORIES, CATEGORY_LABELS } from "../lib/schema.js";

/**
 * Policies are sent in one request when they fit, which is almost always.
 *
 * The plan assumed chunking would be the normal path; with a 1M-token context
 * that is wrong. A 12,000-word policy is roughly 16k tokens, so splitting it
 * only adds overlap cost, a reduce pass, and two more ways to fail. Chunking
 * now exists for the genuinely enormous document, not the typical one.
 */
export const MAX_SINGLE_PASS_CHARS = 200000;

/** Target size per chunk once a document does exceed the single-pass limit. */
export const CHUNK_TARGET_CHARS = 150000;

/** Carried between chunks so a clause split across the seam is still seen whole. */
export const CHUNK_OVERLAP_CHARS = 1200;

/**
 * Rough chars-per-token. Only used to show the user an estimate before they
 * spend money -- nothing branches on it, so approximate is fine.
 */
const CHARS_PER_TOKEN = 3.6;

export function estimateTokens(text) {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/* ------------------------------------------------------------------ schema */

/**
 * Structured output schema. Constraints the API does not support (numeric
 * ranges, array length limits) are asked for in the prompt and enforced when
 * the response is normalised.
 */
export const FINDINGS_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["riskLevel", "summary", "findings"],
    properties: {
        riskLevel: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "Overall risk of agreeing to this document."
        },
        summary: {
            type: "string",
            description: "One plain-language sentence describing the document's overall posture."
        },
        findings: {
            type: "array",
            description: "Notable clauses. Omit anything standard and unremarkable.",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["category", "severity", "title", "description", "quote", "confidence"],
                properties: {
                    category: { type: "string", enum: [...CATEGORIES] },
                    severity: {
                        type: "string",
                        enum: ["high", "medium", "low", "good"],
                        description: "Use \"good\" for terms that favour the reader."
                    },
                    title: {
                        type: "string",
                        description: "Three to six words naming the issue."
                    },
                    description: {
                        type: "string",
                        description: "One sentence in plain language, addressed to the reader."
                    },
                    quote: {
                        type: "string",
                        description: "Text copied verbatim from the document, word for word."
                    },
                    confidence: {
                        type: "number",
                        description: "0 to 1. How certain you are this reading is correct."
                    }
                }
            }
        }
    }
};

/* ------------------------------------------------------------------ system */

function categoryLines() {
    return CATEGORIES.map((c) => `- ${c}: ${CATEGORY_LABELS[c]}`).join("\n");
}

/**
 * The system prompt is deliberately identical between requests so it can be
 * cached. Anything that varies per policy belongs in the user message.
 */
export function buildSystemPrompt() {
    return `You read Terms of Service and Privacy Policies and tell an ordinary person what they should be cautious about before agreeing.

Report each notable clause as a finding. Use only these categories:

${categoryLines()}

Rules:

1. Every finding must include a quote copied VERBATIM from the document — the exact characters, not a paraphrase, not cleaned up, not shortened with an ellipsis. A quote that does not appear in the document word for word will be discarded and your finding lost. Keep quotes to one or two sentences.

2. Report favourable terms too, with severity "good". A policy that lets people delete their data, keeps their content ownership, or promises not to sell their information should say so. A list of only bad news is not an honest reading.

3. Omit clauses that are standard and unremarkable for this kind of service. A routine limitation-of-liability section in a terms document is not worth alarming someone about. Prefer ten accurate findings over thirty padded ones.

4. Severity means consequence for the reader, not how unusual the wording is:
   - high: gives away a significant right, or permits something most people would object to if asked (selling personal data, training AI on their content, waiving the right to sue).
   - medium: a real cost or restriction they should know about (automatic renewal, broad data sharing, terms that can change unilaterally).
   - low: worth knowing, standard in context.
   - good: favours the reader.

5. Write descriptions in plain language addressed to the reader ("Your uploaded photos may be used to train AI models"), not legal summary ("Section 4.2 grants a licence"). No legal advice, no recommendations about whether to accept.

6. If a sentence promises NOT to do something, that is either a "good" finding or no finding at all. Never report a guarantee as a risk.`;
}

/* -------------------------------------------------------------------- user */

export function buildUserMessage(text, context = {}) {
    const parts = [];

    if (context.hostname) {
        parts.push(`Service: ${context.hostname}`);
    }

    if (context.docType && context.docType !== "unknown") {
        parts.push(`Document type: ${context.docType.replace(/_/g, " ")}`);
    }

    if (context.chunkCount > 1) {
        parts.push(
            `This is part ${context.chunkIndex + 1} of ${context.chunkCount} of a long document. ` +
            `Report only what this part supports.`
        );
    }

    if (context.concerns && context.concerns.length > 0) {
        const labels = context.concerns.map((c) => CATEGORY_LABELS[c] ?? c).join(", ");

        // Steer attention without narrowing the search: a user who cares about
        // AI training still wants to be told their data is being sold.
        parts.push(
            `The reader has said they especially care about: ${labels}. ` +
            `Be thorough on those, but still report anything else significant.`
        );
    }

    parts.push("Document follows.\n\n---\n\n" + text);

    return parts.join("\n");
}

/* ------------------------------------------------------------------ chunks */

/**
 * Split on section boundaries when possible, falling back to a hard character
 * split. Quote verification always runs against the full document, so chunk
 * offsets never need to be mapped back.
 *
 * @param {string} text
 * @param {Array}  sections  extraction outline, may be empty
 * @returns {Array<{text: string, charStart: number, charEnd: number}>}
 */
export function chunkPolicy(text, sections = []) {
    if (text.length <= MAX_SINGLE_PASS_CHARS) {
        return [{ text, charStart: 0, charEnd: text.length }];
    }

    const boundaries = sections
        .map((s) => s.charStart)
        .filter((n) => Number.isInteger(n) && n > 0 && n < text.length)
        .sort((a, b) => a - b);

    const chunks = [];
    let start = 0;

    while (start < text.length) {
        const ideal = start + CHUNK_TARGET_CHARS;

        if (ideal >= text.length) {
            chunks.push(sliceChunk(text, start, text.length));
            break;
        }

        // Prefer the last section boundary before the ideal cut, so long as it
        // is not so early that chunks become tiny.
        const candidate = boundaries
            .filter((b) => b > start + CHUNK_TARGET_CHARS / 2 && b <= ideal)
            .pop();

        const end = candidate ?? ideal;

        chunks.push(sliceChunk(text, start, end));
        start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
    }

    return chunks;
}

function sliceChunk(text, from, to) {
    return { text: text.slice(from, to), charStart: from, charEnd: to };
}
