#!/usr/bin/env node

import Program from "./src/Program.js";
import Gren from "./src/Gren.js";
import { globalOptions, releaseOptions } from "./_options.js";
import chalk from "chalk";

const releaseCommand = new Program({
  name: `${chalk.green("gren")} release`,
  description: "Generate release notes and attach them to a tag",
  argv: process.argv,
  cwd: process.cwd(),
  options: releaseOptions.concat(globalOptions),
});

releaseCommand
  .init()
  .then((options) => {
    const releaseAction = new Gren(options);

    return releaseAction.release();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
