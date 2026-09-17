import test from "ava";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { WritableStreamBuffer } from "stream-buffers";
import semanticRelease from "../index.js";
import { gitCheckout, gitCommits, gitRepo, gitTagVersion } from "./helpers/git-utils.js";

const tagFormat = "service-v${version}";
const branches = ["main", { name: "staging", prerelease: "beta" }, { name: "develop", prerelease: "alpha" }];

for (const [branch, previous, expected] of [
  ["main", "1.4.0", "1.4.1"],
  ["staging", "1.5.0-beta.3", "1.5.0-beta.4"],
  ["develop", "1.5.0-alpha.7", "1.5.0-alpha.8"],
]) {
  test.serial(`publish next ${branch} release once, preserving remote branches and historical refs`, async (t) => {
    const { cwd, repositoryUrl } = await gitRepo(true, "main");
    const git = async (...args) => (await execa("git", args, { cwd })).stdout;
    await git("--git-dir", fileURLToPath(repositoryUrl), "symbolic-ref", "HEAD", "refs/heads/main");
    await git("fetch", "--unshallow");
    await gitCheckout("original", true, { cwd });
    const [{ hash: original }] = await gitCommits(["original published source"], { cwd });
    const oldTag = `service-v${previous}`;
    await gitTagVersion(oldTag, undefined, { cwd });
    await git("push", repositoryUrl, `refs/tags/${oldTag}`);
    await gitCheckout("main", false, { cwd });
    if (branch !== "main") await gitCheckout(branch, true, { cwd });
    const [{ hash: mapped }] = await gitCommits(["mapped published source"], { cwd });
    await git("push", repositoryUrl, branch);
    await writeFile(
      join(cwd, "baselines.json"),
      JSON.stringify({
        schemaVersion: 1,
        tagFormat,
        releases: [{ version: previous, gitHead: mapped, channels: [branch === "main" ? null : branch] }],
      })
    );
    const analyzed = [];
    const published = [];
    const options = {
      ci: false,
      repositoryUrl,
      branches,
      tagFormat,
      releaseBaselineFile: "baselines.json",
      plugins: false,
      analyzeCommits: (_, { commits }) => {
        analyzed.push(commits.map(({ message }) => message));
        return commits.some(({ message }) => message.startsWith("fix:")) ? "patch" : null;
      },
      generateNotes: () => "Test release",
      publish: (_, { nextRelease }) => {
        published.push(nextRelease.version);
        return { name: "isolated test" };
      },
    };
    const context = { cwd, env: {}, stdout: new WritableStreamBuffer(), stderr: new WritableStreamBuffer() };
    const refsBefore = await git("ls-remote", repositoryUrl);
    t.false(await semanticRelease(options, context));
    t.deepEqual(analyzed, [[]]);
    t.is(await git("ls-remote", repositoryUrl), refsBefore);
    const [{ hash: next }] = await gitCommits(["fix: new feature correction"], { cwd });
    await git("push", repositoryUrl, branch);
    await gitTagVersion("unrelated-local-tag", undefined, { cwd });
    const heads = await git("ls-remote", "--heads", repositoryUrl);
    const result = await semanticRelease(options, context);
    t.is(result.nextRelease.version, expected);
    t.is(result.lastRelease.gitHead, mapped);
    t.deepEqual(analyzed[1], ["fix: new feature correction"]);
    t.deepEqual(published, [expected]);
    t.is(await git("ls-remote", "--heads", repositoryUrl), heads);
    t.is(
      (await git("ls-remote", "--tags", repositoryUrl)).split("\n").sort().join("\n"),
      [`${original}\trefs/tags/${oldTag}`, `${next}\trefs/tags/service-v${expected}`].sort().join("\n")
    );
    t.false(await semanticRelease(options, context));
    t.deepEqual(published, [expected]);
    t.deepEqual(analyzed[2], []);
  });
}
