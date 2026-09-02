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

            default:
                // Returning undefined lets other listeners handle it.
                return undefined;
        }
    });
})();
