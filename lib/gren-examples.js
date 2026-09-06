#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { generateExamples, gren, release, changelog } from "./_examples.js";

const program = new Command();

let command;
const examples = { gren, release, changelog };
const commandList = Object.keys(examples);

program
  .name("gren examples")
  .argument("[command]", `The command to show examples for [${commandList.join("|")}]`)
  .description(
    `See few examples for how to use gren. For more informations (and a bit of UI) check ${chalk.blue(
      "https://github.com/cjbarth/github-release-notes#examples",
    )}`,
  )
  .usage("<command>")
  .on("--help", () => {
    console.log("");
    console.log("  Commands:");
    console.log("");
    console.log("      $ gren examples gren");
    console.log("      $ gren examples release");
    console.log("      $ gren examples changelog");
    console.log("");
  })
  .action((cmd) => {
    command = cmd;
  })
  .parse(process.argv);

if (!command || !commandList.includes(command)) {
  console.error(
    `${chalk.red("You must specify one of these commands to output examples")} [${commandList.join(
      "|",
    )}]`,
  );

  process.exit(1);
}

generateExamples(command, examples[command]);
