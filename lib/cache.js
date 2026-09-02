/**
 * Analysis cache.
 *
 * Policies change perhaps twice a year, so paying to read the same one twice is
 * pure waste. Only tier 2 results are cached: tier 1 is instant and free, and
 * caching it would just serve stale findings after a patterns.json change.
 *
 * Entries are keyed by the content itself rather than the URL, because the same
 * document is often reachable at several URLs and a query string should not
 * cause a miss.
 */

const PREFIX = "cache:";
const INDEX_KEY = "cacheIndex";

/** Long enough to matter, short enough that a rewritten policy is re-read. */
export const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Soft ceiling. Least-recently-used entries go first once it is passed. */
export const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Model and concern preferences both change what the model is asked for, so
 * both belong in the key -- otherwise a Haiku reading gets served to someone
 * who has since switched to Opus.
 */
export function cacheKey({ contentHash, model, concerns = [] }) {
    const concernPart = concerns.length === 0
        ? "all"
        : concerns.slice().sort().join(",");

    return `${contentHash}|${model}|${concernPart}`;
}

function approximateBytes(value) {
    // Close enough to rank entries by size; exact accounting is not worth a
    // second serialisation pass.
    return JSON.stringify(value).length;
}

/* ------------------------------------------------------------------ pruning */

/**
 * Pure: decide what to drop. Expired entries first, then least-recently-used
 * until the total fits.
 *
 * @param {Array} index  entries of { key, storedAt, lastUsed, bytes }
 * @returns {{keep: Array, evict: Array, bytes: number}}
 */
export function selectEvictions(index, now, maxBytes = MAX_BYTES, ttlMs = TTL_MS) {
    const evict = [];
    const live = [];

    for (const entry of index) {
        if (now - entry.storedAt >= ttlMs) {
            evict.push(entry);
        } else {
            live.push(entry);
        }
    }

    let bytes = live.reduce((sum, entry) => sum + entry.bytes, 0);

    if (bytes > maxBytes) {
        // Oldest use first, so the entries someone actually revisits survive.
        live.sort((a, b) => a.lastUsed - b.lastUsed);

        while (bytes > maxBytes && live.length > 0) {
            const victim = live.shift();

            bytes -= victim.bytes;
            evict.push(victim);
        }
    }

    return { keep: live, evict, bytes };
}

/* ------------------------------------------------------------------ storage */

async function readIndex() {
    const stored = await browser.storage.local.get(INDEX_KEY);
    const index = stored[INDEX_KEY];

    return Array.isArray(index) ? index : [];
}

async function writeIndex(index) {
    await browser.storage.local.set({ [INDEX_KEY]: index });
}

/**
 * @returns {object|null} the cached value, or null on a miss or expiry
 */
export async function readCache(key, now = Date.now()) {
    const index = await readIndex();
    const entry = index.find((e) => e.key === key);

    if (!entry) {
        return null;
    }

    if (now - entry.storedAt >= TTL_MS) {
        await removeEntries([entry.key], index);
        return null;
    }

    const stored = await browser.storage.local.get(PREFIX + key);
    const value = stored[PREFIX + key];

    if (value === undefined) {
        // Index and storage disagree; trust storage and repair the index.
        await writeIndex(index.filter((e) => e.key !== key));
        return null;
    }

    entry.lastUsed = now;
    entry.hits = (entry.hits ?? 0) + 1;
    await writeIndex(index);

    return { value, storedAt: entry.storedAt, hits: entry.hits };
}

async function removeEntries(keys, index) {
    if (keys.length === 0) {
        return index;
    }

    await browser.storage.local.remove(keys.map((k) => PREFIX + k));

    const remaining = index.filter((e) => !keys.includes(e.key));

    await writeIndex(remaining);

    return remaining;
}

export async function writeCache(key, value, meta = {}, now = Date.now()) {
    const bytes = approximateBytes(value);

    await browser.storage.local.set({ [PREFIX + key]: value });

    const index = (await readIndex()).filter((e) => e.key !== key);

    index.push({
        key,
        storedAt: now,
        lastUsed: now,
        bytes,
        hits: 0,
        hostname: meta.hostname ?? null,
        model: meta.model ?? null
    });

    const { keep, evict } = selectEvictions(index, now);

    if (evict.length > 0) {
        await browser.storage.local.remove(evict.map((e) => PREFIX + e.key));
        await writeIndex(keep);
    } else {
        await writeIndex(index);
    }
}

export async function cacheStats(now = Date.now()) {
    const index = await readIndex();
    const { keep, bytes } = selectEvictions(index, now);

    return {
        entries: keep.length,
        bytes,
        expired: index.length - keep.length,
        hits: keep.reduce((sum, e) => sum + (e.hits ?? 0), 0),
        newest: keep.reduce((max, e) => Math.max(max, e.storedAt), 0)
    };
}

export async function clearCache() {
    const index = await readIndex();

    await browser.storage.local.remove(index.map((e) => PREFIX + e.key));
    await browser.storage.local.remove(INDEX_KEY);

    return index.length;
}
