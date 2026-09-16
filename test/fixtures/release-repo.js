// Builds a throwaway git repository with two release lines, for testing how
// gren assigns commits to releases.
//
//   master  c1 (v1.0.0) - c2 (v1.1.0) - c4 - m1 - c7 - c8a - c8b - c9 - c10 (v2.0.0) - c12
//                           \            \_c5-c6_/                 \
//   1.x                      c3 (v1.1.1) -------------------------- m2 (v1.2.0) - c11 (v1.2.1)
//
// Each commit is dated one day after the one before it, in the order built.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create the repository
 *
 * @return {Object} { dir, sha, remove }, where sha maps each commit's name above to its SHA
 */
export function createReleaseRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gren-release-repo-"));
  // Keep the user's git configuration, such as commit signing, out of the fixture.
  const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const sha = {};
  let day = 0;

  const git = (args, env = {}) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8", env: { ...baseEnv, ...env } }).trim();
  const nextDate = () => {
    day++;
    const date = new Date(Date.UTC(2020, 0, day)).toISOString();

    return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  };
  const commit = (name, message) => {
    fs.writeFileSync(path.join(dir, `${name}.txt`), `${message}\n`);
    git(["add", "-A"]);
    git(["commit", "-m", message], nextDate());
    sha[name] = git(["rev-parse", "HEAD"]);
  };
  const merge = (name, branch, message) => {
    git(["merge", "--no-ff", "-m", message, branch], nextDate());
    sha[name] = git(["rev-parse", "HEAD"]);
  };

  git(["init", "-b", "master"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);

  commit("c1", "Initial commit");
  git(["tag", "-a", "v1.0.0", "-m", "v1.0.0"], nextDate());
  git(["tag", "1.0.0"]);
  git(["tag", "V1"]);
  commit("c2", "Add feature A (#1)");
  git(["tag", "-a", "v1.1.0", "-m", "v1.1.0"], nextDate());

  git(["checkout", "-b", "1.x"]);
  commit("c3", "Fix bug B (#2)");
  git(["tag", "v1.1.1"]);

  git(["checkout", "master"]);
  commit("c4", "Add feature C (#3)");
  git(["checkout", "-b", "feature"]);
  commit("c5", "Start feature D");
  commit("c6", "Finish feature D");
  git(["checkout", "master"]);
  merge("m1", "feature", "Merge pull request #4 from feature");
  commit("c7", "Fix a security issue");
  commit("c8a", "Tidy docs, part 1");
  commit("c8b", "Tidy docs, part 2");
  commit("c9", "Release 1.2.0");
  git(["branch", "before-sync"]);

  git(["checkout", "1.x"]);
  merge("m2", "master", "Merge pull request #6 from master");
  git(["tag", "v1.2.0"]);
  git(["branch", "after-sync"]);

  git(["checkout", "master"]);
  commit("c10", "Drop the old API (#7)");
  git(["tag", "v2.0.0"]);

  git(["checkout", "1.x"]);
  commit("c11", "Backport fix E (#8)");
  git(["tag", "v1.2.1"]);

  git(["checkout", "master"]);
  commit("c12", "Add feature F (#9)");

  return {
    dir,
    sha,
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
