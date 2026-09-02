/**
 * "Is there a policy here, and what kind?"
 *
 * Scored rather than boolean, because no single signal is trustworthy on its
 * own: plenty of pages are titled "Privacy" without being a policy, and plenty
 * of real policies live at opaque URLs.
 */
(function () {
    "use strict";

    const PolicyGuard = (globalThis.PolicyGuard = globalThis.PolicyGuard || {});

    /** Combined score needed before we call something a policy. */
    const SCORE_THRESHOLD = 45;

    /** A policy shorter than this is a summary or a stub, not the real document. */
    const MIN_WORDS = 300;

    const URL_PATTERNS = [
        { re: /\/(privacy[-_]?(policy|notice|statement)?)(\/|$|\.|\?)/i, score: 30, type: "privacy_policy" },
        { re: /\/(terms([-_]?(of[-_]?)?(service|use|and[-_]?conditions))?)(\/|$|\.|\?)/i, score: 30, type: "terms" },
        { re: /\/(tos|tou|t-and-c|terms-conditions)(\/|$|\.|\?)/i, score: 30, type: "terms" },
        { re: /\/(cookie[-_]?(policy|notice))(\/|$|\.|\?)/i, score: 30, type: "cookie_policy" },
        { re: /\/(eula|licen[cs]e[-_]?agreement)(\/|$|\.|\?)/i, score: 30, type: "eula" },
        { re: /\/(acceptable[-_]?use)(\/|$|\.|\?)/i, score: 30, type: "acceptable_use" },
        { re: /\/(user[-_]?agreement|subscriber[-_]?agreement)(\/|$|\.|\?)/i, score: 30, type: "terms" },
        { re: /\/(legal|policies|agreements)(\/|$|\.|\?)/i, score: 18, type: "unknown" },
        { re: /\/(data[-_]?(protection|processing))(\/|$|\.|\?)/i, score: 22, type: "privacy_policy" }
    ];

    const TITLE_PATTERNS = [
        { re: /\bprivacy (policy|notice|statement)\b/i, score: 30, type: "privacy_policy" },
        { re: /\bterms (of (service|use)|and conditions)\b/i, score: 30, type: "terms" },
        { re: /\bcookie (policy|notice)\b/i, score: 30, type: "cookie_policy" },
        { re: /\b(end[- ]user )?licen[cs]e agreement\b/i, score: 30, type: "eula" },
        { re: /\bacceptable use policy\b/i, score: 30, type: "acceptable_use" },
        { re: /\b(user|subscriber|service) agreement\b/i, score: 26, type: "terms" },
        { re: /\bdata (protection|processing) (policy|agreement|addendum)\b/i, score: 26, type: "privacy_policy" },
        { re: /\b(terms|privacy|legal)\b/i, score: 14, type: "unknown" }
    ];

    /**
     * Legalese markers. Density of these per 1000 words is the signal that
     * separates an actual policy from a blog post *about* privacy policies.
     */
    const LEGAL_MARKERS = [
        /\bhereby\b/gi,
        /\bherein\b/gi,
        /\bthereof\b/gi,
        /\bnotwithstanding\b/gi,
        /\bshall\b/gi,
        /\bindemnif/gi,
        /\bwarrant(y|ies|s)?\b/gi,
        /\bliabilit(y|ies)\b/gi,
        /\barbitration\b/gi,
        /\bgoverning law\b/gi,
        /\bapplicable law\b/gi,
        /\bjurisdiction\b/gi,
        /\bwithout limitation\b/gi,
        /\bsole discretion\b/gi,
        /\bthird part(y|ies)\b/gi,
        /\bprovision(s)?\b/gi,
        /\bterminate\b/gi,
        /\bpersonal (data|information)\b/gi,
        /\bwe (may|will) collect\b/gi,
        /\bby (using|accessing|continuing)\b/gi
    ];

    /** Marker density (per 1000 words) at which the density signal saturates. */
    const DENSITY_SATURATION = 10;

    /** Distinct marker count at which the variety signal saturates. */
    const VARIETY_SATURATION = 8;

    /**
     * A policy speaks to its reader: "you agree", "we collect". An encyclopedia
     * article *about* policies does not. Measured across the fixture corpus this
     * separates the two cleanly -- real policies run 45-85 combined pronouns per
     * 1000 words, the Wikipedia article on privacy policies sits at 3.4 -- and it
     * is the only signal that does, since legalese density overlaps.
     */
    const SECOND_PERSON = /\b(you|your|yours|yourself)\b/gi;
    const FIRST_PERSON = /\b(we|our|ours|us)\b/gi;

    /** Combined pronouns per 1000 words at which the address signal saturates. */
    const ADDRESS_SATURATION = 30;

    /** Below this, the text is prose about policies rather than a policy. */
    const ADDRESS_GATE = 10;

    /** Per-signal caps. They sum to 100. */
    const MAX_URL = 25;
    const MAX_TITLE = 25;
    const MAX_DENSITY = 20;
    const MAX_VARIETY = 10;
    const MAX_ADDRESS = 20;

    function scoreUrl(url) {
        let best = { score: 0, type: "unknown", matched: null };

        for (const pattern of URL_PATTERNS) {
            if (pattern.re.test(url) && pattern.score > best.score) {
                best = { score: pattern.score, type: pattern.type, matched: String(pattern.re) };
            }
        }

        return best;
    }

    function scoreTitle(doc) {
        const heading = doc.querySelector("h1");
        const candidates = [doc.title || "", heading ? heading.textContent : ""]
            .map((t) => t.replace(/\s+/g, " ").trim())
            .filter(Boolean);

        let best = { score: 0, type: "unknown", matched: null };

        for (const text of candidates) {
            for (const pattern of TITLE_PATTERNS) {
                if (pattern.re.test(text) && pattern.score > best.score) {
                    best = { score: pattern.score, type: pattern.type, matched: text };
                }
            }
        }

        return best;
    }

    function scoreDensity(text, wordCount) {
        if (wordCount === 0) {
            return { score: 0, per1000: 0, distinct: 0, total: 0 };
        }

        let total = 0;
        let distinct = 0;

        for (const marker of LEGAL_MARKERS) {
            marker.lastIndex = 0;

            const matches = text.match(marker);

            if (matches) {
                total += matches.length;
                distinct += 1;
            }
        }

        const per1000 = (total / wordCount) * 1000;

        // Density carries more weight than variety, but variety guards against a
        // page that simply repeats one word many times.
        const densityScore = Math.min(1, per1000 / DENSITY_SATURATION) * MAX_DENSITY;
        const varietyScore = Math.min(1, distinct / VARIETY_SATURATION) * MAX_VARIETY;

        return {
            score: densityScore + varietyScore,
            per1000: Math.round(per1000 * 10) / 10,
            distinct,
            total
        };
    }

    function countMatches(text, pattern) {
        const matches = text.match(pattern);

        return matches ? matches.length : 0;
    }

    function scoreAddress(text, wordCount) {
        if (wordCount === 0) {
            return { score: 0, per1000: 0, second: 0, first: 0, impersonal: true };
        }

        const second = countMatches(text, SECOND_PERSON);
        const first = countMatches(text, FIRST_PERSON);
        const per1000 = ((second + first) / wordCount) * 1000;

        return {
            score: Math.min(1, per1000 / ADDRESS_SATURATION) * MAX_ADDRESS,
            per1000: Math.round(per1000 * 10) / 10,
            second,
            first,
            impersonal: per1000 < ADDRESS_GATE
        };
    }

    function pickDocType(urlSignal, titleSignal) {
        if (titleSignal.type !== "unknown") {
            return titleSignal.type;
        }

        if (urlSignal.type !== "unknown") {
            return urlSignal.type;
        }

        return "unknown";
    }

    /**
     * @param {Document} doc
     * @param {string} url
     * @param {string} text  the extracted policy text, not raw innerText
     * @param {number} wordCount
     */
    function detectPage(doc, url, text, wordCount) {
        const urlSignal = scoreUrl(url);
        const titleSignal = scoreTitle(doc);
        const densitySignal = scoreDensity(text, wordCount);
        const addressSignal = scoreAddress(text, wordCount);

        const score = Math.round(
            Math.min(MAX_URL, urlSignal.score) +
            Math.min(MAX_TITLE, titleSignal.score) +
            densitySignal.score +
            addressSignal.score
        );

        const longEnough = wordCount >= MIN_WORDS;

        // The address gate is a veto rather than another summand: a page titled
        // "Privacy policy" at a /privacy URL scores well on everything else, so
        // only a hard rule keeps an article about policies out.
        const isPolicy = score >= SCORE_THRESHOLD && longEnough && !addressSignal.impersonal;

        return {
            isPolicy,
            score,
            threshold: SCORE_THRESHOLD,
            tooShort: !longEnough,
            impersonal: addressSignal.impersonal,
            confidence: score >= 70 ? "high" : score >= SCORE_THRESHOLD ? "medium" : "low",
            docType: pickDocType(urlSignal, titleSignal),
            signals: {
                url: urlSignal,
                title: titleSignal,
                density: densitySignal,
                address: addressSignal
            }
        };
    }

    /* ----------------------------------------------------- policy links out */

    const LINK_TEXT = /\b(terms|conditions|privacy|policy|policies|eula|licen[cs]e agreement|legal)\b/i;
    /**
     * Language that means "clicking this commits you". Broad enough to cover the
     * common phrasings, narrow enough that ordinary prose does not match.
     */
    const AGREEMENT_TEXT = /\b(i (agree|accept|consent)|you (agree|accept|consent|acknowledge)|by (signing up|signing in|creating|clicking|continuing|registering|submitting|proceeding)|(agree|accept|consent) to (the|our|these)|terms (and conditions )?apply)\b/i;

    function classifyLink(href, text) {
        if (/privacy/i.test(href) || /privacy/i.test(text)) {
            return "privacy_policy";
        }

        if (/cookie/i.test(href) || /cookie/i.test(text)) {
            return "cookie_policy";
        }

        if (/eula|licen[cs]e/i.test(href) || /eula|licen[cs]e/i.test(text)) {
            return "eula";
        }

        if (/terms|tos|conditions/i.test(href) || /terms|conditions/i.test(text)) {
            return "terms";
        }

        return "unknown";
    }

    /**
     * Is this link sitting next to something the user is about to click "agree"
     * on? That is the moment worth interrupting -- see Phase 4.
     */
    const CONTROL_SELECTOR =
        "input[type='checkbox'], input[type='submit'], button, [role='checkbox'], [role='button']";

    /**
     * "Near" has to mean near. Climbing to <body> would match any page that has
     * a button somewhere and the words "I agree" somewhere else, so containers
     * big enough to be the whole page are not evidence of anything.
     */
    const MAX_CONTAINER_CHARS = 800;

    const NON_CONTAINERS = new Set(["BODY", "HTML", "MAIN"]);

    function nearAgreementControl(anchor) {
        let node = anchor;

        for (let i = 0; i < 4 && node; i += 1) {
            node = node.parentElement;

            if (!node || NON_CONTAINERS.has(node.tagName)) {
                break;
            }

            const isForm = node.tagName === "FORM";

            if (!isForm && node.textContent.length > MAX_CONTAINER_CHARS) {
                continue;
            }

            if (!node.querySelector(CONTROL_SELECTOR)) {
                continue;
            }

            // Being inside a form is not consent. Plenty of ordinary pages have
            // a search or newsletter form and a footer link to their terms, and
            // treating that as "you are about to agree" put the panel on home
            // pages. Agreement has to be stated, not inferred from a <form>.
            if (AGREEMENT_TEXT.test(node.textContent)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Find links out to policies on an ordinary page (a signup form, a checkout,
     * a footer). Deduplicated by resolved href.
     */
    function findPolicyLinks(doc, baseUrl) {
        const seen = new Map();

        for (const anchor of doc.querySelectorAll("a[href]")) {
            const raw = anchor.getAttribute("href");

            if (!raw || raw.startsWith("javascript:") || raw.startsWith("#")) {
                continue;
            }

            const text = anchor.textContent.replace(/\s+/g, " ").trim();

            // The visible text has to carry the signal. Matching on the href
            // alone turns any page that happens to link to /policy/... into a
            // wall of false positives -- an article about privacy policies
            // produced 111 of them before this was tightened.
            if (!LINK_TEXT.test(text)) {
                continue;
            }

            if (text.length === 0 || text.length > 80) {
                continue;
            }

            // "Privacy Policy" as a bare link is a policy; "our privacy policy
            // explains how we handle cookies and other tracking technology" is
            // a sentence that happens to be linked.
            if (text.split(/\s+/).length > 6) {
                continue;
            }

            let href;

            try {
                href = new URL(raw, baseUrl).href;
            } catch (error) {
                continue;
            }

            if (href === baseUrl) {
                continue;
            }

            const nearAgreement = nearAgreementControl(anchor);
            const existing = seen.get(href);

            if (existing) {
                existing.nearAgreement = existing.nearAgreement || nearAgreement;
                continue;
            }

            let sameOrigin = false;

            try {
                sameOrigin = new URL(href).origin === new URL(baseUrl).origin;
            } catch (error) {
                sameOrigin = false;
            }

            seen.set(href, {
                href,
                text,
                kind: classifyLink(raw, text),
                nearAgreement,
                sameOrigin
            });
        }

        const links = Array.from(seen.values());

        // Links beside an agreement control are the interesting ones; after that,
        // this site's own policies beat policies it merely links out to.
        links.sort((a, b) =>
            Number(b.nearAgreement) - Number(a.nearAgreement) ||
            Number(b.sameOrigin) - Number(a.sameOrigin)
        );

        return links;
    }

    /**
     * A near-free test run on every page load before anything expensive.
     *
     * Full extraction costs 100ms+ on a large document, which is not a price
     * worth paying on every page just in case. Real policies almost always
     * announce themselves in the URL, the title or the first heading, so this
     * looks only at those.
     */
    function looksLikePolicyPage(doc, url) {
        if (scoreUrl(url).score >= 18) {
            return true;
        }

        return scoreTitle(doc).score >= 26;
    }

    /**
     * Is there anything on this page to agree to? Cheap enough to run before
     * walking every anchor looking for policy links.
     */
    function hasAgreementControls(doc) {
        const control = doc.querySelector(
            "input[type='checkbox'], input[type='submit'], button[type='submit'], form"
        );

        return Boolean(control);
    }

    PolicyGuard.detect = {
        detectPage,
        findPolicyLinks,
        looksLikePolicyPage,
        hasAgreementControls,
        SCORE_THRESHOLD,
        MIN_WORDS
    };
})();
