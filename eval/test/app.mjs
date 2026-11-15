// Stand-in for an arm's app: records the environment it was started with, then serves.
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
if (process.env.FAKE_APP_BOOT === "fail") process.exit(1);
if (process.env.FAKE_APP_ENV_FILE) {
  writeFileSync(process.env.FAKE_APP_ENV_FILE, JSON.stringify({ today: process.env.HOLDBACK_TODAY, now: process.env.HOLDBACK_NOW, dataDir: process.env.DATA_DIR, cwd: process.cwd() }));
}
createServer((_q, r) => r.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
