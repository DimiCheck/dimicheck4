Original prompt: 구현 시작

## Notes
- Building DimiCheck Party as a new Arcade mode alongside Turf.
- Keep server authoritative for session creation/start/end; board menu visibility remains local time based.
- Use round-based participation so late joiners wait for the next round.

## TODO
- Added Party manager/routes/socket events in `arcade_routes.py`.
- Added Party host/join templates and JS.
- Added tests for session creation, joining, submissions, round result, and late join behavior.
- Party rounds now auto-continue after result screens until max rounds or safe time end.
- Start API now broadcasts countdown state immediately so phones do not wait until the first transition.
- Improved Party polish: live reaction cues, total/average ranking groups, mobile live button text, render_game_to_text hooks, broader engine scoring tests.
- Added fake-signal prompt support for the 거짓 신호 minigame.
- Playwright visual client could not run because the local environment does not have the `playwright` package installed; avoided adding a new dependency and used route/JS/test verification instead.
- Fixed Party debug entry: `ARCADE_DEBUG_ALLOW_ANY_TIME=1` now marks host pages so initial session creation bypasses time limits, and Party exposes `ArcadeDebug` as an alias of `PartyDebug` for console testing.
- Made debug-disabled 400 responses explicit and changed `allowAnyTime()` console helpers to return an object with the actual server error instead of a misleading immediate success string.
- Party game-design pass after Mario Party reference review: added mash/target/risk engines, colored color-game chips/buttons, hid precise timing-game seconds on phones, and added score tests for the new engines.
