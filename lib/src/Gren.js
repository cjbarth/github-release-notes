import chalk from "chalk";
import { Octokit } from "@octokit/rest";
import * as utils from "./_utils.js";
import { generate } from "./_template.js";
import connectivity from "connectivity";
import templateConfig from "./templates.js";
import ObjectAssign from "object-assign-deep";
import semver from "semver";
import fs from "node:fs";
import { execSync } from "node:child_process";
import * as git from "./_git.js";

const defaults = {
  tags: [],
  prefix: "",
  template: templateConfig,
  prerelease: false,
  generate: false,
  quiet: false,
  override: false,
  debug: false,
  ignoreLabels: false,
  ignoreIssuesWith: false,
  ignoreCommitsWith: false,
  groupBy: false,
  milestoneMatch: "Release {{tag_name}}",
  pullRequestRepos: [],
  commitNotes: {},
  frozenBefore: false,
};

const MAX_TAGS_LIMIT = 99;
const TAGS_LIMIT = 30;

// The data sources whose releases are built from the commits each release contains.
const MEMBERSHIP_DATA_SOURCES = ["prs", "prs-with-issues"];

/**
 * Get the semver version a tag or release name stands for
 *
 * @param  {string} name e.g. v1.2.3 or 1.2.3
 *
 * @return {string|null} The version, or null when the name is not semver
 */
function parseVersion(name) {
  return (typeof name === "string" && semver.valid(name.replace(/^v/, ""))) || null;
}

/**
 * Compare two tag or release names by semver. Names that are not semver sort below those that are.
 *
 * @param  {string} a
 * @param  {string} b
 *
 * @return {number}
 */
function compareVersions(a, b) {
  const versionA = parseVersion(a);
  const versionB = parseVersion(b);

  if (versionA && versionB) {
    return semver.compare(versionA, versionB);
  }

  return Boolean(versionA) - Boolean(versionB);
}

/** Class creating release notes and changelog notes */
class Gren {
  constructor(props = {}) {
    this.options = ObjectAssign({}, defaults, props);
    this.tasks = [];

    const {
      username,
      repo,
      token,
      apiUrl,
      tags,
      limit,
      ignoreLabels,
      ignoreIssuesWith,
      ignoreCommitsWith,
      ignoreTagsWith,
    } = this.options;

    // A head passed in is used as given. Otherwise use the current branch, or the remote's
    // default branch when the current one has no upstream.
    if (!this.options.head) {
      this.options.head = execSync("git symbolic-ref --short HEAD", { encoding: "utf-8" });
      try {
        execSync("git rev-parse --abbrev-ref --symbolic-full-name @{u}", { stdio: "ignore" });
      } catch {
        this.options.head = execSync(
          "git remote show origin | grep 'HEAD branch' | cut -d' ' -f5",
          { encoding: "utf-8" },
        );
      }
    }
    this.options.head = this.options.head.trim();
    this.options.tags = utils.convertStringToArray(tags);
    this.options.ignoreLabels = utils.convertStringToArray(ignoreLabels);
    this.options.ignoreIssuesWith = utils.convertStringToArray(ignoreIssuesWith);
    this.options.ignoreCommitsWith = utils.convertStringToArray(ignoreCommitsWith);
    this.options.ignoreTagsWith = utils.convertStringToArray(ignoreTagsWith);
    this.options.pullRequestRepos = this._parseRepos(this.options.pullRequestRepos);
    this.options.commitNotes = this._validateCommitNotes(this.options.commitNotes);
    this.options.version = this.options.version || utils.findRelevantVersion();

    if (limit && limit > 0 && limit <= MAX_TAGS_LIMIT) {
      this.options.limit = limit;
    } else if (this.options.tags.indexOf("all") >= 0) {
      this.options.limit = MAX_TAGS_LIMIT;
    } else {
      this.options.limit = TAGS_LIMIT;
    }

    if (!token) {
      throw chalk.red("You must provide the TOKEN");
    }

    if (this.options.debug) {
      this._outputOptions(this.options);
    }

    this.octokit = new Octokit({
      auth: token,
      // Leaving baseUrl unset keeps Octokit's own default.
      ...(apiUrl ? { baseUrl: apiUrl } : {}),
      // Octokit logs every failed request to the console. Some failures are
      // expected control flow, such as the compare fallback in
      // _getReleaseBlocks, so routing them through --debug keeps them out of
      // the normal output. Failures that actually matter are still thrown, and
      // reported by the commands' own error handling.
      log: {
        debug: () => {},
        info: () => {},
        warn: (message) => this.options.debug && console.warn(message),
        error: (message) => this.options.debug && console.error(message),
      },
    });

    this.repoParams = { owner: username, repo };
    this.commitPullRequests = new Map();
    this.notePullRequests = new Map();
    this.overriddenPullRequests = new Map();
  }

  /**
   * Parse the repos to look for pull requests in, besides the current one
   *
   * @private
   *
   * @param  {Array|string} repos e.g. ["owner/repo"] or "owner/repo,owner/other"
   *
   * @return {Object[]} The repos as { owner, repo }
   */
  _parseRepos(repos) {
    const names = Array.isArray(repos) ? repos : String(repos || "").split(",");

    return names
      .map((name) => String(name).trim())
      .filter(Boolean)
      .map((fullName) => {
        const [owner, repo, ...rest] = fullName.split("/");

        if (!owner || !repo || rest.length) {
          throw chalk.red(`pullRequestRepos entries must look like "owner/repo": ${fullName}`);
        }

        return { owner, repo };
      });
  }

