import { assert } from "chai";
import Gren from "../lib/src/Gren.js";

describe("Gren pagination", () => {
  /**
   * Create a Gren whose GitHub lists a branch's commits over the given number of pages
   *
   * @param  {number} pages
   *
   * @return {Object} { gren, requested }, where requested collects the pages asked for
   */
  const createGren = (pages) => {
    const gren = new Gren({
      token: "test-token",
      username: "owner",
      repo: "current",
      head: "master",
      version: "1.0.0",
      quiet: true,
    });
    const requested = [];

    gren.octokit = {
      rest: {
        repos: {
          listCommits: async ({ page }) => {
            requested.push(page);

            return {
              headers:
                pages > 1 ? { link: `<https://api.github.com/x?page=${pages}>; rel="last"` } : {},
              data: [{ sha: `commit-on-page-${page}` }],
            };
          },
        },
      },
    };

    return { gren, requested };
  };

  describe("_getAllCommitsForBranch", () => {
    it("Should read every page GitHub reports", async () => {
      const { gren, requested } = createGren(4);
      const commits = await gren._getAllCommitsForBranch("master");

      assert.deepEqual(requested, [1, 2, 3, 4], "Stopping early hides the oldest commits");
      assert.deepEqual(
        commits.map(({ sha }) => sha),
        ["commit-on-page-1", "commit-on-page-2", "commit-on-page-3", "commit-on-page-4"],
      );
    });

    it("Should read one page when that is all there is", async () => {
      const { gren, requested } = createGren(1);

      await gren._getAllCommitsForBranch("master");

      assert.deepEqual(requested, [1]);
    });
  });
});
