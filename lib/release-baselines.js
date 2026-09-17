import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execa } from "execa";
import semver from "semver";
import { getTagHead } from "./git.js";
import { makeTag } from "./utils.js";

export async function readBaselines({ cwd, env, options: { releaseBaselineFile, tagFormat } }) {
  if (releaseBaselineFile === undefined) return [];
  if (typeof releaseBaselineFile !== "string" || !releaseBaselineFile) {
    throw new TypeError("releaseBaselineFile must name a release-unit ledger");
  }
  const ledger = JSON.parse(await readFile(resolve(cwd, releaseBaselineFile), "utf8"));
  if (ledger.schemaVersion !== 1 || ledger.tagFormat !== tagFormat || !Array.isArray(ledger.releases)) {
    throw new TypeError("Release baseline schema or tagFormat does not match this release unit");
  }
  const versions = new Set();
  const records = ledger.releases.map(({ version, gitHead, channels, source }) => {
    if (
      typeof version !== "string" ||
      semver.valid(version) !== version ||
      versions.has(version) ||
      typeof gitHead !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitHead) ||
      !Array.isArray(channels) ||
      channels.length === 0 ||
      channels.some((channel) => channel !== null && (typeof channel !== "string" || !channel)) ||
      new Set(channels).size !== channels.length
    ) {
      throw new TypeError("Release baseline requires a unique version, full mapped commit and explicit channels");
    }
    versions.add(version);
    return {
      version,
      gitHead,
      channels,
      gitTag: makeTag(tagFormat, version),
      historical: true,
      ...(source === undefined ? {} : { source }),
    };
  });
  if (records.length) {
    const { stdout } = await execa("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      cwd,
      env,
      input: records.map(({ gitHead }) => gitHead).join("\n") + "\n",
    });
    const objects = stdout.split("\n");
    if (
      objects.length !== records.length ||
      objects.some((line, index) => line !== `${records[index]?.gitHead} commit`)
    ) {
      throw new Error("Release baseline refers to a missing or non-commit object; fetch the retained history first");
    }
  }
  return records;
}

export async function mergeBaselines(records, branch, tags, { cwd, env }) {
  if (!records.length) return tags;
  const { stdout } = await execa("git", ["rev-list", branch], { cwd, env });
  const reachable = new Set(stdout.split("\n"));
  const result = [...tags];
  for (const record of records.filter(({ gitHead }) => reachable.has(gitHead))) {
    const existing = result.find(({ version }) => version === record.version);
    if (existing) {
      if (existing.gitTag !== record.gitTag || (await getTagHead(existing.gitTag, { cwd, env })) !== record.gitHead) {
        throw new Error(`Release baseline conflicts with reachable tag ${existing.gitTag}`);
      }
      existing.channels = [...new Set([...existing.channels, ...record.channels])];
    } else {
      result.push(record);
    }
  }
  return result;
}
