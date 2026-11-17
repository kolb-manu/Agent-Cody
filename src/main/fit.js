'use strict';
/*
 * Window-height math for "Resize to fit agents". Pure, so it can be unit tested.
 * The window keeps its top edge and grows downward; it never moves up.
 */

/** Smallest auto-fitted height: enough for the title bar and part of a row. */
const MIN_FIT_HEIGHT = 60;
/** Settings is long: while it's open the window is at least this tall (if the screen allows). */
const SETTINGS_HEIGHT = 420;

/**
 * Height that fits `content` px, capped at the bottom of the work area.
 * @param o.content   natural content height in px (from the renderer)
 * @param o.top       window's top edge (screen coordinates)
 * @param o.workArea  { y, height } of the display the window is on
 * @param o.min       smallest allowed height
 * @returns integer height, or null if `content` isn't a usable number
 */
function fitHeight({ content, top, workArea, min = MIN_FIT_HEIGHT }) {
  if (typeof content !== 'number' || !Number.isFinite(content) || content <= 0) return null;
  const room = workArea.y + workArea.height - top; // from the top edge down to the bottom of the screen
  const h = Math.min(Math.ceil(content), Math.floor(room));
  return Math.max(min, h); // a window hanging off the bottom still gets its minimum, without moving up
}

/** While Settings is open: grow to min(420, room left on screen) if shorter, otherwise keep the height. */
function settingsHeight({ height, top, workArea, target = SETTINGS_HEIGHT }) {
  const room = Math.floor(workArea.y + workArea.height - top);
  const want = Math.min(target, room);
  return height < want ? want : height;
}

module.exports = { fitHeight, settingsHeight, MIN_FIT_HEIGHT, SETTINGS_HEIGHT };
