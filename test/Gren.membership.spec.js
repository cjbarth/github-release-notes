import { assert } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Gren from "../lib/src/Gren.js";
import * as git from "../lib/src/_git.js";
import { createReleaseRepo } from "./fixtures/release-repo.js";

const ALL_TAGS = ["v2.0.0", "v1.2.1", "v1.2.0", "v1.1.1", "v1.1.0", "v1.0.0", "1.0.0", "V1"];
const TAGS_BEFORE_1_2_0 = ["v1.1.1", "v1.1.0", "v1.0.0", "1.0.0", "V1"];

describe("Gren release membership", () => {
  let repo;
  let cwd;
  let pulls;
  let associated;
  let calls;
  let warnings;
  const originalWarn = console.warn;

  const day = (n) => new Date(Date.UTC(2020, 0, n)).toISOString();
  const pullRequest = (number, sha, mergedDay, { repoName = "owner/current", ...refs } = {}) => ({
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/${repoName}/pull/${number}`,
    merge_commit_sha: sha,
    merged_at: day(mergedDay),
    updated_at: day(mergedDay),
    labels: (refs.labels || []).map((name) => ({ name })),
    user: { login: "someone", html_url: "https://github.com/someone" },
    body: "",
    base: { ref: refs.base || "master", repo: { full_name: repoName } },
    head: { ref: refs.head || `branch-${number}`, repo: { full_name: repoName } },
  });

  /**
   * Create a Gren for the fixture repository, with GitHub stubbed
   *
   * @param  {Object} options Gren options, plus remoteTags: the tags GitHub reports
   *
   * @return {Gren}
   */
  const createGren = ({ remoteTags = ALL_TAGS, ...options } = {}) => {
    const gren = new Gren({
      token: "test-token",
      username: "owner",
      repo: "current",
      quiet: true,
      dataSource: "prs",
      tags: "all",
      head: "master",
      version: "2.1.0",
      ignoreCommitsWith: ["^Release ", "^Initial commit"],
      pullRequestRepos: ["owner/old"],
      template: { issue: "{{text}} {{name}} {{url}}" },
      ...options,
    });
    const localTags = git.tagCommits();

    gren.octokit = {
      paginate: async (method, params) => (await method(params)).data,
      rest: {
        repos: {
          listReleases: async () => ({ headers: {}, data: [] }),
          listTags: async () => ({
            data: remoteTags.map((name) => ({
              name,
              commit: { sha: localTags.has(name) ? localTags.get(name).sha : "0".repeat(40) },
            })),
          }),
          listPullRequestsAssociatedWithCommit: async ({ owner, repo: name, commit_sha: sha }) => {
            calls.push(`${owner}/${name}:${sha}`);

            // GitHub answers 422, not 404, for a commit that is not in the repo, which is the
            // usual answer for a repo in pullRequestRepos.
            if (name !== "current" && !associated[`${owner}/${name}`]?.[sha]) {
              const error = new Error(`No commit found for SHA: ${sha}`);

              error.status = 422;
              throw error;
            }

            return { data: associated[`${owner}/${name}`]?.[sha] || [] };
          },
        },
        pulls: {
          list: async ({ owner, repo: name }) => ({
            headers: {},
            data: pulls[`${owner}/${name}`] || [],
          }),
          get: async ({ owner, repo: name, pull_number: number }) => {
            const pr = (pulls[`${owner}/${name}`] || []).find((item) => item.number === number);

            if (!pr) {
              const error = new Error("Not Found");

              error.status = 404;
              throw error;
            }

            return { data: pr };
          },
        },
      },
    };

    return gren;
  };
  const byRelease = (blocks) => Object.fromEntries(blocks.map((block) => [block.release, block]));
  const numbers = (block) => [...block.body.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));

  before(() => {
    repo = createReleaseRepo();
    cwd = process.cwd();
    process.chdir(repo.dir);
  });

  after(() => {
    process.chdir(cwd);
    repo.remove();
  });

  beforeEach(() => {
    const { sha } = repo;
    const pr5 = pullRequest(5, sha.c8b, 12);

    pulls = {
      "owner/current": [
        pullRequest(2, sha.c3, 5, { base: "1.x" }),
        pullRequest(3, sha.c4, 6),
        pullRequest(4, sha.m1, 9, { head: "feature" }),
        pr5,
        pullRequest(6, sha.m2, 14, { base: "1.x", head: "master", labels: ["sync"] }),
        pullRequest(7, sha.c10, 15),
        pullRequest(8, sha.c11, 16, { base: "1.x" }),
        pullRequest(9, sha.c12, 17),
      ],
      "owner/old": [pullRequest(1, sha.c2, 3, { repoName: "owner/old" })],
    };
    // A rebase merge: only the last commit is the pull request's merge commit.
    associated = { "owner/current": { [sha.c8a]: [pr5] } };
    calls = [];
    warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  describe("_getReleaseBlocks", () => {
    it("Should put each commit in the lowest release that contains it", async () => {
      const blocks = await createGren()._getReleaseBlocks();
      const releases = byRelease(blocks);

      assert.deepEqual(
        blocks.map(({ release }) => release),
        ["2.1.0", "v2.0.0", "v1.2.1", "v1.2.0", "v1.1.1", "v1.1.0", "v1.0.0"],
        "Highest version first, with duplicate and non-semver tags left out",
      );
      assert.deepEqual(numbers(releases["2.1.0"]), [9]);
      assert.deepEqual(numbers(releases["v2.0.0"]), [7]);
      assert.deepEqual(numbers(releases["v1.2.1"]), [8], "Released after 2.0.0");
      assert.deepEqual(numbers(releases["v1.2.0"]), [6, 5, 4, 3], "Newest first, no duplicates");
      assert.deepEqual(numbers(releases["v1.1.1"]), [2]);
      assert.deepEqual(numbers(releases["v1.1.0"]), [1]);
      assert.include(releases["v1.0.0"].body, "No changelog for this release");
    });

    it("Should give the same tagged sections on every branch", async () => {
      const tagged = (blocks) => blocks.filter(({ release }) => release.startsWith("v"));
      const fromMaster = await createGren()._getReleaseBlocks();
      const fromReleaseLine = await createGren({
        head: "1.x",
        version: "1.2.1",
      })._getReleaseBlocks();

      assert.deepEqual(tagged(fromReleaseLine), tagged(fromMaster));
      assert.notInclude(
        fromReleaseLine.map(({ release }) => release),
        "1.2.1",
        "No unreleased section for a tagged version",
      );
    });

    it("Should build a release cut from master", async () => {
      const blocks = await createGren({
        remoteTags: TAGS_BEFORE_1_2_0,
        head: "before-sync",
        version: "1.2.0",
      })._getReleaseBlocks();

      assert.deepEqual(numbers(byRelease(blocks)["1.2.0"]), [5, 4, 3]);
    });

    it("Should include master's pull requests in a release made after syncing master", async () => {
      const blocks = await createGren({
        remoteTags: TAGS_BEFORE_1_2_0,
        head: "after-sync",
        version: "1.2.0",
      })._getReleaseBlocks();

      assert.deepEqual(numbers(byRelease(blocks)["1.2.0"]), [6, 5, 4, 3]);
    });

    it("Should leave out of the next major what a sync already released", async () => {
      const blocks = await createGren({
        remoteTags: ["v1.2.0", ...TAGS_BEFORE_1_2_0],
        head: repo.sha.c10,
        version: "2.0.0",
      })._getReleaseBlocks();

      assert.deepEqual(numbers(byRelease(blocks)["2.0.0"]), [7]);
    });

    it("Should find pull requests in pullRequestRepos", async () => {
      const withRepos = byRelease(await createGren()._getReleaseBlocks());
      const withoutRepos = byRelease(
        await createGren({ pullRequestRepos: [] })._getReleaseBlocks(),
      );

      assert.include(withRepos["v1.1.0"].body, "https://github.com/owner/old/pull/1");
      assert.deepEqual(numbers(withoutRepos["v1.1.0"]), []);
      assert.match(warnings.join("\n"), /v1\.1\.0 {2}\w{10} {2}Add feature A \(#1\)/);
    });

    it("Should report commits without a pull request, but not merge-commit branches or syncs", async () => {
      const { sha } = repo;

      await createGren()._getReleaseBlocks();

      const report = warnings.join("\n");

      assert.include(report, `v1.2.0  ${sha.c7.slice(0, 10)}  Fix a security issue`);
      assert.include(report, `"${sha.c7.slice(0, 10)}": {\n    "title": "Fix a security issue"`);
      assert.notInclude(report, "Start feature D", "Covered by its merge-commit pull request");
      assert.notInclude(report, "Release 1.2.0", "Matched by ignoreCommitsWith");
      assert.sameMembers(
        calls,
        [`owner/current:${sha.c8a}`, `owner/current:${sha.c7}`, `owner/old:${sha.c7}`],
        "The next repo is only searched when a commit is not found",
      );
    });

    it("Should add commitNotes entries and apply them to pull requests", async () => {
      const { sha } = repo;
      const blocks = await createGren({
        commitNotes: {
          [sha.c7.slice(0, 8)]: {
            title: "Fix CVE-2020-0001",
            labels: ["security"],
            url: "https://example.com/advisory",
            text: "GHSA-1234",
          },
          [sha.c4.slice(0, 7)]: { title: "Feature C, renamed" },
        },
      })._getReleaseBlocks();

      assert.deepEqual(byRelease(blocks)["v1.2.0"].body.split("\n").filter(Boolean), [
        "#6 PR 6 https://github.com/owner/current/pull/6",
        "#5 PR 5 https://github.com/owner/current/pull/5",
        "GHSA-1234 Fix CVE-2020-0001 https://example.com/advisory",
        "#4 PR 4 https://github.com/owner/current/pull/4",
        "#3 Feature C, renamed https://github.com/owner/current/pull/3",
      ]);
      assert.notInclude(warnings.join("\n"), "Fix a security issue");
    });

    it("Should keep a commitNotes entry when other commits match the same pull request", async () => {
      const { sha } = repo;
      // c8b is pull request 5's merge commit, c8a another of its commits, found by lookup.
      const notes = { [sha.c8b.slice(0, 8)]: { title: "PR 5, corrected", labels: ["security"] } };
      const blocks = await createGren({ commitNotes: notes })._getReleaseBlocks();

      assert.deepEqual(byRelease(blocks)["v1.2.0"].body.split("\n").filter(Boolean), [
        "#6 PR 6 https://github.com/owner/current/pull/6",
        "#5 PR 5, corrected https://github.com/owner/current/pull/5",
        "#4 PR 4 https://github.com/owner/current/pull/4",
        "#3 PR 3 https://github.com/owner/current/pull/3",
      ]);
    });

    it("Should list a pull request once when a commitNotes entry gives it another url", async () => {
      const { sha } = repo;
      const notes = {
        [sha.c8b.slice(0, 8)]: { title: "PR 5, corrected", url: "https://example.com/x" },
      };
      const blocks = await createGren({ commitNotes: notes })._getReleaseBlocks();

      assert.deepEqual(numbers(byRelease(blocks)["v1.2.0"]), [6, 5, 4, 3]);
      assert.include(byRelease(blocks)["v1.2.0"].body, "PR 5, corrected https://example.com/x");
    });

    it("Should take a commitNotes entry from the pull request it points to", async () => {
      const { sha } = repo;
      // c7 stands in for a commit cherry-picked from another release line.
      const notes = { [sha.c7.slice(0, 8)]: { pr: "owner/old#1" } };
      const blocks = await createGren({ commitNotes: notes })._getReleaseBlocks();
      const block = byRelease(blocks)["v1.2.0"];

      assert.include(block.body, "#1 PR 1 https://github.com/owner/old/pull/1");
      assert.notInclude(warnings.join("\n"), "Fix a security issue");
    });

    it("Should let a commitNotes entry override the pull request it points to", async () => {
      const { sha } = repo;
      const notes = {
        [sha.c7.slice(0, 8)]: { pr: 8, title: "Fix E, cherry-picked", labels: ["security"] },
      };
      const blocks = await createGren({ commitNotes: notes })._getReleaseBlocks();
      const block = byRelease(blocks)["v1.2.0"];

      assert.include(block.body, "#8 Fix E, cherry-picked https://github.com/owner/current/pull/8");
    });

    it("Should list a pull request once when a commitNotes entry points to it", async () => {
      const { sha } = repo;
      // Pull request 3 is already in v1.2.0, as the pull request commit c4 was merged in. The
      // one entry sits where c7 is, as that is when the change reached this release.
      const notes = { [sha.c7.slice(0, 8)]: { pr: "#3" } };
      const blocks = await createGren({ commitNotes: notes })._getReleaseBlocks();
      const block = byRelease(blocks)["v1.2.0"];

      assert.deepEqual(numbers(block), [6, 5, 3, 4]);
    });

    it("Should stop when a commitNotes entry points to a pull request that is not there", async () => {
      const { sha } = repo;
      const notes = { [sha.c7.slice(0, 8)]: { pr: 404 } };

      try {
        await createGren({ commitNotes: notes })._getReleaseBlocks();
        assert.fail("A missing pull request should stop the changelog");
      } catch (error) {
        assert.include(String(error), "Could not get owner/current#404");
      }
    });

    it("Should stop when a pull request lookup fails for a reason other than a missing commit", async () => {
      const gren = createGren();
      const error = new Error("API rate limit exceeded");

      error.status = 403;
      gren.octokit.rest.repos.listPullRequestsAssociatedWithCommit = async () => {
        throw error;
      };

      try {
        await gren._getReleaseBlocks();
        assert.fail("A failed lookup should stop the changelog");
      } catch (error) {
        assert.include(String(error), "Could not look up the pull request");
        assert.include(String(error), "API rate limit exceeded");
      }
    });

    it("Should keep looking in other repos when a lookup only finds a branch sync", async () => {
      const { sha } = repo;
      const sync = pulls["owner/current"].find(({ number }) => number === 6);
      const upstream = pullRequest(1, sha.c2, 3, { repoName: "owner/old" });

      // c7 arrived in this repo through the sync, but it belongs to a pull request upstream.
      associated["owner/current"][sha.c7] = [sync];
      associated["owner/old"] = { [sha.c7]: [upstream] };

      const blocks = await createGren()._getReleaseBlocks();

      assert.include(
        byRelease(blocks)["v1.2.0"].body,
        "#1 PR 1 https://github.com/owner/old/pull/1",
      );
      assert.notInclude(warnings.join("\n"), sha.c7.slice(0, 10));
    });

    it("Should stop when a repo in pullRequestRepos is not there", async () => {
      const gren = createGren();
      const lookUp = gren.octokit.rest.repos.listPullRequestsAssociatedWithCommit;

      gren.octokit.rest.repos.listPullRequestsAssociatedWithCommit = async (params) => {
        if (params.repo === "old") {
          const error = new Error("Not Found");

          error.status = 404;
          throw error;
        }

        return lookUp(params);
      };

      try {
        await gren._getReleaseBlocks();
        assert.fail("A missing repo should stop the changelog");
      } catch (error) {
        assert.include(String(error), "Could not look up the pull request");
        assert.include(String(error), "owner/old");
      }
    });

    it("Should leave out pull requests with an ignored label", async () => {
      const blocks = await createGren({ ignoreIssuesWith: ["sync"] })._getReleaseBlocks();

      assert.deepEqual(numbers(byRelease(blocks)["v1.2.0"]), [5, 4, 3]);
    });

    it("Should work for the prs-with-issues data source", async () => {
      const blocks = await createGren({ dataSource: "prs-with-issues" })._getReleaseBlocks();

      assert.deepEqual(numbers(byRelease(blocks)["v1.2.0"]), [6, 5, 4, 3]);
    });

    it("Should skip an unreleased version the branch has already passed", async () => {
      const blocks = await createGren({ version: "1.1.5" })._getReleaseBlocks();

      assert.notInclude(
        blocks.map(({ release }) => release),
        "1.1.5",
      );
      assert.include(warnings.join("\n"), "Skipping the unreleased 1.1.5 section");
    });

    it("Should generate only the tag given with --tags, or the latest tag", async () => {
      const selected = await createGren({ tags: "v1.1.1", version: "2.0.0" })._getReleaseBlocks();
      const latest = await createGren({ tags: [] })._getReleaseBlocks();

      assert.deepEqual(
        selected.map(({ release }) => release),
        ["v1.1.1"],
      );
      assert.deepEqual(
        latest.map(({ release }) => release),
        ["2.1.0", "v2.0.0"],
      );
    });

    it("Should take a tag given by either of its names", async () => {
      // The fixture has both 1.0.0 and v1.0.0 on the same commit, and only v1.0.0 is kept.
      const one = await createGren({ tags: "1.0.0" })._getReleaseBlocks();
      const range = await createGren({ tags: ["v1.2.0", "1.0.0"] })._getReleaseBlocks();

      assert.deepEqual(
        one.map(({ release }) => release),
        ["2.1.0", "v1.0.0"],
      );
      assert.deepEqual(
        numbers(byRelease(range)["v1.2.0"]),
        [6, 5, 4, 3, 2, 1],
        "Everything since the tag given, by its other name",
      );
    });

    it("Should take the latest tag from the branch being released", async () => {
      const blocks = await createGren({
        tags: [],
        head: "1.x",
        version: "1.2.1",
      })._getReleaseBlocks();

      assert.deepEqual(
        blocks.map(({ release }) => release),
        ["v1.2.1"],
        "The latest release of a maintenance line, not the highest version anywhere",
      );
    });

    it("Should generate a tag back to the second tag given with --tags", async () => {
      const blocks = await createGren({ tags: ["v1.2.0", "v1.0.0"] })._getReleaseBlocks();
      const v120 = byRelease(blocks)["v1.2.0"];

      assert.deepEqual(numbers(v120), [6, 5, 4, 3, 2, 1], "Everything since the tag given");
    });

    it("Should apply overridePrs to the pull requests commit lookups find", async () => {
      const { sha } = repo;
      // c8a is found by lookup, and is a commit of pull request 5, whose merge commit is c8b.
      const renamed = await createGren({
        overridePrs: (prs) =>
          prs.map((pr) => (pr.number === 5 ? { ...pr, title: "PR 5, overridden" } : pr)),
      })._getReleaseBlocks();
      const dropped = await createGren({
        overridePrs: (prs) => prs.filter((pr) => pr.number !== 5),
      })._getReleaseBlocks();

      assert.include(byRelease(renamed)["v1.2.0"].body, "PR 5, overridden");
      assert.deepEqual(numbers(byRelease(dropped)["v1.2.0"]), [6, 4, 3]);
      assert.include(warnings.join("\n"), sha.c8a.slice(0, 10), "The commit is reported instead");
    });

    it("Should fail when tags are missing locally or point elsewhere", async () => {
      const missing = createGren({ remoteTags: ["v9.9.9", ...ALL_TAGS] });
      const moved = createGren();

      moved.octokit.rest.repos.listTags = async () => ({
        data: [{ name: "v1.1.1", commit: { sha: repo.sha.c4 } }],
      });

      try {
        await missing._getReleaseBlocks();
        assert.fail("Missing tags should fail");
      } catch (error) {
        assert.include(String(error), "not in the local repository: v9.9.9");
      }

      try {
        await moved._getReleaseBlocks();
        assert.fail("Moved tags should fail");
      } catch (error) {
        assert.include(String(error), "point to different commits than on GitHub: v1.1.1");
      }
    });

    it("Should stop when the local repository has a truncated history", async () => {
      const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "gren-shallow-"));

      execFileSync("git", [
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        "v1.2.0",
        `file://${repo.dir}`,
        shallow,
      ]);
      execFileSync("git", [
        "-C",
        shallow,
        "fetch",
        "--quiet",
        "--depth",
        "1",
        "origin",
        "+refs/tags/*:refs/tags/*",
      ]);
      process.chdir(shallow);

      try {
        // Every tag is here and points where GitHub says, but the commits between them are not.
        await createGren({ tags: "v1.2.0", version: "1.2.0" })._getReleaseBlocks();
        assert.fail("A shallow clone should stop the changelog");
      } catch (error) {
        assert.include(String(error), "truncated history");
      } finally {
        process.chdir(repo.dir);
        fs.rmSync(shallow, { recursive: true, force: true });
      }
    });
  });

  describe("frozenBefore", () => {
    const separator = "\n---\n\n";
    const sections = {
      "2.0.0": "## v2.0.0 (2020-01-15)\n\nOld notes for 2.0.0\n",
      "1.2.0": "## v1.2.0 (2020-01-14)\n\nHand-written 1.2.0 notes\n",
      "1.1.1": "## v1.1.1 (2020-01-05)\n\n#2 Fix bug B\n",
      unversioned: "## 1.x maintenance (2020-01-05)\n\nNotes without a version\n",
      "1.1.0": "## v1.1.0 (2020-01-04)\n\n#1 Add feature A\n",
    };

    beforeEach(() => {
      fs.writeFileSync(
        path.join(repo.dir, "CHANGELOG.md"),
        "# Changelog\n\n" + Object.values(sections).join(separator),
      );
    });

    afterEach(() => {
      fs.rmSync(path.join(repo.dir, "CHANGELOG.md"), { force: true });
    });

    [
      ["a commit", () => repo.sha.c10],
      ["a date", () => "2020-01-15"],
    ].forEach(([kind, cutoff]) => {
      it(`Should copy releases before ${kind} from the existing changelog`, async () => {
        const gren = createGren({ frozenBefore: cutoff(), changelogFilename: "CHANGELOG.md" });
        const blocks = await gren._getReleaseBlocks(gren._readChangelogSections());
        const releases = byRelease(blocks);

        assert.deepEqual(
          blocks.map(({ release }) => release),
          ["2.1.0", "v2.0.0", "v1.2.1", "v1.2.0", "v1.1.1", "v1.1.0"],
        );
        assert.deepEqual(numbers(releases["v2.0.0"]), [7], "Not before the cutoff, so rebuilt");
        assert.equal(releases["v1.2.0"].verbatim, sections["1.2.0"]);
        assert.equal(
          releases["v1.1.1"].verbatim,
          sections["1.1.1"] + separator + sections.unversioned,
          "A section without a version stays with the one before it",
        );
        assert.equal(releases["v1.1.0"].verbatim, sections["1.1.0"]);
        assert.include(
          warnings.join("\n"),
          "no section in the changelog, so they are left out: v1.0.0",
        );
        assert.deepEqual(calls, [], "Commits in frozen releases are not looked up");
        assert.include(
          gren._templateReleases(blocks),
          [sections["1.2.0"], sections["1.1.1"], sections.unversioned, sections["1.1.0"]].join(
            separator,
          ),
        );
      });
    });

    it("Should read a changelog with nothing between its releases", async () => {
      const plain = { "2.0.0": sections["2.0.0"], "1.2.0": sections["1.2.0"] };

      fs.writeFileSync(
        path.join(repo.dir, "CHANGELOG.md"),
        "# Changelog\n\n" + Object.values(plain).join(""),
      );

      const gren = createGren({
        frozenBefore: "2020-01-16",
        changelogFilename: "CHANGELOG.md",
        template: { issue: "{{text}} {{name}} {{url}}", releaseSeparator: "" },
      });
      const blocks = await gren._getReleaseBlocks(gren._readChangelogSections());

      assert.equal(byRelease(blocks)["v2.0.0"].verbatim, plain["2.0.0"]);
      assert.equal(byRelease(blocks)["v1.2.0"].verbatim, plain["1.2.0"]);
    });

    it("Should stop when no releases can be read from the changelog", () => {
      fs.writeFileSync(path.join(repo.dir, "CHANGELOG.md"), "# Changelog\n\nNothing to go on.\n");

      const gren = createGren({ frozenBefore: "2020-01-16", changelogFilename: "CHANGELOG.md" });

      // Generating would otherwise write the file with every frozen release missing from it.
      assert.throws(() => gren._readChangelogSections(), /No releases could be read/);
    });

    it("Should write a changelog without a run of blank lines", () => {
      // The default templates leave two blank lines under a release heading: the release
      // template ends with one and the group template opens with another.
      const gren = createGren({ changelogFilename: "CHANGELOG.md", template: {} });

      gren._createChangelog("## v1.0.0 (2020-01-01)\n\n\n### Bug Fixes\n\n- Fix it\n");

      const written = fs.readFileSync(path.join(repo.dir, "CHANGELOG.md"), "utf-8");

      assert.notMatch(written, /\n{3}/);
      assert.include(written, "## v1.0.0 (2020-01-01)\n\n### Bug Fixes\n\n- Fix it\n");
    });

    it("Should reject a value that is not a date, tag or commit", async () => {
      const gren = createGren({ frozenBefore: "not-a-ref" });

      try {
        await gren._getReleaseBlocks(gren._readChangelogSections());
        assert.fail("An invalid frozenBefore should fail");
      } catch (error) {
        assert.include(String(error), "frozenBefore must be a date, a tag or a commit SHA");
      }
    });
  });

  describe("Options", () => {
    it("Should reject pullRequestRepos entries that are not owner/repo", () => {
      assert.throws(() => createGren({ pullRequestRepos: ["just-a-name"] }), /owner\/repo/);
    });

    it("Should reject commitNotes keys that are not commit SHAs", () => {
      assert.throws(() => createGren({ commitNotes: { abc: {} } }), /at least 7 characters/);
    });

    it("Should reject a commitNotes pr that is not a pull request reference", () => {
      const notes = (pr) => ({ commitNotes: { abcdef1: { pr } } });

      assert.throws(() => createGren(notes("owner/repo/330")), /owner\/repo#123/);
      assert.throws(() => createGren(notes("#0")), /owner\/repo#123/);
      assert.throws(() => createGren(notes("")), /owner\/repo#123/);
      assert.doesNotThrow(() => createGren(notes("owner/repo#330")));
      assert.doesNotThrow(() => createGren(notes(330)));
    });
  });

  describe("_sortReleasesByDate", () => {
    it("Should compare names by semver when dates are missing", () => {
      const releases = ["v1.9.0", "V1", "v2.0.0", "v1.10.0"].map((name) => ({ name }));

      assert.deepEqual(
        createGren()
          ._sortReleasesByDate(releases)
          .map(({ name }) => name),
        ["v2.0.0", "v1.10.0", "v1.9.0", "V1"],
      );
    });
  });
});
