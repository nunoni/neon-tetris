# TETRIS FOR HIND

A over-the-top pastel-neon Tetris dedicated to Hind — rendered in real 3D with WebGL
(Three.js), post-processing bloom, particles, synthesized music and sound.
Everything runs locally, no server needed.

## Run it

Just open `index.html` in any modern browser (Chrome, Edge, Firefox, Safari).
No build step, no dependencies to install — all libraries are bundled in `js/lib/`.

For the best experience serve it locally (optional):

```bash
cd Tetris
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Controls

| Action       | Keys            |
|--------------|-----------------|
| Move         | Arrow Left / Right (hold to auto-repeat) |
| Rotate CW    | Arrow Up / X    |
| Rotate CCW   | Z / Ctrl        |
| Soft drop    | Arrow Down      |
| Hard drop    | Space           |
| Hold         | C / Shift       |
| Pause        | P / Esc         |
| Mute         | M               |
| Restart      | R               |
| Start        | Enter (or tap)  |

Touch devices get on-screen buttons automatically.

## Features

- Full guideline rules: SRS rotation with wall kicks, 7-bag randomizer, hold,
  ghost piece, 5-piece preview, lock delay with move resets, DAS/ARR input
- Scoring: singles/doubles/triples/Tetris, T-spins (mini + full), combos,
  back-to-back multiplier, perfect clears, soft/hard drop points
- Level curve from the official gravity table
- Visual FX: UnrealBloom neon glow, RGB-shift + scanlines + vignette + film grain
  final pass, line-clear explosions with physical debris, shockwave rings,
  hard-drop streaks, camera shake / punch / FOV kick, slow-motion on Tetris,
  beat-reactive floor grid, starfield, procedural nebula, danger red-alert mode
- Fully synthesized WebAudio soundtrack (Korobeiniki with echo, bass, drums)
  and SFX — no audio files
- High score persisted in localStorage
- Responsive camera; attract-mode background on the menu

## Dev / test hooks

- `index.html?autostart=1` — skip the menu, straight into the countdown
- `?autoplay=1` — the game plays random moves (smoke testing)
- `?democlear=1` / `?demodeath=1` — force a line clear / game over
- `node tests/test-game.js` — runs the 34 logic unit tests (Node only, no browser)
