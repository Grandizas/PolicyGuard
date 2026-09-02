/**
 * The in-page badge (mockup 4).
 *
 * The popup only helps someone who thinks to open it. On a signup form nobody
 * does -- which is exactly the moment the warning is worth having. This puts a
 * small, dismissible summary on the page itself.
 *
 * Everything lives inside a shadow root with `all: initial`, because this runs
 * on arbitrary sites and a host page's CSS must not be able to reshape it --
 * nor ours to leak out and reshape theirs.
 */
(function () {
    "use strict";

    const PolicyGuard = (globalThis.PolicyGuard = globalThis.PolicyGuard || {});

    const HOST_ID = "policy-guard-badge-host";

    const SEVERITY_LABELS = {
        high: "High",
        medium: "Medium",
        low: "Low",
        good: "In your favour"
    };

    const RISK_LABELS = {
        high: "High risk",
        medium: "Medium risk",
        low: "Low risk"
    };

    const CSS = `
        :host { all: initial; }

        .card {
            position: fixed;
            right: 16px;
            bottom: 16px;
            z-index: 2147483647;

            box-sizing: border-box;
            width: 320px;
            max-height: 60vh;
            overflow-y: auto;
            padding: 12px 14px;

            background: #16181c;
            color: #f2f3f5;
            border: 1px solid #2a2c31;
            border-radius: 10px;
            box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);

            font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
            font-size: 13px;
            line-height: 1.5;
            text-align: left;
        }

        @media (prefers-color-scheme: light) {
            .card {
                background: #ffffff;
                color: #17181c;
                border-color: #e3e4e8;
            }
        }

        .top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .name { font-weight: 700; font-size: 12px; letter-spacing: 0.02em; flex: 1 1 auto; }

        .close {
            flex: 0 0 auto;
            width: 22px; height: 22px; padding: 0;
            border: none; border-radius: 5px;
            background: transparent; color: inherit;
            opacity: 0.6; cursor: pointer;
            font-size: 15px; line-height: 1;
        }
        .close:hover { opacity: 1; }

        .pill {
            padding: 2px 8px; border-radius: 999px;
            font-size: 10px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.04em;
            color: #14161a;
        }
        .risk-high { background: #ff6b78; }
        .risk-medium { background: #f0a145; }
        .risk-low { background: #4ec27d; }

        .count { font-weight: 600; }

        ul { list-style: none; margin: 8px 0 0; padding: 0; }
        li { padding: 7px 0; border-top: 1px solid #2a2c31; }
        @media (prefers-color-scheme: light) { li { border-top-color: #e3e4e8; } }

        .row { display: flex; align-items: center; gap: 7px; }
        .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
        .sev-high { background: #ff6b78; }
        .sev-medium { background: #f0a145; }
        .sev-low { background: #9a9da7; }
        .sev-good { background: #4ec27d; }

        .title { font-weight: 600; flex: 1 1 auto; }
        .sev { font-size: 10px; opacity: 0.7; }
        .desc { margin: 3px 0 0 15px; opacity: 0.75; font-size: 12px; }

        .foot { margin-top: 10px; display: flex; align-items: center; gap: 8px; }

        button.action {
            padding: 6px 11px;
            border: none; border-radius: 6px;
            background: #7d9bff; color: #14161a;
            font-family: inherit; font-size: 12px; font-weight: 600;
            cursor: pointer;
        }
        button.action:disabled { opacity: 0.6; cursor: default; }

        .note { font-size: 11px; opacity: 0.6; }
        .more { margin-top: 8px; font-size: 11px; opacity: 0.6; }

        button.link {
            padding: 0; border: none; background: none;
            color: #7d9bff; font-family: inherit; font-size: 11px;
            text-decoration: underline; cursor: pointer;
        }
        @media (prefers-color-scheme: light) { button.link { color: #3b6df5; } }

        .quote {
            margin: 5px 0 0 15px; padding: 6px 8px;
            border-left: 2px solid #2a2c31; border-radius: 0 4px 4px 0;
            font-size: 11px; opacity: 0.85;
        }
        @media (prefers-color-scheme: light) { .quote { border-left-color: #e3e4e8; } }

        .item-actions { margin: 5px 0 0 15px; display: flex; gap: 10px; }

        .foot-links {
            margin-top: 10px; padding-top: 8px;
            border-top: 1px solid #2a2c31;
            display: flex; gap: 12px; flex-wrap: wrap; align-items: center;
        }
        @media (prefers-color-scheme: light) { .foot-links { border-top-color: #e3e4e8; } }

        button:focus-visible, .close:focus-visible {
            outline: 2px solid #7d9bff; outline-offset: 2px;
        }

        @media (prefers-reduced-motion: no-preference) {
            .card { animation: rise 160ms ease-out; }
            @keyframes rise {
                from { opacity: 0; transform: translateY(8px); }
                to { opacity: 1; transform: none; }
            }
        }
    `;

    let host = null;
    let root = null;

    function remove() {
        if (host) {
            host.remove();
            host = null;
            root = null;
        }
    }

    function ensureRoot() {
        if (root) {
            return root;
        }

        host = document.createElement("div");
        host.id = HOST_ID;

        root = host.attachShadow({ mode: "closed" });

        const style = document.createElement("style");

        style.textContent = CSS;
        root.append(style);

        document.documentElement.append(host);

        return root;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);

        if (className) {
            node.className = className;
        }

        if (text !== undefined) {
            node.textContent = text;
        }

        return node;
    }

    function buildCard(onDismiss) {
        const card = el("div", "card");

        card.setAttribute("role", "complementary");
        card.setAttribute("aria-label", "Policy Guard summary");

        const top = el("div", "top");

        top.append(el("span", "name", "Policy Guard"));

        const close = el("button", "close", "×");

        close.setAttribute("aria-label", "Dismiss Policy Guard for this site");
        close.addEventListener("click", onDismiss);
        top.append(close);

        card.append(top);

        return card;
    }

    /* ------------------------------------------------------------- policy */

    /** Collapsed by default; the panel should not dominate the page. */
    const COLLAPSED_COUNT = 4;

    let expanded = false;

    /**
     * Summary for a policy page the reader is already on.
     *
     * The panel expands in place rather than sending people to the toolbar.
     * Pointing at a button someone may never have noticed -- and which Firefox
     * may not even have pinned -- is not a way to show them the rest.
     */
    function showPolicy(data, handlers) {
        const { riskLevel, counts, findings } = data;
        const shadow = ensureRoot();

        for (const node of Array.from(shadow.querySelectorAll(".card"))) {
            node.remove();
        }

        const card = buildCard(handlers.onDismiss);
        const head = el("div", "top");

        head.append(el("span", "pill risk-" + riskLevel, RISK_LABELS[riskLevel]));
        head.append(el(
            "span",
            "count",
            counts.concerns === 1 ? "1 concern found" : `${counts.concerns} concerns found`
        ));

        card.append(head);

        const list = el("ul");
        const shown = expanded ? findings : findings.slice(0, COLLAPSED_COUNT);

        for (const finding of shown) {
            const item = el("li");
            const row = el("div", "row");

            row.append(el("span", "dot sev-" + finding.severity));
            row.append(el("span", "title", finding.title));
            row.append(el("span", "sev", SEVERITY_LABELS[finding.severity]));

            item.append(row);
            item.append(el("div", "desc", finding.description));

            // The citation is the point, so the expanded view carries it.
            if (expanded && finding.quote) {
                item.append(el("div", "quote", finding.quote));

                const actions = el("div", "item-actions");
                const show = el("button", "link", "Show on page");

                show.addEventListener("click", () => handlers.onShowQuote(finding.quote));
                actions.append(show);
                item.append(actions);
            }

            list.append(item);
        }

        card.append(list);

        const links = el("div", "foot-links");

        if (findings.length > COLLAPSED_COUNT) {
            const toggle = el(
                "button",
                "link",
                expanded ? "Show fewer" : `Show all ${findings.length}`
            );

            toggle.addEventListener("click", () => {
                expanded = !expanded;
                showPolicy(data, handlers);
            });

            links.append(toggle);
        }

        const settings = el("button", "link", "Settings");

        settings.addEventListener("click", handlers.onOpenSettings);
        links.append(settings);

        card.append(links);

        // Mentioned once, as a fact rather than an instruction, since the panel
        // no longer depends on anyone finding it.
        card.append(el(
            "div",
            "note",
            "The Policy Guard toolbar button has the same detail, plus AI analysis. Informational only — not legal advice."
        ));

        shadow.append(card);
    }

    /* ------------------------------------------------------------- signup */

    /**
     * The pre-agreement case: a form asking for consent to documents nobody has
     * read. Offers to read them in place.
     */
    function showAgreementPrompt({ links, results }, handlers) {
        const shadow = ensureRoot();

        for (const node of Array.from(shadow.querySelectorAll(".card"))) {
            node.remove();
        }

        const card = buildCard(handlers.onDismiss);

        card.append(el(
            "div",
            "count",
            links.length === 1
                ? "This form asks you to agree to a policy"
                : `This form asks you to agree to ${links.length} policies`
        ));

        const list = el("ul");

        for (const link of links) {
            const item = el("li");
            const result = results[link.href];

            item.append(el("div", "title", link.text));

            if (result && result.status === "done" && result.isPolicy) {
                const row = el("div", "row");

                row.append(el("span", "pill risk-" + result.riskLevel, RISK_LABELS[result.riskLevel]));
                row.append(el(
                    "span",
                    "count",
                    result.counts.concerns === 1 ? "1 concern" : `${result.counts.concerns} concerns`
                ));

                item.append(row);

                for (const finding of result.findings.slice(0, 3)) {
                    const line = el("div", "row");

                    line.append(el("span", "dot sev-" + finding.severity));
                    line.append(el("span", "title", finding.title));
                    item.append(line);
                }
            } else if (result && result.status === "running") {
                item.append(el("div", "note", "Reading it…"));
            } else if (result && result.status === "error") {
                item.append(el("div", "note", result.error));
            }

            list.append(item);
        }

        card.append(list);

        const unread = links.filter((link) => !results[link.href]);

        if (unread.length > 0) {
            const foot = el("div", "foot");
            const button = el("button", "action", unread.length === 1 ? "Read it" : "Read them");

            button.addEventListener("click", () => {
                button.disabled = true;
                button.textContent = "Reading…";
                handlers.onCheck(unread.map((link) => link.href));
            });

            foot.append(button);
            foot.append(el("span", "note", "Without opening the page."));
            card.append(foot);
        }

        const footLinks = el("div", "foot-links");
        const settings = el("button", "link", "Settings");

        settings.addEventListener("click", handlers.onOpenSettings);
        footLinks.append(settings);
        footLinks.append(el("span", "note", "Or use the Policy Guard toolbar button."));
        card.append(footLinks);

        shadow.append(card);
    }

    PolicyGuard.badge = { showPolicy, showAgreementPrompt, remove };
})();
