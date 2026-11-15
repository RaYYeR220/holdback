Build the app described in PRD.md, following the stack and style rules in STACK.md. Both files are in the current directory.

Check your work in a real browser with Kane CLI, using the verify-and-fix loop:

1. Start the app (`npm start`, listening on the port in the `PORT` environment variable).
2. For each behaviour in PRD.md, write a browser check as a plain-language objective and run it against the running app, for example `kane-cli run "<objective>" --url <app url> --agent --headless`. You can also keep longer checks as `*_test.md` files and run them with `kane-cli testmd run <file> --agent --headless`.
3. Read the result. If a check fails, fix the app (not the check), restart it if needed and run the check again.
4. Repeat until your checks pass.

Write your own checks; nobody will hand you any. You have no web access. Do not commit or push. When you consider the app done, stop and say briefly what you built.
