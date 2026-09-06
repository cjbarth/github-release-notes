// Serves the repo's own .grenrc.cjs over HTTP so `getConfigFromRemote` can be
// tested without reaching the network.
//
// This has to run in its own process: `getConfigFromRemote` fetches via
// `spawnSync`, which blocks the event loop, so a server sharing the test
// process could never answer the request.
//
// Prints the listening port on stdout once ready.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../../.grenrc.cjs", import.meta.url), "utf8");

const server = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "application/javascript" });
  response.end(config);
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});
