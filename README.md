# lanchat-ng

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

Requires **Node.js ≥ 20**. Installing compiles the CLI for you — there is **no
separate build step**.

```bash
# over HTTPS (you'll be asked for GitHub creds since the repo is private)
npm install -g git+https://github.com/Vishnu-vashishth/lanchat-ng.git

# ...or over SSH if you have a GitHub SSH key
npm install -g git+ssh://git@github.com/Vishnu-vashishth/lanchat-ng.git
```

That gives you a `lanchat-ng` command (and a shorter `lanchat` alias).

Prefer not to install? Run it one-off with npx:

```bash
npx git+https://github.com/Vishnu-vashishth/lanchat-ng.git --nick alice
```

Update to the latest: re-run the same `npm install -g …` line.
Uninstall: `npm uninstall -g lanchat-ng`.

## Run

```bash
lanchat-ng --nick alice
```

Two people on the same LAN:

```bash
# on alice's machine
lanchat-ng --nick alice --port 4040

# on bob's machine — connect to alice once; the mesh gossips the rest
lanchat-ng --nick bob --connect 192.168.1.23:4040
```

Or let them find each other automatically (opt-in, broadcasts on the LAN):

```bash
lanchat-ng --nick alice --discovery
lanchat-ng --nick bob   --discovery
```

**On first contact, compare fingerprints** out-of-band (read them aloud / over
another channel). After that the key is pinned and impersonation is rejected.

## Commands

```
/help                  show help
/nick <name>           change nickname
/join <room>           join and switch to a room
/leave <room>          leave a room
/rooms                 rooms you are in
/peers  /names         connected peers
/connect <host[:port]> connect to a peer directly
/fp  /me               show your fingerprint
/history on|off        toggle on-disk history (default: off, memory only)
/burn                  wipe history (memory + disk) and clear the screen
/hide  /panic          hide the screen  (also Ctrl+O — press again to resume)
/quit                  exit
```

## Options

```
-n, --nick <name>              nickname (default: your username)
-p, --port <port>              TCP listen port (default: 4040)
-c, --connect <host[:port]>    connect at startup (repeatable)
    --discovery                enable UDP LAN auto-discovery (default: off)
    --discovery-port <p>       discovery UDP port (default: 4041)
    --no-autoconnect           don't auto-dial peers learned via gossip/discovery
    --history                  persist history to disk (default: memory only)
-q, --quiet                    disable desktop notifications
    --notify-body              include message text in notifications (default: hidden)
    --data-dir <path>          identity/config dir (default: ~/.config/lanchat-ng)
```

## Privacy posture — and a deliberate boundary

Built in: end-to-end encryption of all content and metadata, memory-only history,
no network broadcast unless you ask, notifications that hide the body by default,
and a `Ctrl+O` panic key that clears the screen (and scrollback) to hide the chat
from someone glancing at your display.

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
npm install                 # installs deps and builds dist/ (via "prepare")
npm start -- --nick alice   # run from source without a global install
npm test                    # crypto handshake, framing, tamper-rejection, 2-node e2e
npm run typecheck
```
