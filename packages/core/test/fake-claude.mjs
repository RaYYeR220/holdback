// Stand-in for `claude -p`: reads the prompt from stdin, prints a stream-json transcript.
// FAKE_CLAUDE_MODE: ok (default) | error | killed | hang
// FAKE_CLAUDE_ARGS_FILE / FAKE_CLAUDE_STDIN_FILE: record argv / stdin. FAKE_CLAUDE_STDERR: text for stderr.
import { writeFileSync } from "node:fs";
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
if (process.env.FAKE_CLAUDE_ARGS_FILE) writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
if (mode === "hang") setInterval(() => {}, 1000);
else {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) stdin += c;
  if (process.env.FAKE_CLAUDE_STDIN_FILE) writeFileSync(process.env.FAKE_CLAUDE_STDIN_FILE, stdin);
  if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR);
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: "system", subtype: "init", session_id: "s1" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  if (mode === "ok")
    out({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.12, num_turns: 7, duration_ms: 5 });
  if (mode === "error")
    out({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["too many", "turns"], total_cost_usd: 0.3, num_turns: 3 });
  process.exit(mode === "ok" ? 0 : 1);
}
