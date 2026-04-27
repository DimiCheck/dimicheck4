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
- Removed noisy stale-submit errors in Party by sending `roundId` with submissions and ignoring late/old round submissions; clarified color-game instructions and mobile hints.
- Fixed forbidden-color visibility: host now shows `금지: <색>` as the main prompt and mobile marks the forbidden color button with a small `금지` badge.
- Added more distinct Party inputs: slider games (`눈대중 슬라이더`, `볼륨 맞추기`) and ordering games (`줄 세우기`, `급식 순서`), plus engine-aware round selection to avoid repeating the same input style back-to-back.
- Added new Live Arcade `거북이 경주`: separate host/join pages, server-authoritative turtle sessions, batched mobile tap events, countdown/race/end states, finish-line progress, and final rankings.
- Party pacing/visibility pass: shortened wait/intro/result timings and minigame durations, added balloon visuals plus explicit submit for mash games, highlighted live top rankings, and made the final ranking screen much larger.
- Rebalanced Turtle Race from 0.6% to 1.2% progress per tap so finishing is realistic, and changed the mobile action label from `밀기` to `전진`.
- Party fairness pass: memory games now show the sequence briefly before hiding it and opening input, luck/risk outcomes are revealed on results instead of during choice, and target-style games schedule redundant early auto-submit attempts to avoid accidental `미제출`.
- Fixed Turtle Race stale-session handling: elapsed countdown/racing sessions are finalized before reuse, fresh host creation no longer inherits an already-expired race, and short remaining play windows reject start without flipping the lobby to ended.
- Turtle Race now uses `turtle-01.png` through `turtle-03.png` skins instead of emoji, randomly preselects a skin on mobile entry, and lets players change it until the race starts with server-synced host rendering.
- Turtle Race now runs longer/slower (`40s`, `0.7%` per tap), requires 2 connected racers to start, and supports player/saboteur roles. Saboteurs vote every 5 seconds to apply banana, swap-last, shrink-button, or fake-reset effects to racers.
