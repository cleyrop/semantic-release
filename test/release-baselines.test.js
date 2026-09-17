import test from "ava";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import getTags from "../lib/branches/get-tags.js";
import getLastRelease from "../lib/get-last-release.js";
import getNextVersion from "../lib/get-next-version.js";
import getCommits from "../lib/get-commits.js";
import getReleaseToAdd from "../lib/get-release-to-add.js";
import { push } from "../lib/git.js";
import { gitAddNote, gitCheckout, gitCommits, gitRepo, gitTagVersion } from "./helpers/git-utils.js";

const tagFormat = "service-v${version}";
const logger = { log() {} };

async function ledger(cwd, releases, extra = {}) {
  await writeFile(join(cwd, "baselines.json"), JSON.stringify({ schemaVersion: 1, tagFormat, releases, ...extra }));
  return { cwd, logger, options: { tagFormat, releaseBaselineFile: "baselines.json" } };
}

function branchContext(context, branch, tags) {
  const pre = branch === "develop" ? "alpha" : branch === "staging" ? "beta" : undefined;
  return {
    ...context,
    branch: {
      name: branch,
      tags,
      type: pre ? "prerelease" : "release",
      prerelease: pre,
      channel: pre ? branch : undefined,
    },
  };
}

test("continue alpha without historical tags and analyze only commits after mapped baseline", async (t) => {
  const { cwd } = await gitRepo(false, "develop");
  const [{ hash }] = await gitCommits(["feat: imported source"], { cwd });
  const context = await ledger(cwd, [{ version: "1.5.0-alpha.7", gitHead: hash, channels: ["develop"] }]);
  await gitCommits(["fix: new work"], { cwd });
  const [branch] = await getTags(context, [{ name: "develop" }]);
  const state = branchContext(context, branch.name, branch.tags);
  state.lastRelease = getLastRelease(state);
  t.is(state.lastRelease.gitHead, hash);
  t.true(state.lastRelease.historical);
  t.deepEqual(
    (await getCommits(state)).map(({ message }) => message),
    ["fix: new work"]
  );
  t.is(getNextVersion({ ...state, nextRelease: { type: "patch", channel: "develop" } }), "1.5.0-alpha.8");
  t.is((await execa("git", ["tag", "--list"], { cwd })).stdout, "");
});

test("channel baselines are limited by mapped ancestry and continue beta and stable", async (t) => {
  const { cwd } = await gitRepo(false, "main");
  const [{ hash: stable }] = await gitCommits(["stable"], { cwd });
  await gitCheckout("staging", true, { cwd });
  const [{ hash: beta }] = await gitCommits(["beta"], { cwd });
  await gitCheckout("develop", true, { cwd });
  const [{ hash: alpha }] = await gitCommits(["alpha"], { cwd });
  const context = await ledger(cwd, [
    { version: "1.4.0", gitHead: stable, channels: [null] },
    { version: "1.5.0-beta.3", gitHead: beta, channels: ["staging"] },
    { version: "1.5.0-alpha.7", gitHead: alpha, channels: ["develop"] },
  ]);
  const branches = await getTags(
    context,
    ["main", "staging", "develop"].map((name) => ({ name }))
  );
  t.deepEqual(
    branches.map(({ tags }) => tags.length),
    [1, 2, 3]
  );
  for (const [index, expected] of [
    [0, "1.4.1"],
    [1, "1.5.0-beta.4"],
    [2, "1.5.0-alpha.8"],
  ]) {
    const state = branchContext(context, branches[index].name, branches[index].tags);
    t.is(
      getNextVersion({
        ...state,
        lastRelease: getLastRelease(state),
        nextRelease: { type: "patch", channel: state.branch.channel },
      }),
      expected
    );
  }
});

