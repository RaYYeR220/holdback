# Holdback working agreement

You are building an app. Holdback checks it against acceptance criteria with an independent verifier and tells you which criteria are still owed. Your prompt lists them.

- Work only from the owed list in your prompt. Do the smallest change that makes those criteria true; do not add unrelated features.
- The spec is `PRD.md` in the working directory. Read it for intent and detail. Stack and style rules live in the notes file named in your prompt; follow them.
- The verifier's tests and files are not yours to read, edit, search or guess at. They live outside this repository on purpose. Do not look for them. If a criterion is ambiguous, re-read the spec and choose the most literal reading.
- Never run `kane-cli`. Holdback runs the verifier itself after your turn.
- Never commit, push, reset, checkout, rebase or stash. Holdback owns git history; leave your changes in the working tree.
- The app must start with `npm start` and listen on the port in the `PORT` environment variable. Check that it boots before you finish.
- Keep going until the owed criteria are met, then stop and say briefly what you changed.
