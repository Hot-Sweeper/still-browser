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
- The current slot is lit (the soul): a brighter fill (`--still-soul-fill`),
  a brighter hairline in the dark themes (`--still-soul-edge`), its title at
  full strength (`--still-title-lit`) and its close button showing. Other
  slots sit a step lower (`--still-slot-fill`, `--still-title-rest`).
- Switching moves the soul (`--soul-p`, a slot position) on the page strip's
  own spring, so the light hands over from slot to slot in step with the
  sliding pages. Each slot is lit as a whole by how near the soul is (an
  S-curve reaching 0 at 0.83 slots), never cut in half; a jump across slots
  briefly lights the ones in between. No glow, stretch or shape of its own,
  and at rest it is simply the current slot, so nothing fades out at the end.
- No wobble: slots do not squish on hover, press or landing. Hover only
  brightens the fill, hairline and title. Icons and titles never scale; a
  dragged slot moves in device-pixel steps.
- Themes: system, light, dark and OLED. OLED sets the surfaces to pure black.
  Text uses `--still-text` and `--still-muted`.
- Empty slots are open places, not slots: no fill of their own (5% white),
  a dashed 38% white outline, a plus icon and "Slot N" at 80% white, the same
  in every theme because the open bar always sits on its dark scrim. Hover
  fills them to 11% and turns the plus a quarter.

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
  1.035 over 240 ms, opaque `--still-slot-lifted` fill, a deeper shadow or a
  brighter hairline in the dark themes) without leaning. It follows the pointer one to one, moves a little
  vertically under resistance, and rubber-bands past the first or last
  place.
- The other slots make room on critically damped springs (`ROOM_SPRING`,
  ω 30, ζ 1) as soon as the dragged slot crosses half a slot. Letting go
  drops it from where it is with its release speed (`DROP_SPRING`, ω 24,
  ζ 1). Nothing bounces. Springs retarget from their current state, so
  nothing restarts. Motion uses `translate`, never `transform` (the bar's
  entrance owns that).
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
- Live view: when the agent works in a tab you are not looking at (its
  hidden tabs, or a slot behind the current one), a 340 px card at the bottom
  right shows that page at its own proportions, refreshed at most every
  350 ms and once more 750 ms after the last step, only while the agent
  works. The agent's pointer and ring are drawn on it where it acts, the step
  is written under it, and "Show" brings the tab into a slot. It leaves 6 s
  after the agent stops unless you point at it. Its close button turns it
  off (`still.agent.liveView`); a switch in the agent panel turns it on.
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

## Side chat
- A panel on the right of the page (`#still-chat`, last in Firefox's
  `#browser` row), default 400 px, 320 px to 60% of the window, resized from
  its left edge (an agent-green line shows on hover). It slides in over the
  page (300 ms, drawer curve) and then takes its place beside it, so the page
  reflows once; it leaves on a 220 ms ease-in. Reduced motion skips the slide.
- Surface `--still-pill-strong` with one hairline on its left (11% text
  colour). Header: agent name (semibold) with a menu, the agent's model and
  reasoning choices as quiet menus, then new chat and close.
- Your messages are bubbles on the right (10% text colour, 14/14/5/14 px
  corners) with the page they were about under them. Replies are plain text
  with light Markdown. Tool steps are one muted line each with a spinner,
  an agent-green check or a red cross. Permission questions are a card with
  an agent-green outline; the first choice is filled agent green.
- While the agent works, three agent-green dots rise in turn under the reply
  ("Working"), and the send button turns into a green stop button.
- The page chip above the field shows the page the agent is told about;
  struck through when left out.
