/**
 * Confirm the packaged zip is the code currently on disk.
 *
 * `web-ext build` prints "Destination exists, overwriting", which reads like it
 * might have kept the old file. It has not -- but the version number is in the
 * filename, so rebuilding the same version always overwrites, and old versions
 * linger in the folder afterwards. Uploading a stale artifact to AMO is a real
 * and quiet mistake, so this checks rather than trusts.
 *
 * Run with: npm run verify
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ARTIFACT_DIR = "web-ext-artifacts";

function fail(message) {
    console.error("FAIL  " + message);
    process.exitCode = 1;
}

/**
 * Windows makes a byte-order mark easy to acquire by accident -- PowerShell's
 * `Set-Content -Encoding utf8` adds one, as do several editors -- and it makes
 * JSON.parse fail with an error that says nothing useful about the cause.
 */
function readJson(text, source) {
    try {
        return JSON.parse(text.replace(/^﻿/, ""));
    } catch (error) {
        console.error(`FAIL  ${source} is not valid JSON: ${error.message}`);
        process.exit(1);
    }
}

const manifest = readJson(readFileSync("manifest.json", "utf8"), "manifest.json");
const expected = `policy_guard-${manifest.version}.zip`;

let entries;

try {
    entries = readdirSync(ARTIFACT_DIR).filter((f) => f.endsWith(".zip"));
} catch (error) {
    fail(`no ${ARTIFACT_DIR}/ directory — run "npm run build" first.`);
    process.exit(1);
}

if (!entries.includes(expected)) {
    fail(`${expected} not found. Built artifacts: ${entries.join(", ") || "none"}`);
    process.exit(1);
}

const archive = join(ARTIFACT_DIR, expected);

// Read the manifest back out of the zip. Node has no zip reader, but every
// supported Windows and macOS/Linux host has one on the command line.
let packaged;

try {
    const raw = process.platform === "win32"
        ? execFileSync("powershell", [
            "-NoProfile", "-Command",
            `$ErrorActionPreference='Stop';` +
            `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
            `$z=[IO.Compression.ZipFile]::OpenRead((Resolve-Path '${archive}'));` +
            `$e=$z.GetEntry('manifest.json');` +
            `$r=New-Object IO.StreamReader($e.Open());` +
            `$r.ReadToEnd()`
        ], { encoding: "utf8" })
        : execFileSync("unzip", ["-p", archive, "manifest.json"], { encoding: "utf8" });

    packaged = readJson(raw, "the packaged manifest.json");
} catch (error) {
    fail("could not read manifest.json out of the archive: " + error.message);
    process.exit(1);
}

const stale = [];

for (const key of ["version", "name", "homepage_url"]) {
    if (JSON.stringify(packaged[key]) !== JSON.stringify(manifest[key])) {
        stale.push(`${key}: packaged ${JSON.stringify(packaged[key])} vs disk ${JSON.stringify(manifest[key])}`);
    }
}

const packagedId = packaged.browser_specific_settings?.gecko?.id;
const diskId = manifest.browser_specific_settings?.gecko?.id;

if (packagedId !== diskId) {
    stale.push(`extension id: packaged ${packagedId} vs disk ${diskId}`);
}

const sizeKb = Math.round(statSync(archive).size / 1024);
const others = entries.filter((f) => f !== expected);

console.log(`archive       ${archive}  (${sizeKb} KB)`);
console.log(`version       ${packaged.version}`);
console.log(`extension id  ${packagedId}`);

if (stale.length > 0) {
    console.log("");
    stale.forEach(fail);
    console.error('\nThe archive is out of date. Run "npm run build" again.');
} else {
    console.log("\nOK  packaged manifest matches the source on disk.");
}

// An ID nobody owns cannot be changed after the first AMO submission.
if (packagedId && /@example\.(com|org|net)$/.test(packagedId)) {
    fail("extension id still uses a placeholder domain — fix it before submitting.");
}

if (others.length > 0) {
    console.log(`\nAlso present, do not upload these: ${others.join(", ")}`);
}
