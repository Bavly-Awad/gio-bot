# Gio Bot

Discord bot for the lightskingio community servers. Presence, `/suggest` + `/eightball` + `/wl` commands, auto-voting threads in ideas channels, welcome messages, and a daily member-growth tracker.

Runs 24/7 free on Render (web service + self-ping keep-alive).

## Deploy (Render, no credit card)

1. Sign in at [render.com](https://render.com) with GitHub
2. **New → Blueprint** → select this repo
3. Paste the bot token when prompted for `BOT_TOKEN`
4. Deploy — done

The `PORT` and `RENDER_EXTERNAL_URL` env vars are injected by Render automatically.
