# Copilot instructions for bitcoin-pages

## Project shape

- The consensus engine is in `src/dag.rs`; it buffers events with missing parents, tracks `seen_by`, caches depth, and derives canonical order by `(depth, event_id)`.
- `src/event.rs` defines the DAG ack event kind (`Kind::Custom(21000)`) plus helpers for building and reading parent `e` tags.
- `src/lib.rs` re-exports the public Rust API and gates the WASM bindings behind the `wasm` feature.
- Native binaries live under `src/bin/`:
  - `federation` and `bitcoin-pages-server` require `native`
  - `relay` requires `relay`
  - `keygen` is a native helper for demo setup
- The browser app lives in `demo/`; `site/` is generated Pages output. Shared browser modules and chrome live in `demo/shared/` and are copied into `site/shared/` by the site build.
- The local server serves the built `site/` tree and serves `.mjs` files as JavaScript so local preview matches GitHub Pages.

## Build, test, and site commands

- `just build` or `make build` — build the native Rust library/binaries with `--features native`
- `just test` or `make test` — run native Rust tests and JS tests
- `just test-native` or `make test-native` — `cargo test --features native`
- `just test-js` or `make test-js` — `node --test test/*.test.mjs`
- Single Rust test: `cargo test --features native <test_name>`
- Single JS test file: `node --test test/page-header.test.mjs`
- `just wasm` or `make wasm` — build the WASM package into `site/pkg`
- `just site` or `make site` — build WASM and copy the demo/site assets into `site/`
- `just server` or `make server` — build the server and serve `site/` locally
- `just demo` — start the relay plus federation demo launcher

## Key conventions

- Treat `demo/` as the source of truth for browser UI changes; regenerate `site/` with the site build instead of hand-editing generated output.
- Keep shared header/footer/chrome changes in the shared modules (`demo/shared/page-header.mjs`, `demo/shared/logger-footer.js`) so demo and Pages stay aligned.
- Use `resolveHref()` for Pages-safe relative links and asset URLs.
- Keep shared assets in `demo/shared/`; the site build copies them to `site/shared/` and also copies the favicon for root and subpath usage.
- JS tests use Node’s built-in test runner and typically load modules directly from `demo/shared/`.
- Rust tests are colocated with the implementation modules and follow the existing feature-gated native/WASM split.
