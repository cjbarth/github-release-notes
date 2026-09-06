import { assert } from "chai";
import GitHubInfo from "../lib/src/GitHubInfo.js";

describe("GitHubInfo", () => {
  let githubInfo;

  beforeEach(() => {
    githubInfo = new GitHubInfo();
  });

  it("Should execute the commands", (done) => {
    githubInfo
      ._executeCommand('echo "gren"', (text) => {
        assert.deepEqual(text, "gren", "Returns the text echoed");
      })
      .then(done);
  });

  it("Should get repo and token informations", async () => {
    const { username, repo } = await githubInfo.repo;

    assert.isOk(username, "Get username from repo's folder");
    assert.deepEqual(repo, "github-release-notes", "Get the repository name from repo's folder");

    if (process.env.GREN_GITHUB_TOKEN) {
      const { token } = await githubInfo.token;

      assert.isOk(token);
    }

    const options = await githubInfo.options;

    assert.isOk(options[0].repo);
    assert.isOk(options[0].username);

    if (process.env.GREN_GITHUB_TOKEN) {
      assert.isOk(options[1].token);
    }
  });
});