  /**
   * Parse the pull request a commitNotes entry points to
   *
   * @private
   *
   * @param  {number|string} reference e.g. 330, "#330" or "owner/repo#330"
   *
   * @return {Object|undefined} The pull request as { owner, repo, pull_number }, without the
   *                            repo when the reference names none
   */
  _parseNotePullRequest(reference) {
    const parts = /^(?:([^/\s]+)\/([^/#\s]+))?#?([1-9]\d*)$/.exec(String(reference).trim());

    if (!parts) {
      return undefined;
    }

    const [, owner, repo, number] = parts;

    return { ...(owner ? { owner, repo } : {}), pull_number: Number(number) };
  }

  /**
   * Check the commitNotes option maps commit SHAs to entries
   *
   * @private
   *
   * @param  {Object} commitNotes
   *
   * @return {Object}
   */
  _validateCommitNotes(commitNotes) {
    if (!commitNotes) {
      return {};
    }

    if (typeof commitNotes !== "object" || Array.isArray(commitNotes)) {
      throw chalk.red("commitNotes must be an object that maps commit SHAs to entries");
    }

    Object.entries(commitNotes).forEach(([sha, note]) => {
      if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
        throw chalk.red(`commitNotes keys must be commit SHAs of at least 7 characters: ${sha}`);
      }

      if (!note || typeof note !== "object" || Array.isArray(note)) {
        throw chalk.red(`The commitNotes entry for ${sha} must be an object`);
      }

      if (note.pr !== undefined && !this._parseNotePullRequest(note.pr)) {
        throw chalk.red(
          `The commitNotes entry for ${sha} must give pr as a number, "#123" or "owner/repo#123"`,
        );
      }
    });

    return commitNotes;
  }

  /**
   * Generate release notes and draft a new release
   *
   * @since  0.10.0
   * @public
   *
   * @return {Promise}
   */
  async release() {
    utils.printTask(this.options.quiet, "Generate release notes");

    await this._hasNetwork();
    const blocks = await this._getReleaseBlocks();

    return blocks.reduce(
      (carry, block) => carry.then(this._prepareRelease.bind(this, block)),
      Promise.resolve(),
    );
  }

  /**
   * Generate changelog file based on the release notes or generate new one
   *
   * @since  0.10.0
   * @public
   *
   * @return {Promise}
   */
  async changelog() {
    utils.printTask(this.options.quiet, "Generate changelog file");

    await this._hasNetwork();
    this._checkChangelogFile();

    // Read before the file is replaced, so frozen sections can be carried over.
    const existingSections =
      this.options.generate && this.options.frozenBefore
        ? this._readChangelogSections()
        : undefined;
    const releases = this.options.generate
      ? await this._getReleaseBlocks(existingSections)
      : await this._getListReleases();

    if (releases.length === 0) {
      throw chalk.red(
        "There are no releases, use --generate to create release notes, or run the release command.",
      );
    }

    return this._createChangelog(this._templateReleases(releases));
  }

  /**
   * Check if the changelog file exists
   *
   * @since 0.8.0
   * @private
   *
   * @return {string}
   */
  _checkChangelogFile() {
    const filePath = process.cwd() + "/" + this.options.changelogFilename;

    if (fs.existsSync(filePath) && !this.options.override) {
      throw chalk.black(
        chalk.bgYellow("Looks like there is already a changelog, to override it use --override"),
      );
    }

    return filePath;
  }

  /**
   * Create the changelog file
   *
   * @since 0.8.0
   * @private
   *
   * @param  {string} body The body of the file
   */
  _createChangelog(body) {
    const loaded = utils.task(this, `Creating ${this.options.changelogFilename}`);
    const filePath = process.cwd() + "/" + this.options.changelogFilename;
    // Each template decides its own spacing, so a heading whose template opens with a blank
    // line, under a release template that closes with one, leaves two. Markdown reads one and
    // two the same way; markdownlint does not, and a changelog that trips a linter is one
    // somebody ends up editing by hand.
    const content = (this.options.template.changelogTitle + body).replace(/\n{3,}/g, "\n\n");

    fs.writeFileSync(filePath, content);

    loaded(chalk.green(`Changelog created in ${filePath}`));
  }

  /**
   * Split the existing changelog file into its release sections
   *
   * A section is keyed by the version in its first line. A section without a version, such
   * as "## 3.x", stays attached to the section before it.
   *
   * @private
   *
   * @return {Map<string, string>} Version to the section's text, exactly as in the file
   */
  _readChangelogSections() {
    const filePath = process.cwd() + "/" + this.options.changelogFilename;
    const sections = new Map();

    if (!fs.existsSync(filePath)) {
      return sections;
    }

    const { changelogTitle, releaseSeparator } = this.options.template;
    let content = fs.readFileSync(filePath, "utf-8");

    if (content.startsWith(changelogTitle)) {
      content = content.slice(changelogTitle.length);
    }

    let current = null;
    // A changelog written with nothing between its releases can only be split on the headings,
    // at the start of each one so that the release before it keeps its last line.
    const chunks = releaseSeparator
      ? content.split(releaseSeparator)
      : content.split(/(?<=\n)(?=#{1,6} +v?\d+\.\d+\.\d+)/);

    chunks.forEach((chunk) => {
      const heading = chunk.trimStart().split("\n")[0];
      const match = heading.match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      const version = match && parseVersion(match[1]);

      if (version && !sections.has(version)) {
        current = version;
        sections.set(version, chunk);
      } else if (current) {
        sections.set(current, sections.get(current) + releaseSeparator + chunk);
      }
    });

    // Without the existing sections every frozen release would be dropped from the file that is
    // about to be written over it.
    if (!sections.size && content.trim()) {
      throw chalk.red(
        `\nNo releases could be read from ${this.options.changelogFilename}, so the sections ` +
          "frozenBefore keeps cannot be found. Check that the release and releaseSeparator " +
          "templates match the file.",
      );
    }

    return sections;
  }

  /**
   * Edit a release from a given tag (in the options)
   *
   * @since 0.5.0
   * @private
   *
   * @param  {number} releaseId The id of the release to edit
   * @param  {Object} releaseOptions The options to build the release:
   * @example
   * {
   *   "tag_name": "v1.0.0",
   *   "target_commitish": "master",
   *   "name": "v1.0.0",
   *   "body": "Description of the release",
   *   "draft": false,
   *   "prerelease": false
   * }
   *
   * @return {Promise}
   */
  async _editRelease(releaseId, releaseOptions) {
    const loaded = utils.task(this, "Updating latest release");
    const { data: release } = await this.octokit.rest.repos.updateRelease({
      ...this.repoParams,
      release_id: releaseId,
      ...releaseOptions,
    });

    loaded(
      chalk.green(`${release.name} has been successfully updated!`) +
        chalk.blue(`\nSee the results here: ${release.html_url}`),
    );

    return release;
  }

  /**
   * Create a release from a given tag (in the options)
   *
   * @since 0.1.0
   * @private
   *
   * @param  {Object} releaseOptions The options to build the release:
   * @example {
   *   "tag_name": "1.0.0",
   *   "target_commitish": "master",
   *   "name": "v1.0.0",
   *   "body": "Description of the release",
   *   "draft": false,
   *   "prerelease": false
   * }
   *
   * @return {Promise}
   */
  async _createRelease(releaseOptions) {
    const loaded = utils.task(this, "Preparing the release");
    const { data: release } = await this.octokit.rest.repos.createRelease({
      ...this.repoParams,
      ...releaseOptions,
    });

    loaded(
      chalk.green(`${release.name} has been successfully created!`) +
        chalk.blue(`\nSee the results here: ${release.html_url}`),
    );

    return release;
  }

  /**
   * Creates the options to make the release
   *
   * @since 0.2.0
   * @private
   *
   * @param  {Object[]} tags The collection of tags
   *
   * @return {Promise}
   */
  _prepareRelease(block) {
    const releaseOptions = {
      tag_name: block.release,
      name: block.name,
      body: block.body,
      draft: this.options.draft,
      prerelease: this.options.prerelease,
    };

    if (block.id) {
      if (!this.options.override) {
        console.warn(
          chalk.black(chalk.bgYellow(`Skipping ${block.release} (use --override to replace it)`)),
        );

        return Promise.resolve();
      }

      return this._editRelease(block.id, releaseOptions);
    }

    return this._createRelease(releaseOptions);
  }

  /**
   * Get the tags information from the given ones, and adds
   * the next one in case only one is given
   *
   * @since 0.5.0
   * @private
   *
   * @param  {Array|string} allTags
   * @param  {Object[]} tags
   *
   * @return {Boolean|Array}
   */
  _getSelectedTags(allTags) {
    const { tags } = this.options;

    if (tags.indexOf("all") >= 0) {
      return allTags;
    }

    if (!allTags || !allTags.length || !tags.length) {
      return false;
    }

    const selectedTags = [].concat(tags);

    return allTags
      .filter(({ name }, index) => {
        const isSelectedTag = selectedTags.includes(name);

        if (isSelectedTag && selectedTags.length === 1 && allTags[index + 1]) {
          selectedTags.push(allTags[index + 1].name);
        }
        return isSelectedTag;
      })
      .slice(0, 2);
  }

  /**
   * List the repo tags, one page at a time
   *
   * @param  {Object} options Query parameters, e.g. per_page and page
   *
   * @return {Promise}
   */
  _listTags(options) {
    return this.octokit.rest.repos.listTags({ ...this.repoParams, ...options });
  }

  /**
   * Get all the tags of the repo
   *
   * @since 0.1.0
   * @private
   * @deprecated
   *
   * @param {Array} releases
   * @param {number} page
   *
   * @return {Promise}
   */
  async _getLastTags(releases, page = 1, limit = this.options.limit) {
    const {
      headers: { link },
      data: tags,
    } = await this._listTags({
      per_page: limit,
      page,
    });

    if (!tags.length) {
      throw chalk.red("\nLooks like you have no tags! Tag a commit first and then run gren again");
    }

    const filteredTags = (this._getSelectedTags(tags) || [tags[0], tags[1]])
      .filter(Boolean)
      .filter(({ name }) =>
        this.options.ignoreTagsWith.every((ignoreTag) => !name.match(ignoreTag)),
      )
      .map((tag) => {
        const tagRelease = releases
          ? releases.filter((release) => release.tag_name === tag.name)[0]
          : false;
        const releaseId = tagRelease ? tagRelease.id : null;

        return {
          tag,
          releaseId,
        };
      });
    const totalPages = this._getLastPage(link);

    if (
      (this.options.tags.indexOf("all") >= 0 || filteredTags.length < 2) &&
      totalPages &&
      +page < totalPages
    ) {
      return this._getLastTags(releases, page + 1).then((moreTags) =>
        moreTags.concat(filteredTags),
      );
    }

    return filteredTags;
  }

  /**
   * Get all the tags of the repo
   *
   * @since 0.1.0
   * @private
   * @deprecated
   *
   * @param {Array} releases
   * @param {number} page
   *
   * @return {Promise}
   */
  async _getAllTags(releases, page = 1, limit = this.options.limit) {
    const {
      headers: { link },
      data: tags,
    } = await this._listTags({
      per_page: limit,
      page,
    });

    if (!tags.length) {
      throw chalk.red("\nLooks like you have no tags! Tag a commit first and then run gren again");
    }

    const filteredTags = tags
      .filter(
        (tag) =>
          tag && this.options.ignoreTagsWith.every((ignoreTag) => !tag.name.match(ignoreTag)),
      )
      .map((tag) => {
        const tagRelease = releases
          ? releases.filter((release) => release.tag_name === tag.name)[0]
          : false;

        const releaseId = tagRelease ? tagRelease.id : null;
        const releaseDate = tagRelease ? tagRelease.published_at : null;

        return {
          tag,
          releaseId,
          date: releaseDate,
        };
      });

    const totalPages = this._getLastPage(link);

    if (totalPages && page < totalPages) {
      return this._getAllTags(releases, page + 1).then((moreTags) => moreTags.concat(filteredTags));
    }

    for (const tag of filteredTags) {
      const gotCommit = await this.octokit.rest.git.getCommit({
        ...this.repoParams,
        commit_sha: tag.tag.commit.sha,
      });
      tag.commit = gotCommit.data;
    }

    return filteredTags;
  }

  /**
   * List the repo releases, one page at a time
   *
   * @param  {Object} options Query parameters, e.g. per_page and page
   *
   * @return {Promise}
   */
  _listReleases(options) {
    return this.octokit.rest.repos.listReleases({ ...this.repoParams, ...options });
  }

  /**
   * Get the merged pull requests from a repo
   *
   * @private
   *
   * @param {string} since Stop paging once pull requests were last updated before this date
   * @param {Object} repoParams The repo as { owner, repo }
   *
   * @return {Promise<Object[]>} The pull requests
   */
  async _getMergedPullRequests(since, repoParams = this.repoParams) {
    const prs = [];

    for (let page = 1; ; page++) {
      const {
        headers: { link },
        data,
      } = await this.octokit.rest.pulls.list({
        ...repoParams,
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: 100,
        page,
      });
      const totalPages = this._getLastPage(link);

      prs.push(...data);

      if (
        !data.length ||
        !totalPages ||
        page >= totalPages ||
        new Date(since) >= new Date(data[data.length - 1].updated_at)
      ) {
        break;
      }
    }

    if (typeof this.options.overridePrs === "function") {
      const overridden = this.options.overridePrs(prs);
      const byUrl = new Map(overridden.map((pr) => [pr.html_url, pr]));

      // Commit lookups get pull requests as GitHub has them, so keep what overridePrs made of
      // each one, including the ones it left out, to apply it to those as well.
      prs.forEach(({ html_url: url }) => {
        this.overriddenPullRequests.set(url, byUrl.get(url) || null);
      });

      return overridden;
    }

    return prs.filter((pr) => pr.merged_at);
  }

  /**
   * Get the last page from a Hypermedia link
   *
   * @since  0.11.1
   * @private
   *
   * @param  {string} link
   *
   * @return {boolean|number}
   */
  _getLastPage(link) {
    const linkMatch = Boolean(link) && link.match(/page=(\d+)>; rel="last"/);

    return linkMatch && +linkMatch[1];
  }

  /**
   * Get all releases
   *
   * @since 0.5.0
   * @private
   *
   * @return {Promise} The promise which resolves an array of releases
   */
  async _getListReleases(page = 1, limit = this.options.limit) {
    const loaded = utils.task(this, "Getting the list of releases");
    const {
      headers: { link },
      data: releases,
    } = await this._listReleases({
      per_page: limit,
      page,
    });

    const totalPages = this._getLastPage(link);

    if (this.options.tags.indexOf("all") >= 0 && totalPages && +page < totalPages) {
      return this._getListReleases(page + 1).then((moreReleases) => moreReleases.concat(releases));
    }

    loaded(`Releases found: ${releases.length}`);

    return releases;
  }

  /**
   * Generate the releases bodies from a release Objects Array
   *
   * @since 0.8.0
   * @private
   * @ignore
   *
   * @param  {Array} releases The release Objects Array coming from GitHub
   *
   * @return {string}
   */
  _templateReleases(releases) {
    const { template } = this.options;

    return releases
      .map(
        (release) =>
          // Frozen sections are copied from the existing file as they are.
          release.verbatim ??
          generate(
            {
              release: release.name || release.tag_name,
              date: utils.formatDate(new Date(release.published_at)),
              body: release.body,
            },
            template.release,
          ),
      )
      .join(template.releaseSeparator);
  }

  /**
   * Return the templated commit message
   *
   * @since 0.1.0
   * @private
   *
   * @param  {Object} commit
   *
   * @return {string}
   */

  _templateCommits({
    sha,
    html_url,
    author,
    commit: {
      author: { name },
      message,
    },
  }) {
    return generate(
      {
        sha,
        // A stray space at either end would land inside the link text and read as [ text ].
        message: message.split("\n")[0].trim(),

        url: html_url,
        author: author && author.login,
        authorName: name,
      },
      this.options.template.commit,
    );
  }

  /**
   * Generate the MD template from all the labels of a specific issue
   *
   * @since 0.5.0
   * @private
   *
   * @param  {Object} issue
   *
   * @return {string}
   */
  _templateLabels(issue) {
    const labels = Array.from(issue.labels);

    if (!labels.length && this.options.template.noLabel) {
      labels.push({ name: this.options.template.noLabel });
    }

    return labels
      .filter((label) => this.options.ignoreLabels.indexOf(label.name) === -1)
      .map((label) =>
        generate(
          {
            label: label.name,
          },
          this.options.template.label,
        ),
      )
      .join("");
  }

  /**
   * Generate the MD template for each issue
   *
   * @since 0.5.0
   * @private
   *
   * @param  {Object} issue
   *
   * @return {string}
   */
  _templateIssue(issue) {
    return generate(
      {
        labels: this._templateLabels(issue),
        name: issue.title,
        // commitNotes entries can set their own text, e.g. an advisory ID.
        text: issue.text ?? "#" + issue.number,
        url: issue.html_url,
        body: issue.body,
        pr_base: issue.base && issue.base.ref,
        pr_head: issue.head && issue.head.ref,
        user_login: issue.user.login,
        user_url: issue.user.html_url,
      },
      this.options.template.issue,
    );
  }

  /**
   * Generate the Changelog issues body template
   *
   * @since 0.5.0
   * @private
   *
   * @param  {Object[]} blocks
   *
   * @return {string}
   */
  _templateBody(body, rangeBody) {
    if (Array.isArray(body) && body.length) {
      return body.join("\n") + "\n";
    }

    if (rangeBody) {
      return `${rangeBody}\n`;
    }

    return `${this.options.template.noChangelog}\n`;
  }

  /**
   * Generates the template for the groups
   *
   * @since  0.8.0
   * @private
   *
   * @param  {Object} groups The groups to template e.g.
   * {
   *     'bugs': [{...}, {...}, {...}]
   * }
   *
   * @return {string}
   */
  _templateGroups(groups) {
    const { groupPostProcessor } = this.options;

    return Object.entries(groups).map(([key, value]) => {
      const heading = generate(
        {
          heading: key,
        },
        this.options.template.group,
      );
      const body = value.join("\n");
      const content = heading + "\n" + body;

      return groupPostProcessor ? groupPostProcessor(content) : content;
    });
  }

  /**
   * Filter a commit based on the includeMessages option and commit message
   *
   * @since  0.10.0
   * @private
   *
   * @param  {Object} commit
   *
   * @return {Boolean}
   */
  _filterCommit({ commit: { message } }) {
    const messageType = this.options.includeMessages;
    const filterMap = {
      merges: (message) => message.match(/^merge/i),
      commits: (message) => !message.match(/^merge/i),
      all: () => true,
    };
    const shouldIgnoreMessage = this.options.ignoreCommitsWith.every((commitMessage) => {
      const regex = new RegExp(commitMessage, "i");
      return !message.split("\n")[0].match(regex);
    });

    if (filterMap[messageType]) {
      return filterMap[messageType](message) && shouldIgnoreMessage;
    }

    return filterMap.commits(message) && shouldIgnoreMessage;
  }

  /**
   * Return a commit messages generated body
   *
   * @since 0.1.0
   * @private
   *
   * @param  {Array} commits
   *
   * @return {string}
   */
  _generateCommitsBody(commits = []) {
    const bodyMessages = Array.from(commits);

    return bodyMessages
      .filter(this._filterCommit.bind(this))
      .map(this._templateCommits.bind(this))
      .join("\n");
  }

  /**
   * Get the blocks of commits based on release dates
   *
   * @since 0.5.0
   * @private
   *
   * @param  {Array} releaseRanges The array of date ranges
   *
   * @return {Promise[]}
   */
  async _getCommitBlocks(releaseRanges) {
    const taskName = "Creating the body blocks from commits";
    const loaded = utils.task(this, taskName);

    const ranges = releaseRanges.map((range) => ({
      id: range[0].id,
      name: this.options.prefix + range[0].name,
      release: range[0].name,
      published_at: range[0].date,
      body: this._templateBody(this._generateCommitsBody(range[2]).split("\n").filter(Boolean)),
    }));

    loaded(`Commit ranges loaded: ${ranges.length}`);

    return Promise.resolve(ranges);
  }

  /**
   * Compare the ignored labels with the passed ones
   *
   * @since 0.10.0
   * @private
   *
   * @param  {Array} labels   The labels to check
   * @example [{
   *     name: 'bug'
   * }]
   *
   * @return {boolean}    If the labels array contains any of the ignore ones
   */
  _lablesAreIgnored(labels) {
    if (!labels || !Array.isArray(labels)) {
      return false;
    }

    const { ignoreIssuesWith } = this.options;

    return ignoreIssuesWith.some((label) => labels.map(({ name }) => name).includes(label));
  }

  /**
   * Get all the closed issues from the current repo
   *
   * @since 0.5.0
   * @private
   *
   * @param  {Array} releaseRanges The array of date ranges
   *
   * @return {Promise} The promise which resolves the list of the issues
   */
  async _getClosedIssues(releaseRanges) {
    const type = {
      issues: "Issues",
      milestones: "Issues",
    }[this.options.dataSource];
    const loaded = utils.task(this, `Getting all closed ${type}`);
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      ...this.repoParams,
      state: "closed",
      since: releaseRanges[releaseRanges.length - 1][1].date,
      per_page: 100,
    });

    loaded(`${type} found: ${issues.length}`);

    return issues;
  }

  async _getSingleIssue({ user, repo, number }) {
    const loaded = utils.task(this, `Getting single ${number} issue data`);
    const { data: issue } = await this.octokit.rest.issues.get({
      owner: user,
      repo,
      issue_number: number,
    });
    loaded(`Issue details found: ${issue.number} ${issue.title}`);
    return issue;
  }

  /**
   * Group the issues based on their first label
   *
   * @since 0.8.0
   * @private
   *
   * @param  {Array} issues
   *
   * @return {string}
   */
  _groupByLabel(issues) {
    const groups = [];

    Object.values(ObjectAssign({}, issues)).forEach((issue) => {
      if (!issue.labels.length) {
        if (!this.options.template.noLabel) {
          return;
        }

        issue.labels.push({ name: this.options.template.noLabel });
      }

      const labelName = issue.labels[0].name;

      if (!groups[labelName]) {
        groups[labelName] = [];
      }

      groups[labelName].push(this._templateIssue(issue));
    });

    return this._templateGroups(utils.sortObject(groups));
  }

  /**
   * Create groups of issues based on labels
   *
   * @since  0.8.0
   * @private
   *
   * @param  {Array} issues The array of all the issues.
   *
   * @return {Array}
   */
  _groupBy(passedIssues) {
    const { groupBy } = this.options;
    const issues = Object.values(ObjectAssign({}, passedIssues));

    if (!groupBy || groupBy === "false") {
      return issues.map(this._templateIssue.bind(this));
    }

    if (groupBy === "label") {
      return this._groupByLabel(issues);
    }

    if (typeof groupBy !== "object" || Array.isArray(groupBy)) {
      throw chalk.red("The option for groupBy is invalid, please check the documentation");
    }

    const allLabels = Object.values(groupBy).reduce((carry, group) => carry.concat(group), []);
    const groups = Object.keys(groupBy).reduce((carry, group, i, arr) => {
      const groupIssues = issues
        .filter((issue) => {
          if (!issue.labels.length && this.options.template.noLabel) {
            issue.labels.push({ name: this.options.template.noLabel });
          }

          return (
            issue.labels.some((label) => {
              const isOtherLabel =
                groupBy[group].indexOf("...") !== -1 && allLabels.indexOf(label.name) === -1;

              return groupBy[group].indexOf(label.name) !== -1 || isOtherLabel;
            }) &&
            !arr
              .filter((title) => carry[title])
              .some((title) => carry[title].indexOf(this._templateIssue(issue)) !== -1)
          );
        })
        .map(this._templateIssue.bind(this));

      if (groupIssues.length) {
        carry[group] = groupIssues;
      }

      return carry;
    }, {});

    return this._templateGroups(groups);
  }

  /**
   * Filter the issue based on gren options and labels
   *
   * @since 0.9.0
   * @private
   *
   * @param  {Object} issue
   *
   * @return {Boolean}
   */
  _filterIssue(issue) {
    const { dataSource } = this.options;

    return (
      (issue.pull_request
        ? dataSource === "prs"
        : (dataSource === "issues") | (dataSource === "milestones")) &&
      !this._lablesAreIgnored(issue.labels) &&
      !((this.options.onlyMilestones || dataSource === "milestones") && !issue.milestone)
    );
  }

  /**
   * Filter the pull request based on gren options and labels
   * @private
   *
   * @param  {Object} pullRequest
   *
   * @return {Boolean}
   */
  _filterPullRequest(pullRequest) {
    return (
      !this._lablesAreIgnored(pullRequest.labels) &&
      !(this.options.onlyMilestones && !pullRequest.milestone)
    );
  }

  /**
   * Filter the issue based on the date range, or if is in the release
   * milestone.
   *
   * @since 0.9.0
   * @private
   *
   * @param  {Array} range The release ranges
   * @param  {Object} issue GitHub issue
   *
   * @return {Boolean}
   */
  _filterBlockIssue(range, issue) {
    if (this.options.dataSource === "milestones") {
      return (
        this.options.milestoneMatch.replace("{{tag_name}}", range[0].name) === issue.milestone.title
      );
    }

    return utils.isInRange(
      Date.parse(issue.closed_at),
      Date.parse(range[1].date),
      Date.parse(range[0].date),
    );
  }

  /**
   * Find the pull requests and commitNotes entries for the commits of each release
   *
   * A commit matches a pull request whose merge commit it is, in the current repo or one of
   * the pullRequestRepos. Commits a merge-commit pull request brought in are covered by that
   * pull request. Other commits are looked up one at a time, which finds rebase merges.
   *
   * @private
   *
   * @param  {Array} releaseRanges Ranges whose third item is the release's commits
   *
   * @return {Promise<Object>} { lists, unmatched }, where lists holds each release's pull
   * requests, newest first, and unmatched the commits nothing describes
   */
  async _getReleasePullRequests(releaseRanges) {
    const repos = [this.repoParams, ...this.options.pullRequestRepos];
    const commits = releaseRanges.flatMap((range) => range[2]);
    const byMergeCommit = new Map();
    // Branches other pull requests merge into, such as master or 6.x.
    const baseBranches = new Set();

    if (commits.length) {
      // A pull request is last updated no earlier than its merge commit was made.
      const since = new Date(
        commits.reduce((oldest, { date }) => Math.min(oldest, Date.parse(date)), Infinity),
      ).toISOString();

      for (const repoParams of repos) {
        const prs = await this._getMergedPullRequests(since, repoParams);

        prs.forEach((pr) => {
          if (pr.merge_commit_sha && !byMergeCommit.has(pr.merge_commit_sha)) {
            byMergeCommit.set(pr.merge_commit_sha, pr);
          }

          if (pr.base?.repo) {
            baseBranches.add(`${pr.base.repo.full_name}:${pr.base.ref}`);
          }
        });
      }
    }

    // A pull request from a base branch, such as master into 6.x, syncs release lines. The
    // commits it brings in keep their own pull requests, and those without one are reported.
    const isBranchSync = (pr) =>
      Boolean(pr.head?.repo) && baseBranches.has(`${pr.head.repo.full_name}:${pr.head.ref}`);
    const covered = new Set(
      commits
        .filter(({ sha, parents }) => {
          const pr = byMergeCommit.get(sha);

          return parents.length > 1 && pr && !isBranchSync(pr);
        })
        .flatMap(({ sha }) => git.mergeBranchCommits(sha)),
    );
    const unmatched = [];
    const lists = [];

    for (const range of releaseRanges) {
      const found = new Map();
      const noted = new Set();

      for (const commit of range[2]) {
        const note = this._findCommitNote(commit.sha);
        let pr = byMergeCommit.get(commit.sha);

        if (!pr && !note && !covered.has(commit.sha) && !this._isIgnoredCommit(commit)) {
          pr = await this._getCommitPullRequest(commit.sha, repos, isBranchSync);

          if (pr && this.overriddenPullRequests.has(pr.html_url)) {
            pr = this.overriddenPullRequests.get(pr.html_url) || undefined;
          }

          if (!pr) {
            unmatched.push({ release: range[0].name, commit });
          }
        }

        // A commitNotes entry can point at the pull request the commit came from, such as the
        // one a cherry-pick was taken from, so its title and labels stay with the pull request.
        const notePr = note?.pr === undefined ? undefined : await this._getNotePullRequest(note.pr);
        const item = note ? this._applyCommitNote(note, commit, notePr ?? pr) : pr;

        // Every commit of a rebase-merged pull request matches that pull request, so entries are
        // keyed by the pull request rather than by a commitNotes url, which would leave two
        // entries for the one pull request. The newest commit with a note wins, as commits are
        // newest first.
        const key = item && ((notePr ?? pr)?.html_url ?? item.html_url ?? commit.sha);

        if (item && !noted.has(key)) {
          // A pull request a commitNotes entry points to was merged elsewhere, so the commit is
          // when its change reached this release.
          const sortDate = (notePr ? commit.date : item.merged_at) || commit.date;

          found.set(key, { ...item, sortDate });

          if (note) {
            noted.add(key);
          }
        }
      }

      lists.push(
        Array.from(found.values())
          .filter(this._filterPullRequest.bind(this))
          .sort((pr1, pr2) => Date.parse(pr2.sortDate) - Date.parse(pr1.sortDate)),
      );
    }

    return { lists, unmatched };
  }

  /**
   * Look up the merged pull request that introduced a commit, in each repo in turn
   *
   * @private
   *
   * @param  {string} sha
   * @param  {Object[]} repos The repos as { owner, repo }
   * @param  {Function} isBranchSync Whether a pull request only syncs one release line into
   *                                 another, in which case the search carries on
   *
   * @return {Promise<Object|undefined>}
   */
  async _getCommitPullRequest(sha, repos, isBranchSync) {
    if (!this.commitPullRequests.has(sha)) {
      let found;

      for (const repoParams of repos) {
        try {
          const { data } = await this.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
            ...repoParams,
            commit_sha: sha,
          });

          found = data.find((pr) => pr.merged_at && !isBranchSync(pr));
        } catch (error) {
          // A 422 means the commit is not in this repo, which is the usual answer for a repo in
          // pullRequestRepos. Anything else, including a 404 for a repo that is not there at
          // all, would quietly leave pull requests out of the release notes.
          if (error.status !== 422) {
            throw chalk.red(
              `\nCould not look up the pull request for ${sha} in ${repoParams.owner}/${repoParams.repo}: ${error.message}`,
            );
          }
        }

        if (found) {
          break;
        }
      }

      this.commitPullRequests.set(sha, found);
    }

    return this.commitPullRequests.get(sha);
  }

