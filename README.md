# bitcoin-pages

DAG-based optimistic consensus for Nostr federations.

**BTC++ Taipei 2025 Hackathon Entry** - Built during a vibe coding session with Claude.

## What is this?

A proof-of-concept showing how a federation of Nostr keypairs can achieve consensus on message ordering using a DAG (Directed Acyclic Graph) structure. Messages become "canonical" once a majority of federation members have acknowledged them.

## How it works

1. Users send chat messages (NIP-28 Kind 42) to a relay
2. Federation daemons subscribe to these messages
3. Each daemon publishes acknowledgment events (Kind 21000) referencing the messages
4. Messages transition from "pending" to "canonical" once >50% of federation members have acked
5. The frontend shows this transition in real-time

## Running the demo

```bash
# Build, test, or generate the Pages site
just build
just test
just test-all
just site
just server

# Or use Make
make build
make test
make test-all
make site
make server

# Start relay + 5 federation daemons
just demo

# Open in browser
firefox demo/index.html
```

Click "Connect", then send messages. Watch them go from pending (gray) to canonical (green) as acks arrive.

## Git viewer detail view

The Git viewer now supports a repo detail view on the same static page:

- `/git/` shows the repository grid
- `/git/?repo=bitcoin-pages&branch=master&tag=...` opens a single repo detail panel
- the detail panel loads branches, tags, recent commits, and tracked files from the local clone

This stays on the static `/git/` route so it works with the local file server and Safari without requiring deep-link rewrites.

The demo and Git viewer now share the same header/navigation chrome, and the shared logger footer still surfaces `isomorphic-git` clone/fetch progress at trace level. `test/git-progress.test.mjs` locks the progress text and dedupe behavior in place.
The shared browser helpers are copied into `site/shared/`, and the local server serves `.mjs` modules as JavaScript so Pages and preview stay aligned.

## Project structure

- `src/dag.rs` - Core DAG with pending event buffering
- `src/bin/federation.rs` - Runs one federation daemon that watches the relay and publishes acks
- `src/bin/relay.rs` - Starts the local Nostr relay for the demo
- `src/bin/keygen.rs` - Prints demo federation keys and startup commands
- `src/bin/bitcoin-pages-server.rs` - Serves the built site locally from `site/`
- `demo/index.html` - Browser frontend
- `demo/run.sh` - Demo launcher script

## Dependencies

Requires the [rust-nostr](https://github.com/rust-nostr/nostr) SDK as a sibling directory at `../nostr`.
