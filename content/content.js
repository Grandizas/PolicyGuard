/**
 * Content script entry point.
 *
 * DOM work only: detect, extract, and (later) highlight. This script never
 * touches the network and never sees the API key.
 */
(function () {
    "use strict";

    const PolicyGuard = (globalThis.PolicyGuard = globalThis.PolicyGuard || {});

    // The background script may inject these files into a tab that already has
    // them (a tab loaded before the extension started). Register once.
    if (PolicyGuard.listenerInstalled) {
        return;
    }

    PolicyGuard.listenerInstalled = true;

    const PREVIEW_CHARS = 400;

    /** Sections without their body text -- enough for the UI, small enough to store. */
    function sectionOutline(sections) {
        return sections.map((section) => ({
            heading: section.heading,
            level: section.level,
            wordCount: section.wordCount,
            charStart: section.charStart,
            charEnd: section.charEnd
        }));
    }

    /**
     * Analyse HTML the background fetched, rather than the page we are on.
     *
     * This is how a policy linked from a signup form gets read without opening
     * it. DOMParser runs no scripts and loads no subresources, so nothing on
     * that page can see the visit -- but the document also has no layout, so
     * `getComputedStyle` is unavailable and visibility-based filtering is
     * skipped. Structural junk removal still applies.
     */
    function scanHtml(html, url) {
        const parsed = new DOMParser().parseFromString(html, "text/html");
        const extraction = PolicyGuard.extract.extractPolicy(parsed);

        const detection = PolicyGuard.detect.detectPage(
            parsed,
            url,
            extraction.fullText,
            extraction.wordCount
        );

        return {
            url,
            hostname: new URL(url).hostname,
            title: parsed.title,
            detection,
            extraction: {
                method: extraction.method,
                wordCount: extraction.wordCount,
                charCount: extraction.charCount,
                blockCount: extraction.blockCount,
                sectionCount: extraction.sections.length,
                sections: sectionOutline(extraction.sections),
                degraded: extraction.degraded,
                collapsedSections: extraction.collapsedSections,
                unreadableFrames: 0,
                // The caller should know this was read without rendering.
                unrendered: true
            },
            policyLinks: [],
            preview: extraction.fullText.slice(0, PREVIEW_CHARS),
            fullText: extraction.fullText
        };
    }

    function scan() {
        const extraction = PolicyGuard.extract.extractPolicy(document);

        const detection = PolicyGuard.detect.detectPage(
            document,
            location.href,
            extraction.fullText,
            extraction.wordCount
        );

        // Only worth the walk when this page is not itself the policy.
        const policyLinks = detection.isPolicy
            ? []
            : PolicyGuard.detect.findPolicyLinks(document, location.href);

        return {
            url: location.href,
            hostname: location.hostname,
            title: document.title,
            detection,
            extraction: {
                method: extraction.method,
                wordCount: extraction.wordCount,
                charCount: extraction.charCount,
                blockCount: extraction.blockCount,
                sectionCount: extraction.sections.length,
                sections: sectionOutline(extraction.sections),
                degraded: extraction.degraded,
                collapsedSections: extraction.collapsedSections,
                unreadableFrames: extraction.unreadableFrames
            },
            policyLinks,
            preview: extraction.fullText.slice(0, PREVIEW_CHARS),
            fullText: extraction.fullText
        };
    }

    // Exposed so test/runner.html can exercise the real functions rather than
    // a copy of them.
    PolicyGuard.scan = scan;
    PolicyGuard.scanHtml = scanHtml;

    // Outside an extension there is no messaging to attach to; the functions
    // above are still usable, which is what the test runner relies on.
    if (typeof browser === "undefined" || !browser.runtime) {
        return;
    }

    browser.runtime.onMessage.addListener((message) => {
        if (!message || typeof message.type !== "string") {
            return undefined;
        }

        switch (message.type) {
            case "PG_PING":
                return Promise.resolve({ ready: true });

            case "PG_SCAN":
                try {
                    return Promise.resolve({ ok: true, payload: scan() });
                } catch (error) {
                    return Promise.resolve({ ok: false, error: String(error) });
                }

            case "PG_SCAN_HTML":
                try {
                    return Promise.resolve({
                        ok: true,
                        payload: scanHtml(message.html, message.url)
                    });
                } catch (error) {
                    return Promise.resolve({ ok: false, error: String(error) });
                }

            default:
                // Returning undefined lets other listeners handle it.
                return undefined;
        }
    });
})();
