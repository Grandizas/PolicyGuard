/**
 * Content hashing for cache keys.
 *
 * The cache key is deliberately hostname + normalised text rather than the URL:
 * the same policy is often reachable at several URLs, and query strings and
 * fragments should not cause a cache miss.
 */

/** Zero-width space, ZWNJ, ZWJ and BOM -- invisible, and common in pasted legal text. */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/**
 * Strip the things that vary between visits without changing the policy:
 * invisible characters and whitespace runs.
 */
export function normalizeForHash(text) {
    return text
        .replace(ZERO_WIDTH, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

export async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

export async function contentHash(hostname, text) {
    return sha256(hostname + " " + normalizeForHash(text));
}
