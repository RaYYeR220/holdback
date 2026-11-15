Build the app described in PRD.md, following the stack and style rules in STACK.md. Both files are in the current directory.

Write your own tests for it and run them as you go. The app must start with `npm start` and listen on the port in the `PORT` environment variable; check that it boots before you finish.

You have no web access. Do not commit or push. When you consider the app done, stop and say briefly what you built.

**Verify and fix loop for every code change**

1. Change the code, then start the app or get the preview URL.
2. Run: `kane-cli run "Go to <url> and <action>, then verify <expected result>" --agent --headless --timeout 180`. Give your shell tool a longer timeout than `--timeout` (runs take from 30 seconds to a few minutes; allow up to 10 minutes), or the host kills the run before `run_end`.
3. Check the exit code, then read the `run_end` event (the last stdout line).
4. Exit 0: tell the user the `summary` and, when present, the `test_url` link. Exit 1: read the failing step's `remark` (the line with `"status":"failed"`), fix the code and run the same command again; change the objective's wording only if the run failed because of that wording, and never drop the expected outcome to get a pass. Exit 2: nothing ran; fix sign-in, Chrome or the start URL, then run again. Exit 3: raise `--timeout` or split the objective, then run again.
5. To keep the check as a test, pass `--name <flow>` when you start the run (a finished run cannot be named afterwards). On exit, Kane CLI writes `.testmuai/tests/<flow>_test.md` and `.testmuai/tests/output-<flow>/`. Keep them if the run passed, move both into the repo, commit both, and replay with `kane-cli testmd run <file> --agent`.

## Rules for every kane-cli command

3. Always pass `--agent` to `kane-cli run` and `kane-cli testmd run`. It switches stdout to NDJSON, one JSON event per line.
6. Every run needs a start URL. Start the objective with the site ("Go to https://... and ..."), or pass `--url`.
8. Tag every command with your runtime (for example `claude-code`, `codex`, `gemini`, `cursor`, `kiro`). In bash or zsh, prefix it inline: `KANE_CLI_USER_AGENT=claude-code kane-cli run ...`. In PowerShell: `$env:KANE_CLI_USER_AGENT='codex'; kane-cli run ...`. Do it on each command: an `export` does not survive between shell calls in most agent hosts. The examples below leave the prefix out to stay short; add it when you run them.
9. Browser runs take from 30 seconds to a few minutes. Give your shell tool a long timeout (up to 10 minutes). A real-device run can also wait up to 15 minutes for a free device before it starts.

## Write an objective for kane-cli run

- End every flow in an assertion about what is on screen: `verify the cart shows 1 item`, not `click Submit`. A run with no verify or assert gets no replayable pass or fail.
- Assert the outcome, not the trigger. Do not write `verify the Submit button is visible`: the button goes away when the submit works, so that check fails on success. Write `verify the confirmation message is visible` instead.
- Use "store as" to extract data. `read the price` or `tell me the price` does not reliably capture a value. Write `store the displayed price as 'price'`.
- Refer to a stored value in plain English (`the stored price value`), never as `{{price}}`. `{{name}}` is only for variables and secrets.
- Phrase actions as goals (`log in with {{username}} and {{password}}`) and keep data literal or in `{{variables}}`.
- If an element appears only sometimes, such as a cookie banner, write the step as a condition: `if a cookie banner is visible, close it`.
- Keep one objective under about 15 steps. Split longer flows into separate runs.
- Write objectives that never need input mid-run. Prompts are disabled when stdin is not a terminal, so a step that waits for an answer fails.
- In a double-quoted objective, write a dollar sign as `\$`. Bash turns an unescaped `$42.00` into `2.00`.

## Read kane-cli run output and exit codes

| Exit code | Meaning |
|---|---|
| `0` | Passed |
| `1` | Failed: the objective ran but did not pass, or the upload failed |
| `2` | Did not start: sign-in, configuration, no start URL, Chrome, network, or an unknown subcommand. Nothing ran and no credits were used |
| `3` | Timeout or cancelled |
