import { exec } from "child_process";
import chalk from "chalk";

/** Class retrieving GitHub informations from the folder where .git is initialised. */
class GitHubInfo {
  /**
   * Getter for the options
   *
   * @return {Promise.all}
   */
  get options() {
    return Promise.all([this._repo(), this._token()]);
  }

  /**
   * Getter for the token
   *
   * @return {Promise}
   */
  get token() {
    return this._token();
  }

  /**
   * Getter for the repo
   *
   * @return {Promise}
   */
  get repo() {
    return this._repo();
  }

  /**
   * Execute a command in the bash and run a callback
   *
   * @since 0.5.0
   * @private
   *
   * @param  {string}   command The command to execute
   * @param  {Function} callback The callback which returns the stdout
   *
   * @return {Promise}
   */
  _executeCommand(command, callback) {
    return new Promise((resolve, reject) => {
      exec(command, (err, stdout, stderr) => {
        if (err || stderr) {
          reject(err || stderr);
        } else {
          resolve(stdout.replace("\n", ""));
        }
      });
    })
      .then(callback) // eslint-disable-line promise/no-callback-in-promise
      .catch((error) => {
        throw new Error(
          chalk.red(error) +
            chalk.yellow(
              "\nMake sure you're running the command from the repo folder, or you using the --username and --repo flags.",
            ),
        );
      });
  }

  /**
   * Get repo informations
   *
   * @since 0.5.0
   * @public
   *
   * @param  {Function} callback
   *
   * @return {Promise} The promise that resolves repo informations ({user: user, name: name})
   */
  _repo(callback) {
    return this._executeCommand("git config remote.origin.url", (repo) => {
      const regex = /([\w-.]+)\/([\w-.]+?)(\.git)?$/g;
      const matches = [...repo.matchAll(regex)];

      if (!matches[0]) {
        return Promise.reject(new Error("No repo found"));
      }

      const user = matches[0][1];
      const name = matches[0][2];

      return {
        username: user,
        repo: name,
      };
    }).then(callback); // eslint-disable-line promise/no-callback-in-promise
  }

  /**
   * Get token informations
   *
   * @since 0.5.0
   * @public
   *
   * @param  {Function} callback
   *
   * @return {Promise} The promise that resolves token informations ({token: token})
   */
  _token() {
    const token = process.env.GREN_GITHUB_TOKEN;

    return token ? Promise.resolve({ token }) : Promise.resolve(null);
  }
}

export default GitHubInfo;
