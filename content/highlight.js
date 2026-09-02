/**
 * "Show on page" -- find a quoted clause in the live document and take the
 * reader to it.
 *
 * This is what makes a citation worth having. A finding that says "we may share
 * your data" is a claim; the same finding that scrolls you to the sentence in
 * the policy is evidence.
 *
 * Nothing here rewrites the page. The match is shown with a real selection plus
 * a temporary outline on the containing block, both of which undo cleanly --
 * wrapping text in <mark> would mean mutating a document the user is reading.
 */
(function () {
    "use strict";

    const PolicyGuard = (globalThis.PolicyGuard = globalThis.PolicyGuard || {});

    const STYLE_ID = "policy-guard-highlight-style";
    const FLASH_ATTR = "data-policy-guard-flash";
    const FLASH_MS = 2600;

    /** If the whole quote cannot be found, this much of its start will do. */
    const PREFIX_CHARS = 60;

    const FOLD = new Map([
        ["‘", "'"], ["’", "'"], ["‚", "'"], ["‛", "'"],
        ["“", '"'], ["”", '"'], ["„", '"'], ["‟", '"'],
        ["‐", "-"], ["‑", "-"], ["‒", "-"], ["–", "-"],
        ["—", "-"], ["―", "-"], ["−", "-"],
        // Non-breaking, narrow no-break, and thin spaces.
        ["\u00A0", " "], ["\u202F", " "], ["\u2009", " "]
    ]);

    const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/;

    let flashTimer = null;

    /* ----------------------------------------------------------- normalise */

    /**
     * Normalise a string, keeping an index back to where each surviving
     * character came from.
     */
    function normalize(text) {
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
                pendingSpace = chars.length > 0;
                continue;
            }

            if (pendingSpace) {
                chars.push(" ");
                map.push(i);
                pendingSpace = false;
            }

            const lowered = folded.toLowerCase();

            chars.push(lowered.length === 1 ? lowered : folded);
            map.push(i);
        }

        return { norm: chars.join(""), map };
    }

    /* --------------------------------------------------------------- index */

    /**
     * A normalised copy of everything visible on the page, plus enough
     * bookkeeping to turn an offset in it back into a DOM position.
     *
     * Rebuilt on every lookup rather than cached: the page may have changed
     * since the scan, and a stale index would point at the wrong words.
     */
    function buildIndex(doc) {
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !node.nodeValue.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }

                const parent = node.parentElement;

                if (!parent) {
                    return NodeFilter.FILTER_REJECT;
                }

                const tag = parent.tagName;

                if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const pieces = [];
        const entries = [];
        let cursor = 0;
        let node;

        while ((node = walker.nextNode())) {
            const { norm, map } = normalize(node.nodeValue);

            if (norm.length === 0) {
                continue;
            }

            // A separator keeps words in adjacent nodes from fusing.
            if (cursor > 0) {
                pieces.push(" ");
                cursor += 1;
            }

            entries.push({ node, start: cursor, end: cursor + norm.length, map });
            pieces.push(norm);
            cursor += norm.length;
        }

        return { text: pieces.join(""), entries };
    }

    function locate(index, offset) {
        let low = 0;
        let high = index.entries.length - 1;

        while (low <= high) {
            const mid = (low + high) >> 1;
            const entry = index.entries[mid];

            if (offset < entry.start) {
                high = mid - 1;
            } else if (offset >= entry.end) {
                low = mid + 1;
            } else {
                return { node: entry.node, offset: entry.map[offset - entry.start] };
            }
        }

        return null;
    }

    function rangeFor(index, from, to, doc) {
        const start = locate(index, from);
        const end = locate(index, to);

        if (!start || !end) {
            return null;
        }

        const range = doc.createRange();

        range.setStart(start.node, start.offset);
        // `to` is the last matched character, so the range ends after it.
        range.setEnd(end.node, Math.min(end.offset + 1, end.node.nodeValue.length));

        return range;
    }

    /* --------------------------------------------------------------- flash */

    function ensureStyle(doc) {
        if (doc.getElementById(STYLE_ID)) {
            return;
        }

        const style = doc.createElement("style");

        style.id = STYLE_ID;
        style.textContent = `
            [${FLASH_ATTR}] {
                outline: 2px solid #f0a145 !important;
                outline-offset: 3px !important;
                border-radius: 2px !important;
                scroll-margin: 25vh !important;
                transition: outline-color 400ms ease-out !important;
            }
            @media (prefers-reduced-motion: reduce) {
                [${FLASH_ATTR}] { transition: none !important; }
            }
        `;

        doc.documentElement.append(style);
    }

    function clearHighlight(doc = document) {
        clearTimeout(flashTimer);

        for (const el of doc.querySelectorAll(`[${FLASH_ATTR}]`)) {
            el.removeAttribute(FLASH_ATTR);
        }
    }

    /* ----------------------------------------------------------------- api */

    /**
     * @param {string} quote  text to find, as it appears in the analysis
     * @param {Document} [doc] defaults to the page this script runs in; the
     *   parameter exists so the test suite can drive it against a fixture
     * @returns {{found: boolean, partial: boolean}}
     */
    function showQuote(quote, doc = document) {
        const target = normalize(quote ?? "").norm;

        if (target.length === 0) {
            return { found: false, partial: false };
        }

        const index = buildIndex(doc);

        let at = index.text.indexOf(target);
        let length = target.length;
        let partial = false;

        if (at === -1 && target.length > PREFIX_CHARS) {
            // The page may render the clause slightly differently from the way
            // it was extracted; the opening words are enough to get there.
            const prefix = target.slice(0, PREFIX_CHARS);

            at = index.text.indexOf(prefix);
            length = prefix.length;
            partial = true;
        }

        if (at === -1) {
            return { found: false, partial: false };
        }

        const range = rangeFor(index, at, at + length - 1, doc);

        if (!range) {
            return { found: false, partial: false };
        }

        clearHighlight(doc);
        ensureStyle(doc);

        const view = doc.defaultView;
        const selection = view ? view.getSelection() : null;

        if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
        }

        const anchor = range.startContainer.parentElement;

        if (anchor) {
            anchor.setAttribute(FLASH_ATTR, "");
            anchor.scrollIntoView({ block: "center", behavior: "smooth" });

            flashTimer = setTimeout(clearHighlight, FLASH_MS);
        }

        return { found: true, partial };
    }

    PolicyGuard.highlight = { showQuote, clearHighlight };
})();
