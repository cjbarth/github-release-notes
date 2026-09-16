import { assert } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as git from "../lib/src/_git.js";
import { createReleaseRepo } from "./fixtures/release-repo.js";

describe("_git.js", () => {
  let repo;
  let cwd;

  before(() => {
    repo = createReleaseRepo();
    cwd = process.cwd();
    process.chdir(repo.dir);
  });

  after(() => {
    process.chdir(cwd);
    repo.remove();
  });

  describe("tagCommits", () => {
    it("Should peel annotated tags to their commit and its date", () => {
      const tags = git.tagCommits();

      assert.deepEqual(tags.get("v1.0.0"), { sha: repo.sha.c1, date: "2020-01-01T00:00:00+00:00" });
      assert.equal(tags.get("1.0.0").sha, repo.sha.c1, "A lightweight tag");
      assert.equal(tags.get("v1.2.0").sha, repo.sha.m2);
    });
  });

  describe("tagsMergedInto", () => {
    it("Should list the tags reachable from a ref", () => {
      const tags = git.tagsMergedInto("master");

      assert.isTrue(tags.has("v2.0.0"));
      assert.isFalse(tags.has("v1.1.1"), "A tag on the other release line");
    });
  });

  describe("releaseCommits", () => {
    it("Should follow both parents of a merge and leave out excluded refs", () => {
      const commits = git.releaseCommits("v1.2.0", ["v1.1.1", "v1.1.0", "v1.0.0"]);
      const { sha } = repo;

      assert.sameMembers(
        commits.map((commit) => commit.sha),
        [sha.m2, sha.c9, sha.c8b, sha.c8a, sha.c7, sha.m1, sha.c6, sha.c5, sha.c4],
      );
    });

    it("Should describe each commit", () => {
      const [commit] = git.releaseCommits("v1.1.1", ["v1.1.0"]);

      assert.deepEqual(commit, {
        sha: repo.sha.c3,
        parents: [repo.sha.c2],
        date: "2020-01-05T00:00:00+00:00",
        author: "Test",
        subject: "Fix bug B (#2)",
      });
    });
  });

  describe("mergeBranchCommits", () => {
    it("Should list the commits a merge brought in", () => {
      assert.sameMembers(git.mergeBranchCommits(repo.sha.m1), [repo.sha.c5, repo.sha.c6]);
    });

    it("Should return nothing for a commit that is not a merge", () => {
      assert.deepEqual(git.mergeBranchCommits(repo.sha.c4), []);
    });
  });

  describe("commitDate", () => {
    it("Should return the committer date of a tag's commit", () => {
      assert.equal(git.commitDate("v1.0.0"), "2020-01-01T00:00:00+00:00");
    });
  });

  describe("isShallow", () => {
    it("Should tell whether the repository's history is truncated", () => {
      const clone = fs.mkdtempSync(path.join(os.tmpdir(), "gren-shallow-"));

      execFileSync("git", [
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        "v1.2.0",
        `file://${repo.dir}`,
        clone,
      ]);

      assert.isFalse(git.isShallow(), "The fixture repository");

      process.chdir(clone);

      try {
        assert.isTrue(git.isShallow());
        assert.equal(git.releaseCommits("v1.2.0").length, 1, "Its history stops at the clone");
      } finally {
        process.chdir(repo.dir);
        fs.rmSync(clone, { recursive: true, force: true });
      }
    });
  });

  describe("refExists", () => {
    it("Should tell whether a ref resolves to a commit", () => {
      assert.isTrue(git.refExists("1.x"));
      assert.isTrue(git.refExists(repo.sha.c7.slice(0, 10)));
      assert.isFalse(git.refExists("no-such-branch"));
    });
  });
});
