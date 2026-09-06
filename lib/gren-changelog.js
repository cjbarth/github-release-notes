#!/usr/bin/env node

import Program from "./src/Program.js";
import Gren from "./src/Gren.js";
import { globalOptions, changelogOptions } from "./_options.js";
import chalk from "chalk";

const changelogCommand = new Program({
  name: `${chalk.green("gren")} changelog`,
  description: "Create a CHANGELOG.md file, based on release notes",
  argv: process.argv,
  cwd: process.cwd(),
  options: changelogOptions.concat(globalOptions),
  events: {
    "--help": () => {
      console.log("");
      console.log("  Basic Examples:");
      console.log("");
      console.log("    $ gren changelog");
      console.log("");
      console.log("    $ gren changelog --generate");
      console.log("");
    },
  },
});

changelogCommand
  .init()
  .then((options) => {
    const changelogAction = new Gren(options);

    return changelogAction.changelog();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
