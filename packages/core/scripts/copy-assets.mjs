// tsc does not copy non-TS files: ship the agent contract next to the compiled driver.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("dist/agent", { recursive: true });
copyFileSync("src/agent/contract.md", "dist/agent/contract.md");
