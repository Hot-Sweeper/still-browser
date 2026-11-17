# Still on Firefox: design notes

Still is a calm browser: the page fills the window, and five glass slots plus
the window controls slide in from the top edge when the pointer reaches it.

## Surfaces and colour
- Slots and controls are solid tints (`--still-pill`, `--still-pill-hover`,
  `--still-pill-strong`). There are no blurs, because Firefox cannot blur
  another process's page.
- One edge treatment per theme, never a hairline plus a diffuse shadow:
  light slots float on a small shadow (`--still-slot-shadow`), dark and OLED
  slots get one quiet hairline (`--still-slot-edge`, 7.5% / 10% white) and no
  shadow, since the bar's scrim already separates them. No inner highlight
  lines, corner shines or glows.
- The current slot is the brighter fill (`--still-pill-active`), with a
  brighter hairline in the dark themes (`--still-slot-active-edge`) and its
  title at full strength. The light that used to travel behind the slots is
  gone: it read as a smudge behind the current title.
- A slot's fill and edge live on `.slot-surface`, the only part that wobbles
  (hover, press, the landing squish), lifts and leans. Icons and titles never
  scale, so they stay sharp; a dragged slot moves in device-pixel steps.
- Themes: system, light, dark and OLED. OLED sets the surfaces to pure black.
  Text uses `--still-text` and `--still-muted`. Empty slots are a dashed
  outline with their label at 74% text colour.

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

## Rearranging slots
- A slot is picked up after 5 px of movement. Its surface lifts (scale
  1.035, opaque `--still-slot-lifted` fill, a deeper shadow or a brighter
  hairline in the dark themes) and leans up to 2° with its speed while the
  title stays level. It follows the pointer one to one, moves a little
  vertically under resistance, and rubber-bands past the first or last
  place.
- The other slots make room on springs (`ROOM_SPRING`, ω 30, ζ .86) as soon
  as the dragged slot crosses half a slot. Letting go drops it from where it
  is with its release speed (`DROP_SPRING`, ω 24, ζ .8); the lift settles on
  `--still-ease-spring`. Springs retarget from their current state, so
  nothing restarts. Motion uses `translate` and `rotate`, never `transform`
  (the bar's entrance owns that).
- Escape puts the slot back. Ctrl+Shift+Left/Right moves the focused slot
  on the same springs, and a screen reader hears where it went.
- Drops onto the row: a link, text or file from a page shows "Open here" on
  a page slot and "Open in a new slot" on an empty one, inside the slot.
  An agent tab dragged from the agent panel makes the slots part around a
  dashed placeholder; with all five in use the slot under it turns red and
  says "Replace", and the toast offers Undo.

## Agents
- The agent has its own colour, `--still-agent-rgb` (green, lighter in dark
  mode), used for its pointer, rings and lights.
- The agent mark (a four-point star) appears only while an agent is
  connected. It breathes at rest and turns while the agent works. When the
  agent stops, it eases on to the next resting angle. The agent's hidden
  tabs sit beside the mark as overlapping 16 px icons (three, then a count);
  the one it works in is ringed.
- On the page in front of you the agent has a pointer: an arrow in the
  agent colour with a white rim, gliding on a spring (ω 21, ζ .9) to the
  element it is about to use. A label beside it says the step and the
  element ("Clicking “Sign in”"), a ring outlines the element, and a click
  spreads a ring from the tip. The agent waits 220 ms (`AIM_MS`) so the
  pointer arrives first. It fades 2.6 s after the last step and leaves when
  you switch slots.
- Steps without an element ("Reading the page") are told in a line at the
  bottom left, with a turning star.
- A slot behind the current one that the agent works in is outlined, and a
  small light pulses on its icon (it dims to 45%, never off).
- The agent panel reuses the utility panel's surface: a live status line
  with a light, the agent tabs (drag them into the slots, or click to show
  one), and the recent steps with where each happened and when. Repeats of
  one step on one page update a single entry; new steps slide in on top.
- A 2 px light runs along the top edge while the agent acts on the visible
  page. It loops by exactly one tile, so it never jumps.
- Reduced motion keeps the colour changes and drops movement.

## YouTube creator navigation
- My channel sits in the top right of Still's custom YouTube views and watch
  pages. It mirrors the Home corner's inward reveal: 160 ms opacity, 190 ms
  transform, mirrored 10 px horizontal and 7 px vertical offset, scale .78.
  Keyboard focus reveals it too; touch keeps it visible; reduced motion
  removes movement. A dark backing keeps the glyph readable over video.
- It opens YouTube's own active account menu and follows its channel endpoint.
  Account identity is never stored, so switching Brand Accounts stays native.
- Channel owners see the Studio destination supplied by YouTube's header
  instead of Subscribe. Other channels keep their subscription control.
- Channel tabs preserve YouTube's supplied labels and destinations, including
  Posts and Playlists. Posts/Community and other native sections never receive
  Still's video-grid overlay, keeping YouTube's real editor and controls usable.
