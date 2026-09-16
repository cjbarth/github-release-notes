# AGENTS.md

## What this is

`gren` generates release notes and changelogs from a repository's tags, pull requests and
issues. It is a CLI published to npm, and it is used to produce the `CHANGELOG.md` of
projects such as `xml-crypto` and `node-saml`.

The changelog is the product. A bug here does not crash anything — it quietly writes a
wrong history, and nobody notices until someone goes looking for when a fix shipped.
Silent under-reporting is the failure mode to fear, not an exception.

## Layout

- `lib/gren.js` — the CLI entry point; `lib/gren-*.js` are its commands.
- `lib/_options.js`, `lib/_examples.js` — the option and example definitions. The README
  tables are generated from these.
- `lib/src/Gren.js` — nearly all the behavior: release selection, commit and pull request
  matching, templating, changelog assembly.
- `lib/src/_git.js` — the local git reads. Everything that shells out to git lives here.
- `lib/src/_utils.js`, `_template.js`, `templates.js` — configuration loading, templating
  and the default templates.
- `test/*.spec.js` — Mocha specs. `test/fixtures/release-repo.js` builds a throwaway git
  repository with two release lines, used by the membership and `_git` specs.

## Commands

- `npm test` — `c8 mocha`.
- `npm run lint` — ESLint plus `prettier --check`.
- `npm run lint:fix` — rewrites files.
- `npm run docs` — regenerates the README's option and example tables from `lib/_options.js`
  and `lib/_examples.js`.
- `npx markdownlint-cli2 "**/*.md" "#node_modules"` — checks the markdown against
  `.markdownlint.json`.

Run `npm test && npm run lint` before calling work done, and the markdown check as well if
you wrote or generated any markdown. If you touched `lib/_options.js`
or `lib/_examples.js`, run `npm run docs` too and commit what it changes.

`test/Gren.spec.js` skips itself when `GREN_GITHUB_TOKEN` is unset, which is what CI does.
A green local run with a token is not the same run CI makes — use
`env -u GREN_GITHUB_TOKEN npx mocha` to see what it will see.

## Hard constraints

### Never hand-edit a generated changelog

A section that comes out wrong is a symptom. Fix the cause — the pull request's title or
labels, or the project's `gren` configuration — and regenerate. Editing the output leaves
the next regeneration to undo the correction, and hides the defect that produced it.

This applies to `gren`'s own `CHANGELOG.md`, which `release-it` regenerates on every
release through the `commits` data source. Commit subjects are the release notes here, so
the commit message rules in `README.md` are not decoration.

### No repository-specific knowledge in the code

Real repositories have odd histories: an upstream that was renamed, tags in two spellings,
a security fix with no pull request. Every one of those is a configuration option, never a
name or SHA in `lib/`. If a project needs something `gren` cannot express, add the option.

### Downstream repositories are out of scope

Changes to a project that consumes `gren` are its maintainer's to make. Generate into a
scratch file to verify, never over a real `CHANGELOG.md`, and leave no files behind in
someone else's checkout.

### Prefer an additive minor release

New options and better output are minor. Removing an option, renaming one, or changing
what an existing option means is major, and worth avoiding rather than versioning around.
An option that cannot be expressed on a command line — a function, or a nested object such
as `commitNotes` — belongs in the configuration file only, not in a second format.

### The supported Node floor is real

`engines` in `package.json` is the contract and `.github/workflows/ci.yml` runs the matrix.
Read both rather than assuming.

### Releasing cleans the working tree

`npm run prerelease` begins with `git clean -xfd`. Anything uncommitted, including new
files, is gone before the tests run. Commit first.

## Verifying a change

The test suite runs against stubs. Stubs agree with whatever you believed when you wrote
them, so they cannot tell you that belief was wrong. Before calling a change to the
generation path done, run it over a repository with real history — many years of tags, merge
commits, rebase merges and commits with no pull request — writing to a scratch file, and
diff that against the output from before the change.

Pick a repository that exercises what you changed. Options that only some projects use,
such as looking for pull requests in another repository, are covered by no other means: if
nothing you run touches that code path, it is untested however green the suite is.

Say what the diff was. "No diff" and "these three sections changed, because X" are both
answers. "It should be fine" is not one.

## Tests

Test observable behavior: which releases are generated, what ends up in a section, what is
reported, and what stops the run. Reach for a private method only where it has a contract
of its own, such as `_readChangelogSections` or the `_git.js` wrappers.

- **Make the test fail first.** For a bug, reproduce it and watch the test fail for the
  reported reason before fixing anything. A fix whose test never failed is a guess.
- **Model the API as it really behaves.** When a stub and GitHub disagree, the suite is
  worse than useless: it certifies the mistake. If you learn something about a real
  response — a status code, a field that is sometimes absent — teach the fixture, then
  watch the existing tests fail.
- **Don't assert another tool's formatting.** `git` and GitHub are free to render the same
  value differently between versions. Normalise at the boundary and assert the value, not
  the spelling it arrived in.
- Prefer the shared fixture repository over a new one. It already has two release lines, a
  real cross-line merge, a merge-commit pull request, a rebase-merged one, direct commits
  and duplicate tag spellings.

## Style

- ESM, Node 24, CommonJS only where a configuration file demands it.
- `consistent-return` and `prefer-const` are errors, and `no-multiple-empty-lines` allows
  one. Prettier owns formatting at `printWidth: 100`; don't hand-format.
- Errors shown to a user are thrown as `chalk.red(...)` strings, not `Error` objects, and
  say what to do about it. Compare the shallow-clone and missing-tag messages.
- Warnings that name commits or releases go through `console.warn` in yellow, and give the
  configuration to paste in where there is one.
- Markdown, this file included, passes `markdownlint` under the repository's
  `.markdownlint.json`. That goes for markdown `gren` writes as much as markdown committed
  here: a changelog that makes a linter complain is a changelog someone has to hand-edit.

## Comments

Code describes itself. Name things well and keep functions small enough that the _what_ and
the _how_ read from the code, then don't restate them in prose that goes stale the first
time someone edits the line below.

Comment what the code cannot say: _why_ this way, what breaks if it is done the obvious
way, which non-obvious constraint is being satisfied. Most comments in `Gren.js` earn their
place by recording a fact about git or GitHub that the code below depends on — that only a
rebase merge leaves commits unmatched by `merge_commit_sha`, that 422 means the commit is
elsewhere. Those are worth keeping. A comment restating the line under it is not.

Don't narrate history. A bug the code no longer has belongs in the commit message, and
`git blame` leads there.

JSDoc on exported and private methods alike is the house style here and is welcome. Keep it
to the contract — parameters, what comes back, what it throws — not the implementation.

## Conventions

- Keep changes scoped to the problem. Don't fold unrelated cleanup into a fix.
- Read the implementation and its tests before changing behavior. Don't infer behavior from
  a name when the repository can answer the question.
- Report what actually happened. If a test fails, say so and show the output. If a step was
  skipped, say which. Confidence that a verification run will pass is not a result.
