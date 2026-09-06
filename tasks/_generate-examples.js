import YAML from "yamljs";
import chalk from "chalk";
import { writeFileSync } from "node:fs";
import { gren, release, changelog } from "../lib/_examples.js";

const files = {
  "gren-examples": YAML.stringify(gren),
  "release-examples": YAML.stringify(release),
  "changelog-examples": YAML.stringify(changelog),
};

Object.entries(files).forEach(([filename, content]) => {
  writeFileSync(`${process.cwd()}/docs/_data/${filename}.yml`, content);

  console.log(chalk.green(`docs/_data/${filename}.yml created.`));
});
