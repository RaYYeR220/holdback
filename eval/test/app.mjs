// Stand-in for an arm's app: records the environment it was started with, then serves.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
writeFileSync("env.json", JSON.stringify({ today: process.env.HOLDBACK_TODAY, now: process.env.HOLDBACK_NOW, dataDir: process.env.DATA_DIR }));
createServer((_q, r) => r.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
