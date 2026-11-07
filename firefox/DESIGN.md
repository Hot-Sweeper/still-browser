# Still on Firefox: design notes

Still is a calm browser: the page fills the window, and five glass slots plus
the window controls slide in from the top edge when the pointer reaches it.

## Surfaces and colour
- Slots and controls are solid tints (`--still-pill`, `--still-pill-hover`,
  `--still-pill-strong`), with a thin light line (`--still-line`) and a soft
  shadow. There are no blurs, because Firefox cannot blur another process's
  page.
- Themes: system, light, dark and OLED. OLED sets the surfaces to pure black
  and keeps an outline. Text uses `--still-text` and `--still-muted`.
- The current slot carries a soft aura (`--still-aura-rgb`).

## Motion tokens
- `--still-ease`: `cubic-bezier(.16, 1, .3, 1)`, for the bar's entrance and
  for slots sliding.
- `--still-ease-out`: `cubic-bezier(0, 0, .58, 1)`, for things entering and
  for hover fades.
- `--still-ease-out-strong`: `cubic-bezier(.23, 1, .32, 1)`, for presses
  settling and small glyph motions.
- `--still-ease-overshoot`: `cubic-bezier(.34, 1.56, .64, 1)`, for small
  confirmations only.
- `--still-ease-in-out`: `cubic-bezier(.77, 0, .175, 1)`, for the agent
  mark's breathing.
- Hover takes 130 ms. Press takes 70 ms in and springs back over 220 ms.
  Bar entrance: 430 ms, staggered.

## Window controls
- The top band and the open bar's empty space are a title bar: drag moves the
  window, and double-click follows the system setting.
- The square button maximizes and restores, and morphs into two squares when
  the window fills the screen.
- Hover lifts the surface toward the text colour (13% light, 9% dark and
  OLED) and brightens the rim. Press scales to 0.93 using `scale`, which stays
  separate from the entrance transform.
- Each glyph has its own hover motion: minimize nudges down, close turns 90°,
  and maximize grows.

## Agents
- The agent mark (a four-point star) appears only while an agent is
  connected. It breathes at rest and turns while the agent works. When the
  agent stops, it eases on to the next resting angle.
- The agent panel reuses the utility panel's surface.
- A 2 px light runs along the top edge while the agent acts on the visible
  page. It loops by exactly one tile, so it never jumps.
- Reduced motion keeps the colour changes and drops movement.
