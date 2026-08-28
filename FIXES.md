# Fixes — Discord Bot Manager MC server pinging

I cloned the repo, reproduced the bugs, and fixed them in the Minecraft-related bots.

## Root causes found

**1. `bots/tommyland.js` never loaded at all (Bots 3 & 4).**
`const https = require('https')` was declared **twice** in the same file, which is a
JavaScript `SyntaxError`. Because `bots/discord-bot.js` reuses this same module, the
**Falix MC manager bots (tommyland + discord-bot) crashed on startup** — the whole file
failed to parse. This is the primary reason the bots "fail to ping".

**2. Shared module-level state clobbered the two MC manager bots.**
`tommyland.js` kept `client`, `botData`, `DATA_FILE`, `srvCache`, and `lastKnownStatus`
at module scope. Since Bot 3 (`tommyland`) and Bot 4 (`discord-bot`) both `require('./tommyland')`
and get the *same cached module instance*, starting one overwrote the other's state —
the two bots interfered with each other's servers and commands.

**3. Online/offline status was reported wrong for Falix servers.**
Falix free servers answer the TCP port on the Falix proxy **even when asleep**, and their
status response includes an "OFFLINE" motd. The old code ignored that signal and fell
through to a raw TCP ping, which "succeeded", so an **asleep server was falsely reported
as "Online, 0 players"** instead of "Sleeping", and online servers could be missed because
the only full-info path (`minecraft-server-util`) had a weak timeout and the `mcsrvstat.us`
fallback incorrectly required `players.max > 0`.

**4. Fragile global DNS override.**
Both files called `dns.setServers(['8.8.8.8', '1.1.1.1'])`, forcing all DNS (including the
Discord gateway) through Google's servers — this can break in restricted VMs.

## What I changed

### `bots/tommyland.js` (Bots 3 & 4)
- Removed the duplicate `const https = require('https')` → file parses again.
- Made the module **instance-safe**: all mutable state (`client`, `botData`, `DATA_FILE`,
  `srvCache`, `lastKnownStatus`) now lives inside `start()`. Bot 3 and Bot 4 now run fully
  independently in the same process.
- Rewrote `getServerStatus` to correctly classify a server:
  1. Direct `minecraft-server-util` ping → full info (players / version / latency) when online.
  2. If the response says "offline"/asleep → **💤 Sleeping** (not falsely "online").
  3. `mcsrvstat.us` fallback (no faulty `max` guard) so online servers are caught even if the
     direct ping is slow.
  4. TCP reachability + final offline detection.
- `/status` (prefix & slash) now shows Sleeping / Online / Offline with a Wake-up button.
- Removed the global `dns.setServers` override; `fetchJSON` now preserves the URL query string.

### `bots/mc-status.js` (Bot 5)
- Same corrected `getServerStatus` classification logic, plus `mcsrvstat.us` fallback.
- `!status`/`!ping` and `/status` now show a Sleeping message instead of falsely "Online".
- Removed the global `dns.setServers` override.

## Second round — "offline" vs "sleeping" (per user request)
The user's rule: report **online** when the server is actually accepting players, and
**offline** when it isn't. The earlier "💤 Sleeping" middle state was confusing.

Falix free servers stay running (the panel shows "Online") but pause the actual Minecraft
process at 0 players — the MC protocol then answers the ping with `version: "OFFLINE"` /
motd `"Server is OFFLINE - Join to start automatically"`. Since the server is NOT
accepting players, it is now correctly reported as **🔴 Offline** (with a note that it's
idle and auto-starts on join) rather than "Online" or a separate "Sleeping" state.

Changes in `tommyland.js` and `mc-status.js`:
- Removed the `sleeping` state and `sleepingEmbed`; the Falix idle/paused response now
  returns `{ online: false, paused: true }`.
- `/status`, `!status`, and the poll loop treat any `online:false` as **🔴 Server Offline**,
  with the description mentioning "idle, 0 players — auto-starts when someone joins" when
  `paused` is true, and a Start/Wake-Up button in the manager bots.
- Only a server that genuinely responds to the MC status protocol (players can connect) is
  shown as **✅ Server Online**.

Verified live: `hollowed_void.falixsrv.me` (idle Falix server) → Offline; `mc.hypixel.net`
→ Online with real players/version/latency.

## Third round — server shown "Offline" even when online (modern MC / wrong port)

Reported: the bot for `deepriftredo.falixsrv.me` (Minecraft **26.2 / protocol 776**) kept
saying "Offline/idle" even though the server was running, and never sent the
"came online" notification.

Root cause in `bot-manager`'s `tommyland.js` / `mc-status.js`:
1. **Wrong port.** The code resolved the Falix **SRV** record correctly (→ port **25537**),
   but then called `minecraft-server-util`'s `status()` on it.
2. **Library crash.** Modern MC status JSON has **no `description`/MOTD field**
   (`{"players":…,"version":…,"favicon":…}`). `minecraft-server-util` throws
   `Unexpected server MOTD type: undefined`.
3. After the crash, the code fell through to a TCP-ping check and, because the port was
   reachable, wrongly returned `{ online:false, paused:true }` → reported **Offline** even
   though the server was actually online (and never fired the online notification).

Fix: replaced the `minecraft-server-util` status call with a **raw server-list ping** that
- follows the Falix **SRV** record to the correct port (or `SERVER_IP:MINECRAFT_PORT`),
- parses the modern JSON manually (tolerates a missing MOTD), and
- still detects the Falix paused/"OFFLINE — join to auto-start" state.

Verified live: both `tommyland.js` and `mc-status.js` now return
`online:true, players 0/100, version 26.2, latency ~450ms` for `deepriftredo.falixsrv.me`,
so `/status` shows Online and `pollServer` correctly posts "🟢 Server Just Came Online!".
Optional `.env` overrides: `SERVER_IP` and `MINECRAFT_PORT`.

### `bots/discord-bot.js`
- No change needed — it reuses `tommyland.js`, which is now instance-safe.

## Verification
- `node --check` passes for every file.
- The app boots cleanly and the `/health` endpoint responds.
- The fixed status logic was tested live against a real online server (returns full player
  count + version), a real offline Falix host (returns **Sleeping**), and an unreachable host
  (returns **Offline**).

## How to run
```bash
cp .env.example .env   # fill in your BOT3/BOT4/BOT5 tokens + subdomains
npm install
npm start
```
