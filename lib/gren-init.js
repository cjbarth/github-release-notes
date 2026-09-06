#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ObjectAssignDeep from "object-assign-deep";
import init from "./src/_init.js";
import * as utils from "./src/_utils.js";
import fs from "node:fs";

const gren = new Command();

gren
  .name(`${chalk.green("gren")} release`)
  .description("Initialise the module options.")
  .parse(process.argv);

init()
  .then(
    ({
      fileExist,
      apiUrlType,
      ignoreCommitsWithConfirm,
      ignoreLabelsConfirm,
      ignoreIssuesWithConfirm,
      ignoreTagsWithConfirm,
      fileType,
      ...data
    }) => {
      if (fileExist === "abort") {
        console.log("Command aborted.");
        return;
      }

      if (fileExist === "override") {
        const fileContent = utils.writeConfigToFile(fileType, data);

        utils.cleanConfig(true);
        fs.writeFileSync(fileType, fileContent);

        console.log(chalk.green(`\nGreat news! Your ${fileType} as been created!`));
        return;
      }

      const currentConfig = utils.getGrenConfig(process.cwd());
      const fileContent = utils.writeConfigToFile(
        fileType,
        ObjectAssignDeep({}, currentConfig, data),
      );

      fs.writeFileSync(fileType, fileContent);

      console.log(chalk.green(`\nGreat news! Your ${fileType} as been created!`));
      return;
    },
  )
  .catch((error) => {
    console.log(error);
    process.exit(1);
  });
