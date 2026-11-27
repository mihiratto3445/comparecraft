// package.json holds the one release version. `npm version` bumps it, writes the release commit and
// tags it v<version>; `src-tauri/tauri.conf.json` points at it ("version": "../package.json"), so
// Tauri stamps the same number into the deb/rpm/AppImage, NSIS/MSI and app/dmg names and metadata.
// This script carries the number into the manifests npm cannot bump itself: Cargo (the console and
// backend helpers report it), the Arch PKGBUILD and the VS Code extension. npm's `version` lifecycle
// hook runs `set`, so a single `npm version minor` keeps every shipped version number identical.
//
// Release builds may also be stamped from the GitHub release tag (vN.N.N or vN.N.N-pre.N): CI and
// the Arch package pass it to builds as COMPARECRAFT_VERSION, and the app reports it via appVersion.
// The tag helpers (parseTag/requireTag/releaseConfig/pkgver/appVersion) support that flow alongside
// the package.json single-source commands (check/set).
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAURI_CONFIG = "src-tauri/tauri.conf.json";
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Patterns capture prefix, version and suffix so only the version itself is rewritten. The
 * package.json ones are anchored to a top-level key so nested `scripts.version` stays untouched. */
function targets(root) {
  const target = (file, pattern, count, label) => ({ file, path: resolve(root, file), pattern, count, label });
  const topLevel = /^((?: {2}|\t)"version"\s*:\s*")([^"]*)(")/gm;
  return [
    target("package.json", topLevel, 1, "release version"),
    target("package-lock.json", /("name"\s*:\s*"comparecraft"\s*,\s*"version"\s*:\s*")([^"]*)(")/g, 2, "lockfile version"),
    target("src-tauri/Cargo.toml", /(^version\s*=\s*")([^"]*)(")/gm, 1, "crate version"),
    target("src-tauri/Cargo.lock", /(\[\[package\]\]\r?\nname = "comparecraft"\r?\nversion = ")([^"]*)(")/g, 1, "lockfile crate version"),
    target("packaging/arch/PKGBUILD", /(^pkgver=)([^\r\n]+)(\r?$)/gm, 1, "Arch package version"),
    target("extensions/vscode/package.json", topLevel, 1, "VS Code extension version"),
    target("extensions/vscode/package-lock.json", /("name"\s*:\s*"comparecraft"\s*,\s*"version"\s*:\s*")([^"]*)(")/g, 2, "extension lockfile version"),
  ];
}

function entries(pattern, text) {
  return [...text.matchAll(pattern)].map((match) => ({ prefix: match[1], version: match[2], suffix: match[3] }));
}

/** The version every artifact must carry. */
export function readVersion(root = process.cwd()) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
}

/** Every declaration that disagrees with package.json, or with the release tag. */
export function verifyVersions({ root = process.cwd(), tag } = {}) {
  const version = readVersion(root);
  const problems = [];
  if (!SEMVER.test(version)) {
    problems.push(`package.json uses "${version}", which is not a N.N.N version.`);
  }
  const config = readFileSync(resolve(root, TAURI_CONFIG), "utf8");
  if (!/"version"\s*:\s*"\.\.\/package\.json"/.test(config)) {
    problems.push(`${TAURI_CONFIG}: "version" must point at ../package.json so installers inherit the release version.`);
  }
  for (const target of targets(root)) {
    const found = entries(target.pattern, readFileSync(target.path, "utf8"));
    if (found.length !== target.count) {
      problems.push(`${target.file}: expected ${target.count} ${target.label} field(s), found ${found.length}.`);
      continue;
    }
    for (const entry of found) {
      if (entry.version !== version) {
        problems.push(`${target.file}: ${target.label} is ${entry.version}, but package.json is ${version}.`);
      }
    }
  }
  if (tag != null && tag !== `v${version}`) {
    problems.push(`Release tag ${tag} does not match the ${version} version in the tagged source.`);
  }
  return { version, problems };
}

/**
 * Rewrites every declaration to `version`, which defaults to the one package.json already holds
 * (npm has written it by the time the `version` lifecycle hook runs). Returns the files changed.
 */
export function setVersion(version, { root = process.cwd(), tag } = {}) {
  const target = version ?? readVersion(root);
  if (!SEMVER.test(target)) throw new Error(`Invalid version "${String(target)}"; expected N.N.N.`);
  if (tag != null && tag !== `v${target}`) throw new Error(`Release tag ${tag} does not match version v${target}.`);
  const updated = [];
  for (const item of targets(root)) {
    const text = readFileSync(item.path, "utf8");
    const found = entries(item.pattern, text);
    if (found.length !== item.count) {
      throw new Error(`${item.file}: expected ${item.count} ${item.label} field(s), found ${found.length}.`);
    }
    if (found.every((entry) => entry.version === target)) continue;
    const next = text.replace(item.pattern, (_match, prefix, _old, suffix) => `${prefix}${target}${suffix}`);
    writeFileSync(item.path, next);
    updated.push(item.file);
  }
  return updated;
}

/** Version parts of a release tag, or null when the tag is not a release tag. */
export function parseTag(tag) {
  const m = TAG.exec(String(tag).trim());
  if (!m) return null;
  const [, major, minor, patch, pre] = m;
  // MSI versions are limited to 255.255.65535 and cannot carry pre-release text.
  if (+major > 255 || +minor > 255 || +patch > 65535) return null;
  const numeric = `${major}.${minor}.${patch}`;
  return { version: pre ? `${numeric}-${pre}` : numeric, numeric, prerelease: pre ?? null };
}

export function requireTag(tag) {
  const parsed = parseTag(tag);
  if (!parsed) throw new Error(`"${tag}" is not a release tag; use vN.N.N or vN.N.N-pre (for example v1.2.3 or v1.2.3-beta.1).`);
  return parsed;
}

/**
 * Tauri config overlay that names the installers and sets the bundle versions. MSI and the macOS
 * bundle version must be numeric. RPM versions cannot contain "-", so pre-releases skip the RPM.
 */
export function releaseConfig({ version, numeric }, baseTargets = BASE_TARGETS()) {
  const bundle = {
    windows: { wix: { version: numeric } },
    macOS: { bundleVersion: numeric },
  };
  if (version !== numeric) bundle.targets = baseTargets.filter((target) => target !== "rpm");
  return { version, bundle };
}

const BASE_TARGETS = () =>
  JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")).bundle.targets;

/** pacman pkgver for `git describe --tags --long` output such as v1.2.3-beta.1-4-gabc123. */
export function pkgver(describe) {
  const m = /^(v.+)-(\d+)-g([0-9a-f]+)$/.exec(String(describe).trim());
  if (!m) throw new Error(`Unexpected git describe output: ${describe}`);
  const { numeric, prerelease } = requireTag(m[1]);
  // pacman orders "1.2.3beta.1" before "1.2.3"; hyphens are not allowed in pkgver.
  const base = prerelease ? `${numeric}${prerelease.replaceAll("-", "_")}` : numeric;
  return m[2] === "0" ? base : `${base}.r${m[2]}.g${m[3]}`;
}

/** Version shown by the app: COMPARECRAFT_VERSION when set, otherwise `<package.json version>-dev`. */
export function appVersion(env = process.env) {
  const stamped = env.COMPARECRAFT_VERSION?.trim();
  if (stamped) return stamped;
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return `${version}-dev`;
}

export const RELEASE_CONFIG = resolve("src-tauri/tauri.release.conf.json");

function writeRelease(tag, env = process.env) {
  const parsed = requireTag(tag);
  writeFileSync(RELEASE_CONFIG, `${JSON.stringify(releaseConfig(parsed), null, 2)}\n`);
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `COMPARECRAFT_VERSION=${parsed.version}\n`);
  return parsed;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function usage() {
  return [
    "Usage: node scripts/version.mjs [check|set] [version] [--tag vN.N.N]",
    "       node scripts/version.mjs --github <tag> | --git | --pkgver | --check <tag>",
    "  check            verify every manifest agrees with package.json (default)",
    "  set [version]    write the version into every manifest (default: package.json's own)",
    "  --tag <tag>      also require v<version> to equal the release tag",
    "  --github <tag>   write the release config overlay and export COMPARECRAFT_VERSION",
    "  --git            print the version when HEAD is exactly on a release tag",
    "  --pkgver         print the pacman pkgver from git describe",
    "  --check <tag>    validate a release tag and print its version",
    "",
    "Releases run `npm version <major|minor|patch>`, which bumps package.json, calls `set` and tags v<version>.",
  ].join("\n");
}

function main(argv) {
  const mode = argv[0];
  if (mode === "--github") {
    const { version } = writeRelease(argv[1]);
    console.log(version);
    return;
  }
  if (mode === "--git") {
    let tag;
    try {
      tag = git("describe", "--tags", "--exact-match", "--match", "v*");
    } catch {
      return;
    }
    const parsed = parseTag(tag);
    if (parsed) console.log(parsed.version);
    return;
  }
  if (mode === "--pkgver") {
    let describe;
    try {
      describe = git("describe", "--tags", "--long", "--match", "v*");
    } catch {
      console.log(`0.0.0.r${git("rev-list", "--count", "HEAD")}.g${git("rev-parse", "--short", "HEAD")}`);
      return;
    }
    console.log(pkgver(describe));
    return;
  }
  if (mode === "--check") {
    console.log(requireTag(argv[1]).version);
    return;
  }
  const tagAt = argv.indexOf("--tag");
  const tag = tagAt >= 0 ? argv[tagAt + 1] : undefined;
  if (tagAt >= 0 && (tag == null || tag.startsWith("--"))) throw new Error("--tag requires a value such as v1.2.3.");
  const positional = tagAt >= 0 ? argv.filter((_, index) => index !== tagAt && index !== tagAt + 1) : argv;
  const command = positional[0] ?? "check";
  if (command === "check") {
    const { version, problems } = verifyVersions({ tag });
    if (problems.length) {
      console.error(`Version ${version} is not consistent:\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`CompareCraft ${version}: every artifact matches${tag ? ` the release tag ${tag}` : " the release."}`);
    return;
  }
  if (command === "set") {
    const updated = setVersion(positional[1], { tag });
    const version = readVersion();
    console.log(updated.length ? `Set version ${version} in:\n  ${updated.join("\n  ")}` : `Every manifest already uses ${version}.`);
    return;
  }
  throw new Error(`Unknown command "${command}".\n${usage()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
