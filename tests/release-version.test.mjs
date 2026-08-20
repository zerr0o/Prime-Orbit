import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  collectReleaseVersions,
  verifyReleaseVersion,
  verifyRepositoryRelease,
} from "../scripts/verify-release-version.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("release manifests agree with the current stable tag", () => {
  const versions = collectReleaseVersions(repositoryRoot);
  const [currentVersion] = new Set(Object.values(versions));

  assert.equal(new Set(Object.values(versions)).size, 1);
  assert.deepEqual(verifyRepositoryRelease(`v${currentVersion}`, repositoryRoot).version, currentVersion);
});

test("release validation rejects a tag that differs from any manifest", () => {
  assert.throws(
    () =>
      verifyReleaseVersion("v1.2.3", {
        "package.json": "1.2.3",
        "src-tauri/tauri.conf.json": "1.2.4",
        "src-tauri/Cargo.toml": "1.2.3",
      }),
    /does not match every manifest/,
  );
});

test("stable release validation rejects prerelease tags", () => {
  assert.throws(
    () => verifyReleaseVersion("v1.2.3-beta.1", { "package.json": "1.2.3-beta.1" }),
    /strict vMAJOR\.MINOR\.PATCH/,
  );
});
