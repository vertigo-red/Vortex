# Vortex Linux — Compatibility matrix

Levels:

- `static` — source review only.
- `fixture` — exercised with synthetic data/fixtures in CI tests.
- `packaged` — verified on a packed Linux artifact (smoke / import / install /
  deploy / purge).
- `manual-game` — run against a real installed game (on the user's machine).

| Game / store / runner / package | Level | Notes |
|---|---|---|
| Vortex app boot (main + renderer) | packaged | run 34220720010 Boot smoke: main process + renderer page up under Xvfb; screenshot captured via DevTools |
| zip / rpm / deb / AppImage artifacts | packaged | run 34220720010 built all four; sha256sums recorded in SHA256SUMS |
| LOOT | — | N-03: no Linux build path; module absent, sorting unavailable |
| — other games/stores/runners not yet exercised — | | real-game integration pending (see TESTING.md / LINUX-TESTING-RU.md) |

Fill this in as evidence accumulates; never mark an untested case as verified.