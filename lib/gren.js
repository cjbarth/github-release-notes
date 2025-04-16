#!/usr/bin/env node

import { Command } from "commander";
import { version, description } from "../package.json";

const gren = new Command("gren");
const argvWithVersion = (argvs) => {
  const vPos = argvs.indexOf("-v");

  if (vPos > -1) {
    argvs[vPos] = "-V";
  }

  return argvs;
};

gren
  .version(version)
  .description(`gren (🤖) ${description}`)
  .usage("<command> [options]")
  .command("init", "Initialise the module options")
  .alias("i")
  .command("release", "Generate release notes and attach them to a tag")
  .alias("r")
  .command("changelog", "Create a CHANGELOG.md file, based on release notes")
  .alias("c")
  .command("examples", "Show few examples of stuff that you can do <cmd>")
  .parse(argvWithVersion(process.argv));
