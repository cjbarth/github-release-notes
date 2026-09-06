import YAML from "yamljs";
import chalk from "chalk";
import { writeFileSync } from "node:fs";
import { changelogOptions, releaseOptions, globalOptions } from "../lib/_options.js";

const stringifyObject = (array) =>
  YAML.stringify(
    array
      .filter(({ short }) => short)
      .map((option) => {
        const filteredObject = Object.assign({}, option);
        delete filteredObject.action;

        return filteredObject;
      }),
  );
const files = {
  "changelog-options": stringifyObject(changelogOptions),
  "release-options": stringifyObject(releaseOptions),
  "global-options": stringifyObject(globalOptions),
};

Object.entries(files).forEach(([filename, content]) => {
  writeFileSync(`${process.cwd()}/docs/_data/${filename}.yml`, content);

  console.log(chalk.green(`docs/_data/${filename}.yml created.`));
});
