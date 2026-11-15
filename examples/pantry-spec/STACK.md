# Stack

How the pantry app is built and run. What it does is in PRD.md.

- Runtime: Node.js 24. Plain JavaScript ES modules (`"type": "module"` in package.json). No build, bundling or transpiling step.
- Web server: Hono (`hono` with `@hono/node-server`). Every page is HTML rendered on the server.
- Browser side: no client-side framework. A little plain JavaScript in a page is fine.
- Data: `node:sqlite`, the SQLite module built into Node. One database file inside the folder named by the `DATA_DIR` environment variable, default `./data`. On start the app creates the folder and its tables if they are missing; it needs no seed data.
- Start: `npm start` starts the server on the port in the `PORT` environment variable, default 3100.
- Time zone: the server's local time zone is the pantry's local time for every date and time in the app.
- Today: if the `HOLDBACK_TODAY` environment variable is set to a date (YYYY-MM-DD), the app uses that date as today for the volunteer list and for the visit times offered on the Book a visit page.
- Now: if the `HOLDBACK_NOW` environment variable is set to a time of day (HH:MM, 24-hour, local time), the app uses it as the current time wherever the time of day matters. Together with `HOLDBACK_TODAY` it fixes "now" completely.
