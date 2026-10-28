/**
 * An event description for display: no blank lines around it, and blank lines inside it (lines
 * empty or only spaces, any number in a row) dropped, so one line break separates the lines.
 * The calendar file keeps the text as it is.
 */
export function tidyDescription(text: string | undefined): string {
  return (text ?? '').trim().replace(/\r?\n(?:[ \t]*\r?\n)+/g, '\n');
}
