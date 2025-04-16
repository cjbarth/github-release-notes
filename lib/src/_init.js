import { input, select, confirm, checkbox } from "@inquirer/prompts";
import utils from "./_utils";
import GitHubInfo from "./GitHubInfo";
import GitHub from "github-api";
import chalk from "chalk";

const githubApi = new GitHubInfo();
const { GREN_GITHUB_TOKEN } = process.env;

if (!GREN_GITHUB_TOKEN) {
  console.error(
    chalk.red("Can't find GREN_GITHUB_TOKEN. Please configure your environment") +
      chalk.blue("\nSee https://github.com/github-tools/github-release-notes#setup"),
  );
  process.exit(1);
}

const getInfo = async () => {
  try {
    return await githubApi.repo;
  } catch (error) {
    throw chalk.red("You have to run this command in a git repo folder");
  }
};

const getLabels = async () => {
  const { username, repo } = await getInfo();
  try {
    const gitHub = new GitHub({ GREN_GITHUB_TOKEN });
    const issues = gitHub.getIssues(username, repo);
    const { data: labels } = await issues.listLabels();
    return labels;
  } catch {
    console.warn(
      chalk.bgYellow(
        chalk.black(
          "I can't get your repo labels, make sure you are online to use the complete initialisation",
        ),
      ),
    );
    return false;
  }
};

const configure = async () => {
  const labels = await getLabels();
  const answers = {};

  process.stdout.write("\n🤖 : Hello, I'm going to ask a couple of questions, to set gren up!\n\n");

  answers.apiUrlType = await select({
    message: "What type of APIs do you need?",
    choices: [
      { name: "Normal", value: false },
      { name: "GitHub Enterprise", value: "ghe" },
    ],
  });

  if (answers.apiUrlType === "ghe") {
    answers.apiUrl = await input({
      message: "Write your Enterprise url",
      suffix: chalk.blueBright(" e.g. https://MY_ENTERPRISE_DOMAIN/api/v3"),
      validate: (value) => {
        try {
          new URL(value);
          return true;
        } catch {
          return "Please type a valid url";
        }
      },
    });
  }

  answers.dataSource = await select({
    message: "Where shall I get the informations from?",
    choices: [
      { value: "issues", name: "Issues (Time based)" },
      { value: "milestones", name: "Issues (Milestone based)" },
      { value: "commits", name: "Commits" },
      { value: "prs", name: "Pull Requests" },
    ],
  });

  answers.prefix = await input({
    message: "Do you want to add a prefix to release titles?",
    suffix: chalk.blueBright(" e.g. v"),
  });

  if (answers.dataSource === "commits") {
    answers.includeMessages = await select({
      message: "Which type of commits do you want to include?",
      choices: [
        { value: "merges", name: "Merges" },
        { value: "commits", name: "Commits" },
        { value: "all", name: "All" },
      ],
    });

    answers.ignoreCommitsWithConfirm = await confirm({
      message: "Do you want to ignore commits containing certain words?",
      default: false,
    });

    if (answers.ignoreCommitsWithConfirm) {
      answers.ignoreCommitsWith = await input({
        message: "Which ones? Use commas to separate.",
        suffix: chalk.blueBright(" e.g. changelog,release"),
        filter: (value) => value.replace(/\s/g, "").split(","),
      });
    }
  }

  if (Array.isArray(labels) && answers.dataSource !== "commits") {
    answers.ignoreLabelsConfirm = await confirm({
      message: "Do you want to not output certain labels in the notes?",
      default: false,
    });

    if (answers.ignoreLabelsConfirm) {
      answers.ignoreLabels = await checkbox({
        message: "Select the labels that should be excluded",
        choices: labels.map(({ name }) => name),
      });
    }

    answers.ignoreIssuesWithConfirm = await confirm({
      message: "Do you want to ignore issues/prs that have certain labels?",
      default: false,
    });

    if (answers.ignoreIssuesWithConfirm) {
      answers.ignoreIssuesWith = await checkbox({
        message: "Select the labels that should exclude the issue",
        choices: labels.map(({ name }) => name),
      });
    }
  }

  if (["issues", "prs"].includes(answers.dataSource)) {
    answers.onlyMilestones = await confirm({
      message: "Do you want to only include issues/prs that belong to a milestone?",
      default: false,
    });
  }

  answers.ignoreTagsWithConfirm = await confirm({
    message: "Do you want to ignore tags containing certain words?",
    default: false,
  });

  if (answers.ignoreTagsWithConfirm) {
    answers.ignoreTagsWith = await input({
      message: "Which ones? Use commas to separate",
      suffix: chalk.blueBright(" e.g. -rc,-alpha,test"),
      filter: (value) => value.replace(/\s/g, "").split(","),
    });
  }

  if (answers.dataSource !== "commits") {
    answers.groupBy = await select({
      message: "Do you want to group your notes?",
      choices: [
        { value: false, name: "No" },
        { value: "label", name: "Use existing labels" },
        { value: {}, name: "Use custom configuration" },
      ],
    });
  }

  if (answers.dataSource === "milestones") {
    answers.milestoneMatch = await input({
      message: "How can I link your tags to Milestone titles?",
      default: "Release {{tag_name}}",
    });
  }

  answers.changelogFilename = await input({
    message: "What file name do you want for your changelog?",
    default: "CHANGELOG.md",
    validate: (value) =>
      utils.getFileExtension(value) === "md" ? true : "Has to be a markdown file!",
  });

  const existingConfig = utils.getGrenConfig(process.cwd());
  if (Object.keys(existingConfig).length > 0) {
    answers.fileExist = await select({
      message: "Looks like you already have a configuration file. What do you want me to do?",
      choices: [
        { value: "abort", name: "Oops, stop this" },
        { value: "override", name: "Override my existing file" },
        { value: "merge", name: "Merge these settings over existing ones" },
      ],
    });

    if (answers.fileExist !== "abort") {
      answers.fileType = await select({
        message: "Which extension would you like for your file?",
        choices: utils.getFileTypes(),
      });
    }
  }

  return answers;
};

export default configure;
