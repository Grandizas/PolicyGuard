/**
 * Assertions for the pure tier-2 modules: quote grounding, merging, chunking.
 *
 * Separate from runner.html because these need no DOM and no fixtures beyond a
 * single document's text, so they are the part of the suite that could move to
 * a headless runner later.
 */

import { verifyFindings, groundQuote, buildDocumentIndex } from "../analysis/verify.js";
import { mergeFindings } from "../analysis/merge.js";
import { chunkPolicy, MAX_SINGLE_PASS_CHARS } from "../analysis/prompt.js";

/**
 * @param {string} doc     real extracted policy text to ground against
 * @param {(name: string, ok: boolean, detail: string) => void} check
 */
export function runAnalysisSuite(doc, check) {
    groundingChecks(doc, check);
    mergeChecks(check);
    chunkChecks(check);
}

/* -------------------------------------------------------------- grounding */

function groundingChecks(doc, check) {
    const index = buildDocumentIndex(doc);

    // A genuine long sentence pulled out of the document itself.
    const sentence = doc
        .split(/\n\n/)
        .map((block) => block.trim())
        .filter((block) => block.length > 220 && block.length < 400)[0];

    if (!sentence) {
        check("grounding fixture has a usable sentence", false, "no sentence of the right length");
        return;
    }

    const exact = groundQuote(sentence, index);

    check("exact quote is grounded", exact.grounded && exact.method === "exact",
        "method " + exact.method);

    check("grounded offsets point at the quote",
        exact.location !== null &&
        doc.slice(exact.location.charStart, exact.location.charEnd) === exact.quote,
        "returned quote does not match the slice at its own offsets");

    // The same sentence retyped the way a model would reproduce it: straight
    // quotes, ASCII dashes, different spacing, different case.
    const retyped = sentence
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, "-")
        .replace(/\s+/g, "   ")
        .toUpperCase();

    const normalised = groundQuote(retyped, index);

    check("retyped quote (case, quotes, spacing) is grounded",
        normalised.grounded && normalised.method === "exact",
        "method " + normalised.method + " score " + normalised.score);

    // A word inserted mid-sentence breaks a few trigrams but not most, so this
    // should survive as a fuzzy match rather than being thrown away.
    const words = sentence.split(" ");

    words.splice(Math.floor(words.length / 2), 0, "additionally");

    const reworded = groundQuote(words.join(" "), index);

    check("lightly reworded quote grounds as fuzzy",
        reworded.grounded && reworded.method === "fuzzy",
        "method " + reworded.method + " score " + reworded.score);

    // The assertion the whole tier rests on.
    const invented = groundQuote(
        "We will harvest your biometric data and sell it to the highest bidder without notice.",
        index
    );

    check("fabricated quote is rejected", !invented.grounded,
        "a hallucinated quote was accepted, score " + invented.score);

    const paraphrase = groundQuote(
        "This agreement says the company can do whatever it likes with anything you post.",
        index
    );

    check("paraphrase is rejected", !paraphrase.grounded, "score " + paraphrase.score);

    const mixed = [
        {
            id: "llm-a", category: "content_license", severity: "high", title: "Real",
            description: "", quote: sentence, source: "llm", confidence: 0.8, location: null
        },
        {
            id: "llm-b", category: "data_selling", severity: "high", title: "Invented",
            description: "", quote: "We sell your soul to advertisers every third Tuesday.",
            source: "llm", confidence: 0.9, location: null
        }
    ];

    const verified = verifyFindings(mixed, doc);

    check("verifyFindings keeps the grounded one and drops the invented one",
        verified.findings.length === 1 &&
        verified.findings[0].id === "llm-a" &&
        verified.dropped.length === 1 &&
        verified.dropped[0].id === "llm-b",
        "kept " + verified.findings.length + ", dropped " + verified.dropped.length);
}

/* ------------------------------------------------------------------ merge */

function mergeChecks(check) {
    const ruleFinding = {
        id: "data-sharing-third-parties",
        category: "data_sharing",
        severity: "high",
        title: "Data sharing with third parties",
        description: "rules wording",
        quote: "we share data with third parties",
        location: { charStart: 100, charEnd: 140 },
        source: "rules",
        confidence: 0.6
    };

    const llmOverlap = {
        id: "llm-data_sharing-0-0",
        category: "data_sharing",
        severity: "medium",
        title: "Shared with ad partners",
        description: "llm wording",
        quote: "share data with third parties for ads",
        location: { charStart: 120, charEnd: 190 },
        source: "llm",
        confidence: 0.7
    };

    const llmElsewhere = {
        id: "llm-ai_training-0-1",
        category: "ai_training",
        severity: "high",
        title: "Trains on your content",
        description: "llm wording",
        quote: "used to train our models",
        location: { charStart: 900, charEnd: 940 },
        source: "llm",
        confidence: 0.8
    };

    const merged = mergeFindings([ruleFinding], [llmOverlap, llmElsewhere]);
    const both = merged.findings.find((f) => f.source === "both");

    check("overlapping findings merge into one",
        merged.findings.length === 2 && Boolean(both),
        "got " + merged.findings.length + " findings");

    check("merged finding keeps the worse severity",
        Boolean(both) && both.severity === "high",
        "severity " + (both ? both.severity : "n/a"));

    check("merged finding prefers the AI wording",
        Boolean(both) && both.description === "llm wording",
        "description " + (both ? both.description : "n/a"));

    check("agreement raises confidence above either input",
        Boolean(both) && both.confidence > 0.7,
        "confidence " + (both ? both.confidence : "n/a"));

    check("a non-overlapping AI finding survives",
        merged.findings.some((f) => f.id === "llm-ai_training-0-1"),
        "it was dropped");

    const alone = mergeFindings([ruleFinding], []);

    check("merging with no AI findings changes nothing",
        alone.findings.length === 1 && alone.findings[0].source === "rules",
        "tier 1 output was altered");
}

/* ----------------------------------------------------------------- chunks */

function chunkChecks(check) {
    const short = "word ".repeat(1000);
    const long = "word ".repeat(Math.ceil((MAX_SINGLE_PASS_CHARS * 2.2) / 5));

    check("a normal policy is a single request",
        chunkPolicy(short, []).length === 1,
        "it was chunked unnecessarily");

    const chunks = chunkPolicy(long, []);

    check("an enormous policy is chunked",
        chunks.length >= 2,
        "got " + chunks.length + " chunk(s)");

    check("chunks overlap so a clause on the seam is still seen whole",
        chunks.length >= 2 && chunks[1].charStart < chunks[0].charEnd,
        "no overlap between consecutive chunks");

    check("chunks cover the whole document",
        chunks.length > 0 && chunks[chunks.length - 1].charEnd === long.length,
        "last chunk ends at " + (chunks.length ? chunks[chunks.length - 1].charEnd : "n/a"));
}
