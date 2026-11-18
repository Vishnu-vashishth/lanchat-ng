# lanchat-ng

[![CI](https://github.com/Vishnu-vashishth/lanchat-ng/actions/workflows/ci.yml/badge.svg)](https://github.com/Vishnu-vashishth/lanchat-ng/actions/workflows/ci.yml)

Encrypted, peer-to-peer **LAN chat** for private internal team communication.
A clean TypeScript rewrite inspired by [Lanchat](https://git.sr.ht/~youkai/lanchat)'s
design (UDP discovery + a TCP peer mesh), with a modern protocol and a
privacy-first default posture.

This is an **independent implementation** — no Lanchat source was copied, only
its high-level design ideas (which are not copyrightable). License it however
your team wants; the `package.json` tag is a placeholder.

## Why not just use Lanchat?

The original is archived, unmaintained, and its author documents known security
issues that won't be fixed. The biggest ones we fix here:

| Lanchat | lanchat-ng |
|---|---|
| Trust pinned to **IP address** | Trust pinned to **key fingerprint** (identity) |
| Only message bodies encrypted; **nicknames, status, etc. sent as plaintext JSON** | **Everything** after the handshake is encrypted — only ephemeral keys appear in cleartext |
| RSA-PKCS#1 + AES | X25519 ECDH (forward secrecy) + Ed25519 auth + XChaCha20-Poly1305 |
| Always broadcasts on the LAN | Discovery is **opt-in**; connect by address by default |
| History on disk | **Memory-only by default**; disk history is opt-in; `/burn` wipes it |

## Install

Requires **Node.js ≥ 20**. The CLI ships prebuilt — **no build step, no
toolchain needed**.

```bash
npm install -g https://github.com/Vishnu-vashishth/lanchat-ng/releases/latest/download/lanchat-ng.tgz
```

That gives you an **`lchat`** command (plus a `lanchat-ng` alias). Check it:

```bash
lchat --help
```

The `latest/download` URL always resolves to the newest release, so the same
command installs and updates. From inside the app, `/selfupdate` does this for
you. Uninstall: `npm uninstall -g lanchat-ng`.

> **Why the release tarball and not `npm i -g git+https://…`?** Some npm
> versions mishandle git installs (they can link the package to a cache temp
> dir that's then deleted, leaving a broken command). The release tarball
> installs cleanly everywhere. To build from the repo instead, see
> *Develop (from source)* below.

## Run

Just start it — you land in the default `lobby` room:

```bash
lchat --nick alice
```

Two people on the same LAN, connecting by address:

```bash
# on alice's machine
lchat --nick alice --port 4040

# on bob's machine — connect to alice once; the mesh gossips the rest
lchat --nick bob --connect 192.168.1.23:4040
```

**On first contact, compare fingerprints** out-of-band (read them aloud / over
another channel). After that the key is pinned and impersonation is rejected.

## Rooms

A **room** is just a shared, named channel. Everyone starts in `lobby`. Rooms
also drive LAN discovery: peers only ever auto-connect to each other when they
**share a room**, so a room name + password doubles as a lightweight access gate.

### Start a new room

There's no "create" step — you start a room by joining a name nobody is using
yet. The first person in sets the password. On the same LAN, the easiest way is
to launch straight into it (this turns on UDP discovery automatically):

```bash
# Alice opens room "project-x" with a password, and starts advertising it
lchat --nick alice --room project-x --pass hunter2
```

Anyone else on the LAN joins by launching with the **same room and password** —
no IP address needed; discovery finds Alice and auto-connects:

```bash
lchat --nick bob --room project-x --pass hunter2
```

Prefer not to broadcast on the LAN? Add `--no-discovery` and have people connect
by address (`--connect host:port`) instead; the room/password still gates who is
admitted.

### Join or switch rooms while running

From inside the chat:

```
/join project-x hunter2     create/join "project-x" (set its password if new), and switch to it
/room project-x             alias for /join
/leave project-x            leave a room
/rooms                      list the rooms you're in
/update project-x newpass   change a room's password
```

Messages you type go to the room you're currently switched to.

## Commands

```
/help                   show help
/nick <name>            change nickname
/join <room> [pass]     join (and switch to) a room, optionally setting its password
/room <room>            alias for /join
/leave <room>           leave a room
/rooms                  list the rooms you're in
/update <room> <pass>   change a room's password
/peers  /names          list connected peers
/connect <host[:port]>  connect to a peer directly
/fp  /me                show your fingerprint
/history on|off         toggle on-disk history (default: off, memory only)
/color on|off           toggle ANSI colors
/burn                   wipe history (memory + disk) and clear the screen
/hide  /panic           hide the screen — Ctrl+X, F2 or Ctrl+O (press again to resume)
/combo <name>           send a kaomoji combo (/combos lists them)
/combos                 list all combo names
/notify                 send a test desktop notification
/selfupdate             update lanchat-ng from the latest GitHub release
/quit                   exit
```

Tab completes command names, and typing shows peers a live "is typing…" hint.

## Options

```
-n, --nick <name>              nickname (default: your username)
-p, --port <port>              TCP listen port (default: 4040)
-c, --connect <host[:port]>    connect at startup (repeatable)
    --room <name>              room to auto-join after connecting (turns on discovery)
    --pass <pass>              password for the --room you auto-join
    --discovery                enable UDP LAN auto-discovery (on by default with --room)
    --no-discovery             disable UDP LAN auto-discovery
    --discovery-port <p>       discovery UDP port (default: 4041)
    --no-autoconnect           don't auto-dial peers learned via gossip/discovery
    --history                  persist history to disk (default: memory only)
-q, --quiet                    disable desktop notifications
    --notify-body              include message text in notifications (default: hidden)
    --color / --no-color       ANSI colors (default: on)
    --data-dir <path>          identity/config dir (default: ~/.config/lanchat-ng)
    --self-update              update from the latest GitHub release and exit
```

## Privacy posture — and a deliberate boundary

Built in: end-to-end encryption of all content and metadata, memory-only history,
no network broadcast unless you ask, notifications that hide the body by default,
and a one-press panic key (`Ctrl+X`, or `F2`/`Ctrl+O`) that clears the screen (and
scrollback) to hide the chat from someone glancing at your display.

**Not** built in: anything that disguises the process as a *different* program to
evade whoever administers the machine (e.g. masquerading as `nginx`/`postgres` in
the process table). That's detection evasion, and it's out of scope by design.
The features above give real privacy against anyone on the network — which is the
actual threat model for private internal comms.

## Data stored

Under `--data-dir` (default `~/.config/lanchat-ng`):
- `identity` — your Ed25519 secret seed (mode `0600`). **Back this up; it is you.**
- `trust.json` — fingerprints you've seen (trust-on-first-use).
- `history.jsonl` — only if you enable `--history` / `/history on`.

See [PROTOCOL.md](./PROTOCOL.md) for the wire protocol.

## Develop (from source)

```bash
git clone git+ssh://git@github.com/Vishnu-vashishth/lanchat-ng.git
cd lanchat-ng
npm install                 # install deps
npm run build               # compile to dist/  (or just use `npm start`, via tsx)
npm start -- --nick alice   # run from source without a global install
npm test                    # crypto handshake, framing, tamper-rejection, 2-node e2e
npm run typecheck
npm run verify              # typecheck + test + rebuild and confirm dist/ is committed
```

### Keeping the build current

This repo ships a prebuilt `dist/` so a global install needs no build step, so
`dist/` must always match `src/`. Two guards enforce that:

- **CI** (`.github/workflows/ci.yml`) runs typecheck, tests, and a build on
  Node 20 and 22 for every push and PR, and fails if committed `dist/` is stale.
- **Local pre-push hook** (`.githooks/pre-push`) runs the same checks before a
  push so nothing stale leaves your machine. Enable it once:

  ```bash
  git config core.hooksPath .githooks
  ```

