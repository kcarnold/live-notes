/**
 * Shared surface classes for the slide-review screen.
 *
 * The screen mounts inside a translucent `dark:bg-gray-900/70` panel, so any element that
 * relies on an inherited background reads as low-contrast mud in dark mode. Every token here
 * therefore states its own background, border, and text colour for both themes — keeping them
 * in one place is what stops the three components from drifting apart again.
 */

/** A bordered content block sitting on the page background (the reference-check panel). */
export const cardClass =
  'rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100';

/** A small inline tag: a language name, a percentage, a status word. */
export const chipClass =
  'inline-block px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 text-xs';

/** Text inputs and selects. */
export const inputClass =
  'rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 p-1 text-sm';

/** The one affirmative action on the screen. */
export const primaryButtonClass =
  'px-3 py-1 rounded text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-40';

/** Everything else: loading an item, re-running the agent. */
export const secondaryButtonClass =
  'px-3 py-1 rounded text-sm font-medium bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600 disabled:opacity-40';

/** De-emphasized helper text (labels, hints, empty states). */
export const subtleTextClass = 'text-xs text-gray-500 dark:text-gray-400';
