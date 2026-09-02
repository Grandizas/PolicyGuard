# Policy Guard — Privacy Policy

Last updated: 2 September 2026

Policy Guard is a Firefox extension that reads Terms of Service and Privacy
Policies and summarises what is worth being cautious about.

This document describes exactly what the extension does with your data. It is
short because the extension does very little.

## The short version

- **Nothing leaves your browser unless you switch on AI analysis and press a
  button.** Out of the box, Policy Guard makes no network requests of any kind.
- **There is no server, no account, and no telemetry.** No analytics, no crash
  reporting, no usage statistics. The author receives nothing and cannot see
  what you browse.
- **If you turn on AI analysis**, the text of the policy page you are reading is
  sent to Anthropic's API using *your own* API key, at the moment you press the
  button, and not before.

## What runs by default

Pattern matching runs entirely on your device. It reads the text of pages you
visit to work out whether they are a policy, and matches that text against a
list of patterns bundled with the extension. This happens in your browser. The
page text is not transmitted, and it is not written to disk.

## What is stored on your device

All of this lives in Firefox's extension storage, on your computer only:

| What | Why | How long |
| --- | --- | --- |
| Your settings | To remember your preferences | Until you change or remove them |
| Your API key (if you add one) | To make AI requests on your behalf | Until you remove it |
| Cached AI analyses | So the same policy is not paid for twice | 30 days, then deleted automatically |
| Dismissed sites | So a panel you closed stays closed | Until extension data is cleared |
| The current tab's analysis | To show it in the popup | Cleared when you navigate or close the tab |

Cached analyses contain the findings and the quoted sentences they came from —
which is text from the policy page, not from you. You can delete all of it at
any time with **Clear cached analyses** in the extension's settings.

**Your API key is not encrypted.** Firefox extension storage is not a secure
vault. Anything able to read your Firefox profile — you, other software running
under your user account, someone with access to your unlocked machine — can read
it. Use a key you are willing to rotate, and set a spend limit on it.

## What is sent, and to whom

Policy Guard contacts exactly two kinds of destination, both only when you ask:

**1. Anthropic (`api.anthropic.com`)** — only if you enable AI analysis, provide
an API key, accept the on-screen disclosure, and press the analysis button on a
page. What is sent: the extracted text of that policy document, and the name of
the site it came from. What is not sent: anything about your browsing history,
your other tabs, cookies, or any personal identifier the extension has invented.
Your use of the API is governed by your own agreement with Anthropic, and their
handling of it is described in their own privacy policy.

**2. A website whose policy you asked to read** — when you use "Check this
policy" or "Read it" on a form, the extension fetches that policy page. The
request is made **without cookies** (`credentials: "omit"`), so it is not tied
to any account you have there, and none of that page's scripts are ever run.

There are no other network requests. The extension does not phone home.

## What is never collected

- Browsing history
- Passwords, form contents, or anything you type
- Cookies or session tokens
- Any identifier for you or your device
- Anything at all when the AI feature is off

## Permissions and why

| Permission | Why |
| --- | --- |
| `activeTab`, `scripting` | Read the text of the page you are on when you ask for analysis |
| `storage` | Keep your settings, key and cache on your device |
| Content scripts on all sites | Detect whether a page is a policy, and show the on-page panel |
| `api.anthropic.com` (optional) | Only requested when you enable AI analysis |
| All sites (optional) | Only requested if you opt in to reading linked policies from the on-page panel |

The optional permissions are not granted at install. Firefox asks you, and the
extension works without them.

## Children

Policy Guard is not directed at children and collects nothing from anyone.

## Removing your data

Uninstalling the extension removes everything it has stored. To clear specific
data without uninstalling, use the extension's settings: **Remove key** and
**Clear cached analyses**.

## Changes

If this policy changes in a way that affects what is sent or stored, the version
of the extension that makes that change will say so on its first run.

## Contact

Issues and questions: https://github.com/Grandizas/PolicyGuard/issues
