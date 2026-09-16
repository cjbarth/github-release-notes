import { execFileSync } from "node:child_process";

// Commit ranges can list every commit in a repository.
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Run a git command in the current working directory
 *
 * @param  {string[]} args
 *
 * @return {string} The trimmed output
 */
function git(args) {
  return execFileSync("git", args, { encoding: "utf-8", maxBuffer: MAX_BUFFER }).trim();
}

/**
 * Split command output into its non-empty lines
 *
 * @param  {string} output
 *
 * @return {string[]}
 */
function lines(output) {
  return output ? output.split("\n") : [];
}

/**
 * Normalise a date git wrote, which renders UTC as either Z or +00:00 depending on its version
 *
 * @param  {string} date
 *
 * @return {string} The date in UTC
 */
function isoDate(date) {
  return new Date(date).toISOString();
}

/**
 * Get the commit each local tag points to. Annotated tags are peeled to their commit.
 *
 * @return {Map<string, Object>} Tag name to { sha, date }, where date is the commit's
 * committer date
 */
function tagCommits() {
  const output = git([
    "for-each-ref",
    "refs/tags",
    "--format=%(refname:strip=2)%00%(objectname)%00%(*objectname)%00%(committerdate:iso-strict)%00%(*committerdate:iso-strict)",
  ]);

  return new Map(
    lines(output).map((line) => {
      const [name, object, peeled, date, peeledDate] = line.split("\0");

      return [name, { sha: peeled || object, date: isoDate(peeledDate || date) }];
    }),
  );
}

/**
 * Get the names of the tags reachable from a ref
 *
 * @param  {string} ref
 *
 * @return {Set<string>}
 */
function tagsMergedInto(ref) {
  return new Set(lines(git(["tag", "--merged", ref])));
}

/**
 * Get the commits reachable from a ref but not from any of the excluded refs, newest first.
 *
 * @param  {string} ref
 * @param  {string[]} excludeRefs
 *
 * @return {Object[]} Commits as { sha, parents, date, author, subject }
 */
function releaseCommits(ref, excludeRefs = []) {
  const output = git([
    "log",
    "--format=%H%x00%P%x00%cI%x00%an%x00%s",
    ref,
    "--not",
    ...excludeRefs,
    "--",
  ]);

  return lines(output).map((line) => {
    const [sha, parents, date, author, subject] = line.split("\0");

    return {
      sha,
      parents: parents ? parents.split(" ") : [],
      date: isoDate(date),
      author,
      subject,
    };
  });
}

/**
 * Get the commits a merge commit brought in from its second parent
 *
 * @param  {string} sha
 *
 * @return {string[]} The commit SHAs, or an empty Array when the commit is not a merge
 */
function mergeBranchCommits(sha) {
  const [, , secondParent] = git(["rev-list", "--parents", "-n", "1", sha]).split(" ");

  if (!secondParent) {
    return [];
  }

  return lines(git(["rev-list", `${sha}^1..${secondParent}`]));
}

/**
 * Get the committer date of a ref
 *
 * @param  {string} ref A tag, branch or SHA
 *
 * @return {string} The ISO 8601 date, in UTC
 */
function commitDate(ref) {
  return isoDate(git(["log", "-1", "--format=%cI", `${ref}^{commit}`, "--"]));
}

/**
 * Check whether the repository has a truncated history, as a shallow clone does
 *
 * @return {boolean}
 */
function isShallow() {
  return git(["rev-parse", "--is-shallow-repository"]) === "true";
}

/**
 * Check whether a ref resolves to a commit
 *
 * @param  {string} ref
 *
 * @return {boolean}
 */
function refExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export {
  tagCommits,
  tagsMergedInto,
  releaseCommits,
  mergeBranchCommits,
  commitDate,
  isShallow,
  refExists,
};
