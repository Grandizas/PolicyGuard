/**
 * DOM -> clean, structured policy text.
 *
 * Content scripts declared in the manifest share one sandbox global and cannot
 * use ES module imports, so each file hangs itself off a single namespace.
 */
(function () {
    "use strict";

    const PolicyGuard = (globalThis.PolicyGuard = globalThis.PolicyGuard || {});

    /** Below this, an extraction is treated as failed and we try a wider root. */
    const MIN_WORDS = 200;

    /** A container must hold at least this much text to be a root candidate. */
    const MIN_CANDIDATE_CHARS = 500;

    /**
     * A consent widget is short and has a button. A Cookie Policy page is long.
     * The length guard is what stops us deleting the very document we came for.
     */
    const CONSENT_MAX_CHARS = 1500;

    /**
     * Policy pages routinely collapse their sections into accordions, which are
     * marked aria-hidden or display:none until clicked. Dropping those silently
     * would mean analysing a fraction of the document and calling it clean, so
     * hidden elements are only discarded when they are too small to be content.
     */
    const COLLAPSED_MIN_CHARS = 400;

    /** Page furniture. Never content, whatever its size. */
    const JUNK_SELECTORS = [
        "script", "style", "noscript", "template", "svg", "canvas", "iframe",
        "nav", "header", "footer", "aside",
        "input", "select", "textarea", "button",
        "[role='navigation']", "[role='banner']", "[role='contentinfo']",
        "[role='search']", "[role='complementary']", "[role='menu']",
        ".skip-link", ".skip-to-content",
        ".breadcrumb", ".breadcrumbs",
        ".site-nav", ".site-header", ".site-footer",
        ".sidebar", ".navbar", ".social-share", ".newsletter"
    ].join(",");

    /** Hidden from assistive tech -- chrome when small, collapsed content when large. */
    const HIDDEN_MARKER_SELECTORS = "[aria-hidden='true'], [hidden]";

    const CONSENT_SELECTORS = [
        "[id*='cookie' i]", "[class*='cookie' i]",
        "[id*='consent' i]", "[class*='consent' i]",
        "[id*='gdpr' i]", "[class*='gdpr' i]",
        "[id*='onetrust' i]", "[class*='onetrust' i]",
        "[class*='cookiebanner' i]", "[class*='cookie-banner' i]"
    ].join(",");

    const ACCEPT_TEXT = /\b(accept|allow|agree|got it|i understand|reject|decline|manage (cookies|preferences))\b/i;

    const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

    const BLOCK_TAGS = new Set([
        "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT",
        "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3",
        "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
        "SECTION", "TABLE", "TD", "TH", "TR", "UL", "BODY"
    ]);

    /* ---------------------------------------------------------------- roots */

    /**
     * Prefer an explicit semantic container; fall back to the densest block of
     * text on the page. Link density is the discriminator -- a nav wrapper has
     * plenty of characters but nearly all of them are inside anchors.
     */
    function findContentRoot(doc) {
        const semantic = doc.querySelector("main, article, [role='main']");

        if (semantic && semantic.textContent.trim().length > 2000) {
            return { el: semantic, method: "semantic" };
        }

        const scored = [];

        for (const el of doc.querySelectorAll("main, article, section, div, td")) {
            const length = el.textContent.trim().length;

            if (length < MIN_CANDIDATE_CHARS) {
                continue;
            }

            let linkChars = 0;

            for (const anchor of el.querySelectorAll("a")) {
                linkChars += anchor.textContent.length;
            }

            const linkDensity = Math.min(1, linkChars / length);

            scored.push({ el, score: length * (1 - linkDensity) });
        }

        if (scored.length === 0) {
            return { el: doc.body, method: "body" };
        }

        scored.sort((a, b) => b.score - a.score);

        const best = scored[0];

        // Prefer the deepest descendant that still holds essentially all of the
        // winner's text -- that trims outer page-chrome wrappers.
        let chosen = best;

        for (const candidate of scored) {
            if (candidate === best) {
                continue;
            }

            if (best.el.contains(candidate.el) && candidate.score >= best.score * 0.9) {
                if (depthOf(candidate.el) > depthOf(chosen.el)) {
                    chosen = candidate;
                }
            }
        }

        return { el: chosen.el, method: "density" };
    }

    function depthOf(el) {
        let depth = 0;

        while (el.parentElement) {
            depth += 1;
            el = el.parentElement;
        }

        return depth;
    }

    /* ----------------------------------------------------------- exclusions */

    function looksLikeConsentWidget(el) {
        if (el.textContent.trim().length > CONSENT_MAX_CHARS) {
            return false;
        }

        if (el.querySelector("button, [role='button'], input[type='button'], input[type='submit']")) {
            return true;
        }

        return ACCEPT_TEXT.test(el.textContent);
    }

    function textLengthOf(el) {
        return el.textContent.trim().length;
    }

    function buildExcludedSet(rootEl, stats) {
        const excluded = new Set();

        for (const el of rootEl.querySelectorAll(JUNK_SELECTORS)) {
            excluded.add(el);
        }

        for (const el of rootEl.querySelectorAll(HIDDEN_MARKER_SELECTORS)) {
            if (textLengthOf(el) < COLLAPSED_MIN_CHARS) {
                excluded.add(el);
            } else if (stats) {
                stats.collapsed += 1;
            }
        }

        for (const el of rootEl.querySelectorAll(CONSENT_SELECTORS)) {
            if (looksLikeConsentWidget(el)) {
                excluded.add(el);
            }
        }

        return excluded;
    }

    /* --------------------------------------------------------------- layout */

    /**
     * Opacity is deliberately not treated as hiding: scroll-reveal animations
     * leave large amounts of real content at opacity 0 until script runs.
     *
     * Large hidden blocks are kept for the same reason as aria-hidden ones --
     * on a policy page they are collapsed sections, not chrome. `stats.collapsed`
     * records how many we let through.
     */
    function createHiddenTest(doc, stats) {
        const view = doc.defaultView;
        const cache = new WeakMap();

        return function isHidden(el) {
            if (!view) {
                return false;
            }

            let hidden = cache.get(el);

            if (hidden === undefined) {
                const style = view.getComputedStyle(el);

                const cssHidden =
                    style.display === "none" ||
                    style.visibility === "hidden" ||
                    style.visibility === "collapse";

                if (cssHidden && textLengthOf(el) >= COLLAPSED_MIN_CHARS) {
                    stats.collapsed += 1;
                    hidden = false;
                } else {
                    hidden = cssHidden;
                }

                cache.set(el, hidden);
            }

            return hidden;
        };
    }

    /* ----------------------------------------------------------- collection */

    function nearestBlock(el, rootEl) {
        let node = el;

        while (node && node !== rootEl.parentElement) {
            if (BLOCK_TAGS.has(node.tagName)) {
                return node;
            }

            node = node.parentElement;
        }

        return rootEl;
    }

    function normalizeText(value) {
        return value.replace(/\s+/g, " ").trim();
    }

    /**
     * Walk text nodes in document order, grouping them by their nearest block
     * ancestor. That gives us paragraph boundaries without the layout-dependent
     * behaviour of innerText.
     */
    function collectBlocks(rootEl, stats) {
        const doc = rootEl.ownerDocument;
        const counters = stats ?? { collapsed: 0 };
        const excluded = buildExcludedSet(rootEl, counters);
        const isHidden = createHiddenTest(doc, counters);
        const verdicts = new WeakMap();

        function isDropped(el) {
            let verdict = verdicts.get(el);

            if (verdict !== undefined) {
                return verdict;
            }

            if (excluded.has(el) || isHidden(el)) {
                verdict = true;
            } else if (el === rootEl || !el.parentElement) {
                verdict = false;
            } else {
                verdict = isDropped(el.parentElement);
            }

            verdicts.set(el, verdict);

            return verdict;
        }

        const walker = doc.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (!node.nodeValue || !node.nodeValue.trim()) {
                    return NodeFilter.FILTER_REJECT;
                }

                const parent = node.parentElement;

                if (!parent || isDropped(parent)) {
                    return NodeFilter.FILTER_REJECT;
                }

                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const blocks = [];
        let current = null;
        let node;

        while ((node = walker.nextNode())) {
            const block = nearestBlock(node.parentElement, rootEl);

            if (!current || current.el !== block) {
                pushBlock(blocks, current);
                current = { el: block, tag: block.tagName, parts: [] };
            }

            current.parts.push(node.nodeValue);
        }

        pushBlock(blocks, current);

        return blocks;
    }

    function pushBlock(blocks, block) {
        if (!block) {
            return;
        }

        const text = normalizeText(block.parts.join(" "));

        // Single stray characters are almost always bullets or separators.
        if (text.length < 2) {
            return;
        }

        blocks.push({ tag: block.tag, text });
    }

    /* -------------------------------------------------------------- sections */

    function countWords(text) {
        const matches = text.match(/[^\s]+/g);

        return matches ? matches.length : 0;
    }

    function isHeadingBlock(block) {
        // A 400-character "heading" is a styling accident, not a section title.
        return HEADING_TAGS.has(block.tag) && block.text.length <= 200;
    }

    function buildDocument(blocks) {
        const placed = [];
        const pieces = [];
        let cursor = 0;

        for (const block of blocks) {
            if (pieces.length > 0) {
                cursor += 2; // the "\n\n" join
            }

            placed.push({
                tag: block.tag,
                text: block.text,
                charStart: cursor,
                charEnd: cursor + block.text.length
            });

            cursor += block.text.length;
            pieces.push(block.text);
        }

        const fullText = pieces.join("\n\n");
        const sections = foldSections(placed, fullText.length);

        return {
            fullText,
            sections,
            blockCount: placed.length,
            charCount: fullText.length,
            wordCount: countWords(fullText)
        };
    }

    function foldSections(placed, totalLength) {
        const sections = [];
        let current = null;

        function close(section, endOffset) {
            section.charEnd = endOffset;
            section.text = section.parts.join("\n\n");
            section.wordCount = countWords(section.text);
            delete section.parts;
        }

        for (const block of placed) {
            if (isHeadingBlock(block)) {
                if (current) {
                    close(current, block.charStart);
                }

                current = {
                    heading: block.text,
                    level: Number(block.tag.slice(1)),
                    charStart: block.charStart,
                    bodyStart: block.charEnd,
                    parts: []
                };

                sections.push(current);
                continue;
            }

            if (!current) {
                current = {
                    heading: null,
                    level: 0,
                    charStart: block.charStart,
                    bodyStart: block.charStart,
                    parts: []
                };

                sections.push(current);
            }

            current.parts.push(block.text);
        }

        if (current) {
            close(current, totalLength);
        }

        // A heading with no body is a table-of-contents entry, not a section.
        return sections.filter((s) => s.wordCount > 0 || s.heading);
    }

    /* --------------------------------------------------------------- frames */

    /**
     * Signup pages often render the terms inside a scrollable iframe. Same-origin
     * frames we can read directly; cross-origin ones need all_frames plus frame
     * messaging, which is not wired up yet.
     */
    function sameOriginFrameDocs(doc) {
        const docs = [];

        for (const frame of doc.querySelectorAll("iframe, frame")) {
            try {
                const frameDoc = frame.contentDocument;

                if (frameDoc && frameDoc.body) {
                    docs.push(frameDoc);
                }
            } catch (error) {
                // Cross-origin. Nothing to do here.
            }
        }

        return docs;
    }

    function crossOriginFrameCount(doc) {
        let count = 0;

        for (const frame of doc.querySelectorAll("iframe, frame")) {
            try {
                if (!frame.contentDocument) {
                    count += 1;
                }
            } catch (error) {
                count += 1;
            }
        }

        return count;
    }

    /* ------------------------------------------------------------------ api */

    function extractFrom(rootEl, method) {
        const stats = { collapsed: 0 };
        const result = buildDocument(collectBlocks(rootEl, stats));

        return { ...result, method, collapsedSections: stats.collapsed };
    }

    /**
     * Try progressively wider nets until we have enough text, then take the
     * richest same-origin frame if it beats the host document.
     *
     * @returns {object} { method, fullText, sections, wordCount, ... }
     */
    function extractPolicy(doc) {
        const root = findContentRoot(doc);
        let best = extractFrom(root.el, root.method);

        if (best.wordCount < MIN_WORDS && root.el !== doc.body) {
            const fromBody = extractFrom(doc.body, "body");

            if (fromBody.wordCount > best.wordCount) {
                best = fromBody;
            }
        }

        for (const frameDoc of sameOriginFrameDocs(doc)) {
            const frameRoot = findContentRoot(frameDoc);
            const fromFrame = extractFrom(frameRoot.el, "iframe:" + frameRoot.method);

            if (fromFrame.wordCount > best.wordCount) {
                best = fromFrame;
            }
        }

        // Last resort: whatever the browser thinks is on screen.
        if (best.wordCount < MIN_WORDS) {
            const text = normalizeText(doc.body ? doc.body.innerText : "");

            if (countWords(text) > best.wordCount) {
                best = {
                    method: "innertext",
                    fullText: text,
                    sections: [{
                        heading: null,
                        level: 0,
                        text,
                        charStart: 0,
                        bodyStart: 0,
                        charEnd: text.length,
                        wordCount: countWords(text)
                    }],
                    blockCount: 1,
                    charCount: text.length,
                    wordCount: countWords(text),
                    collapsedSections: 0
                };
            }
        }

        return {
            ...best,
            degraded: best.method === "innertext" || best.wordCount < MIN_WORDS,
            unreadableFrames: crossOriginFrameCount(doc)
        };
    }

    PolicyGuard.extract = {
        extractPolicy,
        findContentRoot,
        countWords,
        normalizeText,
        MIN_WORDS,
        // Exposed for test/runner.html.
        _internals: { collectBlocks, buildExcludedSet, extractFrom }
    };
})();
