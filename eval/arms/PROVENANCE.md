# Arm prompts: provenance

`a-self.md` is arm A's prompt. `b-self-kane.md` is arm B's prompt: `a-self.md` byte for byte, then blocks copied verbatim from Kane's own instructions for coding agents. Arm B is "A plus Kane" and nothing else.

Retrieved 2026-11-15, kane-cli 0.10.4 (`kane-cli --version`).

| Source | Where | Copied |
| --- | --- | --- |
| https://www.testmuai.com/kane-cli/llms.txt | lines 7-13 | the "Verify and fix loop for every code change" block |
| https://www.testmuai.com/kane-cli-agent/AGENTS.md (full text) | line 9 | heading "Rules for every kane-cli command" |
| same | lines 13, 16, 18, 19 | rules 3, 6, 8 and 9 |
| same | line 73 and lines 84-92 | heading "Write an objective for kane-cli run", its bullets, including the `$` escaping rule |
| same | line 99 and lines 116-121 | heading "Read kane-cli run output and exit codes" and the exit-code table |

Left out on purpose: the "Test cases from requirements" section and rule 2 (assurance commands, `kane-cli context`, `design`, `maintain`, `cover`): the pre-registration has arm B write its own checks. Arm B's settings deny `Bash(kane-cli context:*)`, `Bash(kane-cli design:*)` and `Bash(kane-cli maintain:*)`. Arm A denies every `kane-cli` command.

Carriage returns were stripped from the copied lines; nothing else changed.

Arm A's prompt has no instruction about git; arms may commit inside their own arm repo, and the runner commits anything left over at the end.