  /**
   * Get the pull request a commitNotes entry points to
   *
   * @private
   *
   * @param  {number|string} reference e.g. 330, "#330" or "owner/repo#330"
   *
   * @return {Promise<Object>}
   */
  async _getNotePullRequest(reference) {
    const key = String(reference).trim();

    if (!this.notePullRequests.has(key)) {
      const { owner, repo, pull_number } = {
        ...this.repoParams,
        ...this._parseNotePullRequest(reference),
      };

      try {
        const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number });

        this.notePullRequests.set(key, data);
      } catch (error) {
        throw chalk.red(
          `\nCould not get ${owner}/${repo}#${pull_number}, which a commitNotes entry points to: ${error.message}`,
        );
      }
    }

    return this.notePullRequests.get(key);
  }

  /**
   * Find the commitNotes entry for a commit
   *
   * @private
   *
   * @param  {string} sha
   *
   * @return {Object|undefined}
   */
  _findCommitNote(sha) {
    const { commitNotes } = this.options;
    const key = Object.keys(commitNotes).find((prefix) => sha.startsWith(prefix.toLowerCase()));

    return key && commitNotes[key];
  }

  /**
   * Check whether a commit matches ignoreCommitsWith
   *
   * @private
   *
   * @param  {Object} commit
   *
   * @return {boolean}
   */
  _isIgnoredCommit({ subject }) {
    return this.options.ignoreCommitsWith.some((pattern) => new RegExp(pattern, "i").test(subject));
  }

  /**
   * Turn a commitNotes entry into a pull request, or apply it to the commit's pull request
   *
   * @private
   *
   * @param  {Object} note { pr, title, labels, url, text, author }
   * @param  {Object} commit
   * @param  {Object} [pr] The pull request the entry points to, or the commit's own
   *
   * @return {Object}
   */
  _applyCommitNote(note, commit, pr) {
    const base = pr || {
      title: commit.subject,
      labels: [],
      html_url: `${this._getHtmlUrl()}/${this.repoParams.owner}/${this.repoParams.repo}/commit/${commit.sha}`,
      text: commit.sha.slice(0, 7),
      user: { login: "", html_url: "" },
      body: "",
      merged_at: commit.date,
    };
    const fields = {};

    if (note.title !== undefined) {
      fields.title = note.title;
    }

    if (note.labels !== undefined) {
      fields.labels = [].concat(note.labels).map((name) => ({ name }));
    }

    if (note.url !== undefined) {
      fields.html_url = note.url;
    }

    if (note.text !== undefined) {
      fields.text = note.text;
    }

    if (note.author !== undefined) {
      fields.user = { login: note.author, html_url: `${this._getHtmlUrl()}/${note.author}` };
    }

    return { ...base, ...fields };
  }

  /**
   * Get the web address of the GitHub instance
   *
   * @private
   *
   * @return {string}
   */
  _getHtmlUrl() {
    const { apiUrl } = this.options;

    return apiUrl ? apiUrl.replace(/\/api\/v3\/?$/, "") : "https://github.com";
  }

  /**
   * Print the commits no pull request or commitNotes entry describes, with entries to add
   *
   * @private
   *
   * @param  {Object[]} unmatched { release, commit }
   */
  _reportUnmatchedCommits(unmatched) {
    if (!unmatched.length) {
      return;
    }

    const rows = unmatched.map(
      ({ release, commit }) => `  ${release}  ${commit.sha.slice(0, 10)}  ${commit.subject}`,
    );
    const entries = Object.fromEntries(
      unmatched.map(({ commit }) => [
        commit.sha.slice(0, 10),
        { title: commit.subject, labels: [] },
      ]),
    );

    console.warn(
      chalk.yellow(
        `\nThese commits have no pull request, so they are not in the release notes:\n\n${rows.join(
          "\n",
        )}\n\nTo include them, add entries like these to commitNotes in your gren config. ` +
          "A cherry-picked commit can take its title and labels from the pull request it came " +
          'from with { "pr": 330 }. To silence them, match them with ignoreCommitsWith.\n\n',
      ) + JSON.stringify(entries, null, 2),
    );
  }

  /**
   * Get the blocks of issues based on release dates
   *
   * @since 0.5.0
   * @private
   *
   * @param  {Array} releaseRanges The array of date ranges
   *
   * @return {Promise[]}
   */
  async _getIssueBlocks(releaseRanges) {
    const issues = await this._getClosedIssues(releaseRanges);
    const release = releaseRanges.map((range) => {
      const filteredIssues = Array.from(issues)
        .filter(this._filterIssue.bind(this))
        .filter(this._filterBlockIssue.bind(this, range));
      const body = (!range[0].body || this.options.override) && this._groupBy(filteredIssues);
      return {
        id: range[0].id,
        release: range[0].name,
        name: this.options.prefix + range[0].name,
        published_at: range[0].date,
        body: this._templateBody(body, range[0].body),
      };
    });

    return release;
  }

  /**
   * Get the blocks of pull requests based on the commits for each release
   *
   * @private
   *
   * @param  {Array} releaseRanges The array of date ranges
   *
   * @return {Promise[]}
   */
  async _getPullRequestsBlocks(releaseRanges) {
    const loaded = utils.task(this, "Getting all merged pull requests");
    const { lists, unmatched } = await this._getReleasePullRequests(releaseRanges);

    let totalPrs = 0;
    const release = releaseRanges.map((range, index) => {
      const filteredPullRequests = lists[index];
      totalPrs += filteredPullRequests.length;
      const body = (!range[0].body || this.options.override) && this._groupBy(filteredPullRequests);
      return {
        id: range[0].id,
        release: range[0].name,
        name: this.options.prefix + range[0].name,
        published_at: range[0].date,
        body: this._templateBody(body, range[0].body),
      };
    });
    loaded(`Pull Requests found: ${totalPrs}`);
    this._reportUnmatchedCommits(unmatched);
    return release;
  }

  async _getPullRequestWithIssueBlocks(releaseRanges) {
    const loaded = utils.task(this, "Getting all merged pull requests");
    let relevantIssues = [];

    const re = new RegExp("([\\w-]+)/([\\w-]+)/issues/([0-9]+)", "gi");
    const { lists, unmatched } = await this._getReleasePullRequests(releaseRanges);

    const release = releaseRanges.map((range, index) => {
      const list = lists[index].map((pr) => {
        const matches = (pr.body || "").match(re);
        const relatedIssues =
          matches &&
          matches.map((issue) => {
            const [user, repo, , number] = issue.split("/");
            return { user, repo, number };
          });
        return Object.assign({}, pr, { relatedIssues });
      });
      list.forEach(({ relatedIssues }) => {
        relevantIssues = relevantIssues.concat(relatedIssues || []);
      });
      loaded(`Pull Requests found: ${list.length}`);
      return Object.assign({}, range, { list });
    });
    this._reportUnmatchedCommits(unmatched);

    const issuesDetails = (
      await Promise.all(relevantIssues.map(this._getSingleIssue.bind(this)))
    ).reduce((acc, el) => {
      acc[el.number] = el;
      return acc;
    }, {});

    return release
      .map((range) => {
        const list = range.list.map((el) =>
          el.relatedIssues && el.relatedIssues.length
            ? el.relatedIssues.map(({ number }) => issuesDetails[number])
            : [el],
        );
        return Object.assign({}, range, { list: [].concat(...list) });
      })
      .map(this._render.bind(this));
  }

  _render(range) {
    const body = (!range[0].body || this.options.override) && this._groupBy(range.list);

    return {
      id: range[0].id,
      release: range[0].name,
      name: this.options.prefix + range[0].name,
      published_at: range[0].date,
      body: this._templateBody(body, range[0].body),
    };
  }

  /**
   * Sort releases by dates
   *
   * @since 0.5.0
   * @private
   *
   * @param {Array} releaseDates
   *
   * @return {Array}
   */
  _sortReleasesByDate(releaseDates) {
    return Array.from(releaseDates).sort((release1, release2) => {
      if (release1.date == null || release2.date == null) {
        return compareVersions(release2.name, release1.name);
      } else {
        return new Date(release2.date) - new Date(release1.date);
      }
    });
  }

  async _getAllCommitsForBranch(branch) {
    let page = 1;
    const allCommits = [];
    let totalPages;

    do {
      const response = await this.octokit.rest.repos.listCommits({
        ...this.repoParams,
        sha: branch,
        per_page: 100,
        page,
      });

      totalPages = this._getLastPage(response.headers.link);
      page++;
      allCommits.push(...response.data);
      // page has already been moved on to the next one to ask for, so the last page GitHub
      // reports is still to come. Stopping short of it drops the oldest commits on the branch,
      // and with them every tag that points at one.
    } while (page <= totalPages);

    return allCommits;
  }

  /**
   * Create the ranges of release dates
   *
   * @since 0.5.0
   * @private
   *
   * @param  {Array} releaseDates The release dates
   *
   * @return {Array}
   */
  async _createReleaseRanges(releaseDates) {
    const ranges = [];
    const sortedReleaseDates = this._sortReleasesByDate(releaseDates);

    if (sortedReleaseDates.length === 1 || this.options.tags.indexOf("all") >= 0) {
      sortedReleaseDates.push({
        id: 0,
        date: new Date(0).toISOString(),
      });
    }

    for (let i = 0; i < sortedReleaseDates.length - 1; i++) {
      const until = sortedReleaseDates[i + 1].date;
      ranges.push([
        sortedReleaseDates[i],
        {
          ...sortedReleaseDates[i + 1],
          date: until,
        },
      ]);
    }

    if (this.options.head != null) {
      const latest = [
        {
          ...sortedReleaseDates[0],
          name: this.options.version,
          date: new Date().toISOString(),
        },
        {
          ...sortedReleaseDates[0],
        },
      ];

      ranges.unshift(latest);
    }

    return ranges;
  }

  /**
   * Generate release blocks based on issues or commit messages
   * depending on the option.
   *
   * @param  {Map<string, string>} [existingSections] The existing changelog's sections by
   * version, to carry over the releases frozenBefore covers
   *
   * @return {Promise} Resolving the release blocks
   */
  async _getReleaseBlocks(existingSections) {
    const dataSource = {
      issues: this._getIssueBlocks.bind(this),
      commits: this._getCommitBlocks.bind(this),
      milestones: this._getIssueBlocks.bind(this),
      prs: this._getPullRequestsBlocks.bind(this),
      "prs-with-issues": this._getPullRequestWithIssueBlocks.bind(this),
    };

    if (MEMBERSHIP_DATA_SOURCES.includes(this.options.dataSource)) {
      return this._getMembershipReleaseBlocks(
        dataSource[this.options.dataSource],
        existingSections,
      );
    }

    const loadedReleases = utils.task(this, "Getting releases");
    const releases = await this._getListReleases();
    this.tasks["Getting releases"].text = "Getting tags";

    const tags = await this._getAllTags(releases.length ? releases : false);
    const branchCommitShas = (await this._getAllCommitsForBranch(this.options.head)).map(
      (commit) => commit.sha,
    );
    const filteredTags = tags.filter((tag) =>
      branchCommitShas.includes(tag.commit?.sha || tag.tag.commit?.sha),
    );

    this._validateRequiredTagsExists(filteredTags, this.options.tags);

    const releaseObjects = this._transformTagsIntoReleaseObjects(filteredTags);
    const releaseDates = this._sortReleasesByDate(releaseObjects);
    const selectedTags =
      this._getSelectedTags(releaseDates) ||
      (releaseDates.length > 1 ? [releaseDates[0], releaseDates[1]] : releaseDates);

    loadedReleases(`Tags found: ${selectedTags.map(({ name }) => name).join(", ")}`);

    const releaseRanges = await this._createReleaseRanges(selectedTags);

    const loadedCommits = utils.task(this, "Getting lists of commits by release");
    for (const releaseRange of releaseRanges) {
      let commits;
      if (releaseRange[1].name != null) {
        let response;
        try {
          response = await this.octokit.rest.repos.compareCommits({
            ...this.repoParams,
            base: releaseRange[1].name,
            head: releaseRange[0].name,
          });
        } catch {
          // If the above failed, it is because we are using a calculated version as the first `name`
          // Use the head of the branch instead
          response = await this.octokit.rest.repos.compareCommits({
            ...this.repoParams,
            base: releaseRange[1].name,
            head: this.options.head,
          });
        }
        ({
          data: { commits },
        } = response);
      } else {
        ({ data: commits } = await this.octokit.rest.repos.listCommits({
          ...this.repoParams,
          since: releaseRange[1].date,
          until: releaseRange[0].date,
        }));
      }

      const filteredCommits = commits.filter((commit) => branchCommitShas.includes(commit.sha));
      const sortedCommits = this._sortCommitsByParent(filteredCommits);
      releaseRange.push(sortedCommits);
    }
    loadedCommits("Commits acquired");

    return dataSource[this.options.dataSource](releaseRanges);
  }

  /**
   * Generate release blocks from the commits each release contains
   *
   * A release contains the commits reachable from its tag but not from any tag with a lower
   * version, so every commit belongs to the lowest release that contains it. That holds
   * whichever branch gren runs on, and follows both sides of merges between release lines.
   *
   * @private
   *
   * @param  {Function} getBlocks The data source that turns release ranges into blocks
   * @param  {Map<string, string>} [existingSections] See _getReleaseBlocks
   *
   * @return {Promise<Object[]>} The release blocks, highest version first
   */
  async _getMembershipReleaseBlocks(getBlocks, existingSections) {
    const releases = await this._getListReleases();
    const loadedReleases = utils.task(this, "Getting releases");
    const tags = await this._getVersionTags(releases);
    const selected = this._selectMembershipReleases(tags);

    loadedReleases(`Releases found: ${selected.map(({ name }) => name).join(", ")}`);

    const cutoff = existingSections && this._getFrozenCutoff();
    const generated = selected.filter((release) => !(cutoff && Date.parse(release.date) < cutoff));

    const unreleased = selected.find(({ ref }) => ref === this.options.head);

    if (unreleased && !(cutoff && Date.parse(unreleased.date) < cutoff)) {
      await this._validateHeadIsPushed(this.options.head);
    }

    // A shallow clone has every tag but not the commits between them, which would leave
    // pull requests out of the release notes without any way to tell.
    if (generated.length && git.isShallow()) {
      throw chalk.red(
        "\nThe local repository has a truncated history, so the commits in a release cannot be " +
          'read. Fetch the rest of it with "git fetch --unshallow", or check out with a full ' +
          'history, e.g. "fetch-depth: 0" for actions/checkout.',
      );
    }

    const entries = selected.map((release) => {
      if (cutoff && Date.parse(release.date) < cutoff) {
        return { release, frozen: true, verbatim: existingSections.get(release.version) };
      }

      const lowerTags =
        release.excludeRefs ||
        tags.filter((tag) => semver.lt(tag.version, release.version)).map(({ ref }) => ref);

      return { release, commits: git.releaseCommits(release.ref, lowerTags) };
    });
    const ranges = entries
      .filter(({ frozen }) => !frozen)
      .map(({ release, commits }) => [
        { id: release.id, name: release.name, date: release.date },
        { date: commits.length ? commits[commits.length - 1].date : release.date },
        commits,
      ]);
    const blocks = ranges.length ? await getBlocks(ranges) : [];
    const missing = entries
      .filter(({ frozen, verbatim }) => frozen && verbatim === undefined)
      .map(({ release }) => release.name);

    if (missing.length) {
      console.warn(
        chalk.yellow(
          `\nThese releases are before frozenBefore but have no section in the changelog, so they are left out: ${missing.join(", ")}`,
        ),
      );
    }

    return entries
      .map(({ release, frozen, verbatim }) => {
        if (frozen) {
          return (
            verbatim !== undefined && {
              id: release.id,
              release: release.name,
              name: this.options.prefix + release.name,
              published_at: release.date,
              verbatim,
            }
          );
        }

        const block = blocks.shift();

        if (release.version) {
          return block;
        }

        // There is no version for the prefix to belong to in an unreleased section, and no
        // reason to write the heading at all when the commits under it have nothing to say:
        // they are in the report either way.
        return block.body !== this._templateBody([]) && { ...block, name: release.name };
      })
      .filter(Boolean);
  }

  /**
   * Get the repo's semver tags, highest version first
   *
   * Tags come from GitHub and are checked against the local repository, where their commits
   * are read. Tags matching ignoreTagsWith, and tags that are not semver, are left out.
   *
   * @private
   *
   * @param  {Object[]} releases The GitHub releases, to find each tag's release
   *
   * @return {Promise<Object[]>} Tags as { id, name, version, ref, date }
   */
  async _getVersionTags(releases) {
    const remoteTags = await this.octokit.paginate(this.octokit.rest.repos.listTags, {
      ...this.repoParams,
      per_page: 100,
    });
    const localTags = git.tagCommits();
    const missing = [];
    const moved = [];
    const byVersion = new Map();

    remoteTags.forEach(({ name, commit }) => {
      const version = parseVersion(name);

      if (!version || this.options.ignoreTagsWith.some((ignoreTag) => name.match(ignoreTag))) {
        return;
      }

      const local = localTags.get(name);

      if (!local) {
        missing.push(name);
        return;
      }

      if (local.sha !== commit.sha) {
        moved.push(name);
        return;
      }

      // When both 1.0.0 and v1.0.0 exist, keep v1.0.0.
      if (!byVersion.get(version)?.name.startsWith("v")) {
        const release = releases.find(({ tag_name: tagName }) => tagName === name);

        byVersion.set(version, {
          id: release ? release.id : null,
          name,
          version,
          ref: `refs/tags/${name}`,
          date: local.date,
        });
      }
    });

    if (missing.length) {
      throw chalk.red(
        `\nThese tags are on GitHub but not in the local repository: ${missing.join(", ")}. ` +
          'Fetch them, e.g. with "git fetch <remote> --tags", and run gren again.',
      );
    }

    if (moved.length) {
      throw chalk.red(
        `\nThese local tags point to different commits than on GitHub: ${moved.join(", ")}.`,
      );
    }

    return Array.from(byVersion.values()).sort((tag1, tag2) =>
      semver.rcompare(tag1.version, tag2.version),
    );
  }

  /**
   * Choose the releases to generate: the unreleased version when it has no tag yet, then every
   * tag with --tags=all, the first tag given with --tags, or otherwise the latest tag
   *
   * @private
   *
   * @param  {Object[]} tags See _getVersionTags
   *
   * @return {Object[]} Releases as { id, name, version, ref, date }, highest version first
   */
  _selectMembershipReleases(tags) {
    const { tags: selectedTags, version, head } = this.options;
    const releases = [];
    const unreleasedVersion = parseVersion(version);

    if (head) {
      if (!git.refExists(head)) {
        throw chalk.red(`\nThe branch "${head}" is not in the local repository.`);
      }

      const merged = git.tagsMergedInto(head);
      const taken = unreleasedVersion && tags.some((tag) => tag.version === unreleasedVersion);
      // A version equal to a tag is the ordinary state between releases. A version behind one
      // is a package.json somebody forgot to bump, which is worth saying out loud.
      const behind =
        unreleasedVersion &&
        !taken &&
        tags.find((tag) => merged.has(tag.name) && semver.gt(tag.version, unreleasedVersion));

      if (behind) {
        console.warn(
          chalk.yellow(
            `\nThe version being prepared, ${version}, is older than ${behind.name}, which ` +
              `${head} already contains. Commits no tag holds are listed as ` +
              `${this.options.template.unreleased}.`,
          ),
        );
      }

      if (unreleasedVersion && !taken && !behind) {
        releases.push({
          id: null,
          name: version,
          version: unreleasedVersion,
          ref: head,
          date: new Date().toISOString(),
        });
      } else {
        // The version being prepared has been released already, so anything the branch has that
        // no tag contains belongs to a release that does not have a name yet.
        const excludeRefs = tags.map(({ ref }) => ref);

        if (git.releaseCommits(head, excludeRefs).length) {
          releases.push({
            id: null,
            name: this.options.template.unreleased,
            version: null,
            ref: head,
            date: new Date().toISOString(),
            excludeRefs,
          });
        }
      }
    }

    if (selectedTags.includes("all")) {
      return releases.concat(tags);
    }

    // Only one of 1.0.0 and v1.0.0 is kept, as they are the same release, so a tag given with
    // --tags is matched by version as well as by name.
    const findTag = (name) =>
      tags.find((tag) => tag.name === name || (name && tag.version === parseVersion(name)));

    this._validateRequiredTagsExists(
      selectedTags.filter((name) => findTag(name)).map((name) => ({ tag: { name } })),
      selectedTags,
    );

    if (selectedTags.length) {
      // --tags=new..old is documented as the notes for the new tag using everything since the
      // old one, which takes in the releases between them rather than only the new tag's own.
      const selected = findTag(selectedTags[0]);
      const lower = findTag(selectedTags[1]);

      if (!selected) {
        return releases;
      }

      return releases.concat(lower ? { ...selected, excludeRefs: [lower.ref] } : selected);
    }

    // The latest release is the latest on the branch being released, e.g. 1.2.1 on a 1.x branch
    // while master is on 2.0.0.
    const merged = head && git.refExists(head) ? git.tagsMergedInto(head) : null;
    const latest = (merged && tags.find(({ name }) => merged.has(name))) || tags[0];

    return releases.concat(latest ? [latest] : []);
  }

  /**
   * Check the branch being released is where GitHub has it
   *
   * Tags are checked against GitHub, and the commits of a release are read from the local
   * repository, so a branch that has not been pushed would put work in the release notes that
   * nobody else can see.
   *
   * @private
   *
   * @param  {string} branch
   */
  async _validateHeadIsPushed(branch) {
    let remote;

    try {
      const { data } = await this.octokit.rest.repos.getBranch({ ...this.repoParams, branch });

      remote = data.commit.sha;
    } catch (error) {
      throw chalk.red(
        `\nCould not read the branch "${branch}" from GitHub: ${error.message}. ` +
          "The release notes are written for the branch as it is there.",
      );
    }

    if (remote !== git.commitSha(branch)) {
      throw chalk.red(
        `\nThe branch "${branch}" is at a different commit here than on GitHub. ` +
          "Push it, or fetch, so that the release notes describe what everyone else sees.",
      );
    }
  }

  /**
   * Get the date before which releases are frozen
   *
   * @private
   *
   * @return {number|null} The time in milliseconds, or null when frozenBefore is not set
   */
  _getFrozenCutoff() {
    const { frozenBefore } = this.options;

    if (!frozenBefore) {
      return null;
    }

    if (frozenBefore instanceof Date) {
      return frozenBefore.getTime();
    }

    const value = String(frozenBefore);

    if (/^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value))) {
      return Date.parse(value);
    }

    if (git.refExists(value)) {
      return Date.parse(git.commitDate(value));
    }

    throw chalk.red(`\nfrozenBefore must be a date, a tag or a commit SHA: ${value}`);
  }

  _sortCommitsByParent(commits, dateOrder = "desc") {
    // 1) Map sha -> commit
    const commitMap = new Map(commits.map((c) => [c.sha, c]));

    // 2) Compute parents for each commit
    const parentMap = new Map();
    for (const c of commits) {
      const parentList = (c.parents || []).map((p) => p.sha).filter((sha) => commitMap.has(sha));
      parentMap.set(c.sha, parentList);
    }

    // 3) Compute which SHAs appear as a parent -> those that have children
    const hasChild = new Set();
    for (const parents of parentMap.values()) {
      for (const p of parents) {
        hasChild.add(p);
      }
    }

    // 4) Heads = commits that never appear as anyone's parent
    const heads = commits.filter((c) => !hasChild.has(c.sha)).map((c) => c.sha);

    // 5) A helper to compare by newest date
    const compareDateDesc = (shaA, shaB) => {
      const da = new Date(
        commitMap.get(shaA).commit.committer.date || commitMap.get(shaA).commit.author.date,
      );
      const db = new Date(
        commitMap.get(shaB).commit.committer.date || commitMap.get(shaB).commit.author.date,
      );
      return db - da;
    };

    // 6) Candidate pool & result
    const result = [];
    const seen = new Set();
    const pool = [...heads];

    while (pool.length) {
      // pick the newest SHA
      pool.sort((a, b) => compareDateDesc(a, b));
      const sha = pool.shift();

      if (seen.has(sha)) continue;
      seen.add(sha);

      // emit that commit
      result.push(commitMap.get(sha));

      // add its parents to the pool
      for (const p of parentMap.get(sha) || []) {
        if (!seen.has(p)) pool.push(p);
      }
    }

    return result;
  }

  _transformTagsIntoReleaseObjects(tags) {
    return tags.map((tag) => ({
      id: tag.releaseId,
      name: tag.tag.name,
      date: tag.commit ? tag.commit.committer.date : tag.date,
    }));
  }

  /**
   * Check that the require tags exist in tags
   *
   * @param {Array} tags
   * @param {Array} requireTags
   *
   * @throws{Exception} Will throw exception in case that
   * @requireTags were set to 2 specific tags and these tags aren't exists in @tags
   */
  _validateRequiredTagsExists(tags, requireTags) {
    if (requireTags.indexOf("all") >= 0 || !(requireTags instanceof Array)) return;

    const tagsNames = tags.map((tagData) => tagData.tag.name);

    const missingTags = requireTags.filter((requireTag) => tagsNames.indexOf(requireTag) < 0);
    if (missingTags.length > 0) {
      const inflection = missingTags.length === 1 ? "tag is" : "tags are";
      throw chalk.red(
        `\nThe following ${inflection} not found in the repository: ${missingTags}. ` +
          "please provide existing tags.",
      );
    }
  }

  /**
   * Check if there is connectivity
   *
   * @since 0.5.0
   * @private
   *
   * @return {Promise}
   */
  _hasNetwork() {
    return new Promise((resolve) => {
      connectivity((isOnline) => {
        if (!isOnline) {
          console.warn(chalk.yellow("WARNING: Looks like you don't have network connectivity!"));
        }

        resolve(isOnline);
      });
    });
  }

  /**
   * Output the options in the terminal in a formatted way
   *
   * @param  {Object} options
   */
  _outputOptions(options) {
    const camelcaseToSpaces = (value) =>
      value
        .replace(/([A-Z])/g, " $1")
        .toLowerCase()
        .replace(/\w/, (a) => a.toUpperCase());
    const outputs = Object.entries(options)
      .filter(([key]) => key !== "debug")
      .map(([key, value]) => {
        // --debug is the first thing anyone turns on in CI, and its output is the whole
        // options object. A build log is not a private place to keep a credential that can
        // write to the repository, so report that the token is set and not what it is.
        const shown = key === "token" ? "<hidden>" : value.toString() || "empty";

        return `${chalk.yellow(camelcaseToSpaces(key))}: ${shown}`;
      });

    process.stdout.write("\n" + chalk.blue("Options: \n") + outputs.join("\n") + "\n");
  }
}

export default Gren;
