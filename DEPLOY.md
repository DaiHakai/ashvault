# Ashvault private playtest

Ashvault is a server-backed browser game. Itch.io is the public game page; the actual live game needs a Node web service and PostgreSQL database.

## Recommended path: Render + itch.io

1. Push this `TextMMO` folder to a private GitHub repository.
2. In Render, create a PostgreSQL database and copy its **internal connection string**.
3. Create a new Blueprint from the repository. Render reads `render.yaml`, creates the Node web service, and generates `AUTH_SECRET` automatically.
4. When Render asks for `DATABASE_URL`, paste the PostgreSQL internal connection string. Do not put it in GitHub or itch.io.
5. Open the service URL and create the first account. The server is ready when `/health` returns `{ "ok": true, "storage": "postgres" }`.
6. Create an itch.io project page for **Ashvault — Private Playtest**. Put the Render game URL in the page description and restrict visibility to the people you invite.

## Itch.io page copy

> Ashvault is a brutal text RPG about going below ground with one life and no safe rooms. Create a weapon-and-background character, survive the Warrens, and earn entry to the city above. This is a private early playtest: deaths are permanent, balance is still changing, and feedback matters.

## Before inviting players

- Test account creation from a phone and desktop browser.
- Set a real project URL and use HTTPS only.
- Keep the test private until account recovery and moderation arrive.
- Never reuse the local development secret in production.
