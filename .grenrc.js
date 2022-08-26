module.exports = {
    "dataSource": "commits",
    "tags": "all",
    "prefix": "v",
    "ignoreIssuesWith": [
        "duplicate",
        "wontfix",
        "invalid",
        "help wanted"
    ],
    username: "cjbarth",
    repo: "github-release-notes",
    "template": {
        "issue": "- [{{text}}]({{url}}) {{name}}"
    },
    "groupBy": {
        "Enhancements:": ["enhancement", "internal"],
        "Bug Fixes:": ["bug"]
    }
};
