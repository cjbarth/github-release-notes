module.exports = {
  dataSource: "prs",
  tags: "all",
  prefix: "v",
  // 5.0.0 was released on the 7th, and the cutoff is exclusive.
  frozenBefore: "2026-09-08",
  ignoreIssuesWith: ["duplicate", "wontfix", "invalid", "help wanted"],
  ignoreCommitsWith: ["^Release \\d"],
  username: "cjbarth",
  repo: "github-release-notes",
  template: {
    issue: "- [{{text}}]({{url}}) {{name}}",
  },
  groupBy: {
    "Enhancements:": ["enhancement", "internal"],
    "Bug Fixes:": ["bug"],
    // Without a catch-all, a pull request whose labels match no group is dropped in silence.
    "Other:": ["..."],
  },
};