test("new real releases supersede historical baselines", async (t) => {
  const { cwd } = await gitRepo(false, "develop");
  const [{ hash }] = await gitCommits(["old"], { cwd });
  const context = await ledger(cwd, [{ version: "1.5.0-alpha.7", gitHead: hash, channels: ["develop"] }]);
  await gitCommits(["new"], { cwd });
  await gitTagVersion("service-v1.5.0-alpha.8", undefined, { cwd });
  await gitAddNote(JSON.stringify({ channels: ["develop"] }), "service-v1.5.0-alpha.8", { cwd });
  const [branch] = await getTags(context, [{ name: "develop" }]);
  const last = getLastRelease(branchContext(context, branch.name, branch.tags));
  t.is(last.version, "1.5.0-alpha.8");
  t.falsy(last.historical);
});

test("existing unreachable tag remains unchanged while its mapped baseline is used", async (t) => {
  const { cwd } = await gitRepo(false, "main");
  await gitCommits(["base"], { cwd });
  await gitCheckout("old", true, { cwd });
  const [{ hash: original }] = await gitCommits(["old release"], { cwd });
  await gitTagVersion("service-v1.5.0-alpha.7", undefined, { cwd });
  await gitCheckout("main", false, { cwd });
  await gitCheckout("develop", true, { cwd });
  const [{ hash }] = await gitCommits(["mapped release"], { cwd });
  const context = await ledger(cwd, [{ version: "1.5.0-alpha.7", gitHead: hash, channels: ["develop"] }]);
  const [branch] = await getTags(context, [{ name: "develop" }]);
  t.is(getLastRelease(branchContext(context, branch.name, branch.tags)).gitHead, hash);
  t.is((await execa("git", ["rev-parse", "service-v1.5.0-alpha.7"], { cwd })).stdout, original);
});

test("do not add channels or republish a historical release", (t) => {
  const tag = {
    version: "1.4.0",
    gitTag: "service-v1.4.0",
    gitHead: "a".repeat(40),
    channels: ["next"],
    historical: true,
  };
  const branch = { name: "main", tags: [tag], type: "release", channel: undefined };
  t.falsy(
    getReleaseToAdd({
      branch,
      branches: [branch, { name: "next", type: "release", channel: "next" }],
      options: { tagFormat },
    })
  );
});

test("reject conflicting reachable tag rather than silently trusting the ledger", async (t) => {
  const { cwd } = await gitRepo();
  await gitCommits(["first"], { cwd });
  await gitTagVersion("service-v1.4.0", undefined, { cwd });
  const [{ hash }] = await gitCommits(["second"], { cwd });
  const context = await ledger(cwd, [{ version: "1.4.0", gitHead: hash, channels: [null] }]);
  await t.throwsAsync(getTags(context, [{ name: "master" }]), { message: /conflicts with reachable tag/ });
});

test("reject invalid schema, missing commits, duplicate versions and missing channels", async (t) => {
  const { cwd } = await gitRepo();
  const [{ hash }] = await gitCommits(["first"], { cwd });
  const valid = { version: "1.4.0", gitHead: hash, channels: [null] };
  for (const [releases, extra] of [
    [[valid], { schemaVersion: 2 }],
    [[valid], { tagFormat: "other-v${version}" }],
    [[valid, valid], {}],
    [[{ ...valid, channels: [] }], {}],
    [[{ ...valid, gitHead: "f".repeat(40) }], {}],
    [[{ ...valid, gitHead: "HEAD" }], {}],
  ]) {
    await t.throwsAsync(getTags(await ledger(cwd, releases, extra), [{ name: "master" }]));
  }
});

test("push only the selected tag without leaking local aliases or advancing the branch", async (t) => {
  const { cwd, repositoryUrl } = await gitRepo(true);
  const before = (await execa("git", ["ls-remote", repositoryUrl, "refs/heads/master"], { cwd })).stdout;
  await gitCommits(["new"], { cwd });
  await gitTagVersion("service-v1.5.0", undefined, { cwd });
  await gitTagVersion("unrelated-local-alias", undefined, { cwd });
  await push(repositoryUrl, "service-v1.5.0", { cwd });
  const refs = (await execa("git", ["ls-remote", repositoryUrl], { cwd })).stdout;
  t.true(refs.includes("refs/tags/service-v1.5.0"));
  t.false(refs.includes("unrelated-local-alias"));
  t.true(refs.includes(before));
  await t.throwsAsync(push(repositoryUrl, undefined, { cwd }), { instanceOf: TypeError });
});
