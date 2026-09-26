# Ezra's Capybara Escape Game

A single-file HTML5 canvas game: guide a capybara out of the zoo, across the road, through the fields and up the
reindeer mountain, then face Darth Vader. Open `index.html` in a browser to play — no build step.

## Leaderboard

The game has two leaderboard modes and picks one automatically:

| Mode | When | Where scores live |
|------|------|-------------------|
| **Shared** 🌍 | The game can reach the leaderboard server | A JSON file on the server, seen by everyone |
| **Local** 💾 | No server found (e.g. plain GitHub Pages) | `localStorage` in that browser only |

If the server goes down mid-game, scores fall back to local storage rather than being lost.

### Running the server

Needs Node 12 or newer. There is nothing to install.

```bash
npm start
```

Then open <http://localhost:3000>. The server serves the game and the API from the same address, so the game finds
it on its own. Scores are saved to `server/data/scores.json` (git-ignored).

| Environment variable | Default | Meaning |
|----------------------|---------|---------|
| `PORT` | `3000` | Port to listen on |
| `SCORES_FILE` | `server/data/scores.json` | Where scores are stored |
| `ALLOWED_ORIGIN` | `*` | Website allowed to call the API from a browser (set to your Pages URL in production) |
| `TRUST_PROXY` | off | Set to `1` behind a proxy that sets `X-Forwarded-For`, so rate limiting sees real client addresses |
| `SUBMIT_GAP_MS` | `10000` | Minimum time between submissions from one address |

### Using it with GitHub Pages

GitHub Pages only hosts static files, so it can't run the server. Host the server somewhere that runs Node, then
point the game at it, either by editing `LEADERBOARD_API` near the top of the leaderboard code in `index.html`:

```js
const LEADERBOARD_API = 'https://scores.example.com';
```

or, to try it without editing anything, by adding `?api=` to the game's URL:

```
https://your-name.github.io/capybara-escape/?api=https://scores.example.com
```

Set `ALLOWED_ORIGIN` on the server to your Pages address (for example `https://your-name.github.io`).

**Free hosts:** many wipe the disk when the app restarts or redeploys, which would erase the scores. Use a host with
a persistent disk/volume and point `SCORES_FILE` at it.

### API

| Method & path | Description |
|---------------|-------------|
| `GET /api/health` | `{ "ok": true }` — used by the game to detect the server |
| `GET /api/scores?limit=10` | Top scores, fastest first (limit up to 50) |
| `POST /api/scores` | Body `{ "name", "time", "lives" }`. Returns `{ entry, rank, persisted, scores }`. `429` if submitted too soon |

Ranking: fastest time wins; ties go to whoever finished with more lives, then whoever got there first. The best 200
scores are kept. Names are cleaned up and limited to 12 characters.

### Limitations

This is a family-and-friends leaderboard, not a competitive one:

- **Scores are reported by the browser**, so a determined player can submit a fake time. The server only rejects
  impossible values and rate-limits each address.
- **Names are not filtered for bad language.** If the game is public, add a word filter or review the scores file.
