# Holdback working agreement

You are building an app. Holdback checks it against acceptance criteria with an independent verifier and tells you which criteria are still owed. Your prompt lists them.

- Work only from the owed list in your prompt. Do the smallest change that makes those criteria true; do not add unrelated features.
- The spec is the file (or files) named on the `Spec:` line of your prompt, in the working directory. Read it for intent and detail. Stack and style rules live in the notes file named in your prompt; follow them.
- The verifier's tests and files are not yours to read, edit, search or guess at. They live outside this repository on purpose. Do not look for them. If a criterion is ambiguous, re-read the spec and choose the most literal reading.
- Never run `kane-cli`. Holdback runs the verifier itself after your turn.
- Never commit, push, reset, checkout, rebase or stash. Holdback owns git history; leave your changes in the working tree.
- Do not change git configuration, git hooks or hook managers (husky, lint-staged, pre-commit and the like), and run only read-only git commands (status, diff, log, show). Holdback commits for you.
- The app must start with the command on the `Start command:` line of your prompt and listen on the port in the `PORT` environment variable, and keep its data in the folder the `DATA_DIR` environment variable names. Check that it boots before you finish, with `DATA_DIR` as you got it: it points at a scratch folder outside this repository, so the check leaves no data in the repo.
- Keep going until the owed criteria are met, then stop and say briefly what you changed.
