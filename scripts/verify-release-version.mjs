import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packageSection(toml) {
  const match = /^\[package\]\s*$/m.exec(toml);
  if (!match) {
    throw new Error("Unable to find [package] in src-tauri/Cargo.toml.");
  }
  const remainder = toml.slice(match.index + match[0].length);
  const nextSection = remainder.search(/^\[/m);
  return nextSection >= 0 ? remainder.slice(0, nextSection) : remainder;
}

function packageVersionFromCargoToml(toml) {
  const match = packageSection(toml).match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) {
    throw new Error("Unable to find package.version in src-tauri/Cargo.toml.");
  }
  return match[1];
}

function packageVersionFromCargoLock(lockfile, packageName) {
  const packages = lockfile.split(/^\[\[package\]\]\s*$/m).slice(1);
  for (const packageBlock of packages) {
    const name = packageBlock.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (name !== packageName) continue;
    const version = packageBlock.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (!version) {
      throw new Error(`Unable to find the version of ${packageName} in src-tauri/Cargo.lock.`);
    }
    return version;
  }
  throw new Error(`Unable to find ${packageName} in src-tauri/Cargo.lock.`);
}

export function collectReleaseVersions(rootDirectory) {
  const root = resolve(rootDirectory);
  const packageJson = readJson(resolve(root, "package.json"));
  const packageLock = readJson(resolve(root, "package-lock.json"));
  const tauriConfig = readJson(resolve(root, "src-tauri", "tauri.conf.json"));
  const cargoToml = readFileSync(resolve(root, "src-tauri", "Cargo.toml"), "utf8");
  const cargoLock = readFileSync(resolve(root, "src-tauri", "Cargo.lock"), "utf8");

  return {
    "package.json": packageJson.version,
    "package-lock.json": packageLock.version,
    "package-lock.json root package": packageLock.packages?.[""]?.version,
    "src-tauri/tauri.conf.json": tauriConfig.version,
    "src-tauri/Cargo.toml": packageVersionFromCargoToml(cargoToml),
    "src-tauri/Cargo.lock": packageVersionFromCargoLock(cargoLock, "prime-orbit"),
  };
}

export function verifyReleaseVersion(tag, versions) {
  const normalizedTag = String(tag ?? "").trim().replace(/^refs\/tags\//, "");
  if (!normalizedTag.startsWith("v")) {
    throw new Error(`Release tag must start with "v"; received "${normalizedTag || "<empty>"}".`);
  }

  const version = normalizedTag.slice(1);
  if (!STABLE_SEMVER.test(version)) {
    throw new Error(
      `Stable releases require a strict vMAJOR.MINOR.PATCH tag; received "${normalizedTag}". ` +
        "Prerelease channels need their own manifest and workflow.",
    );
  }

  const missing = Object.entries(versions).filter(([, value]) => typeof value !== "string" || value.length === 0);
  if (missing.length > 0) {
    throw new Error(`Missing version value in: ${missing.map(([name]) => name).join(", ")}.`);
  }

  const mismatches = Object.entries(versions).filter(([, value]) => value !== version);
  if (mismatches.length > 0) {
    const details = mismatches.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(", ");
    throw new Error(`Release tag ${normalizedTag} does not match every manifest: ${details}.`);
  }

  return { tag: normalizedTag, version };
}

export function verifyRepositoryRelease(tag, rootDirectory = process.cwd()) {
  const versions = collectReleaseVersions(rootDirectory);
  const release = verifyReleaseVersion(tag, versions);
  return { ...release, versions };
}

function main() {
  const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
  const result = verifyRepositoryRelease(tag);
  console.log(`Prime Orbit release version verified: ${result.tag}`);
  for (const [manifest, version] of Object.entries(result.versions)) {
    console.log(`- ${manifest}: ${version}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
