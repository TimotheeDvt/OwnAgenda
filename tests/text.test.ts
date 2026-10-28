import { describe, expect, it } from 'vitest';
import { tidyDescription } from '../src/util/text';

describe('tidyDescription', () => {
  it('trims blank lines around the text', () => {
    expect(tidyDescription('\n\n  Agenda\n\n')).toBe('Agenda');
  });

  it('collapses successive line breaks into one', () => {
    expect(tidyDescription('One\n\n\nTwo\r\n\r\nThree\n  \n\t\nFour')).toBe(
      'One\nTwo\nThree\nFour',
    );
  });

  it('keeps single line breaks and indentation', () => {
    expect(tidyDescription('One\n  Two')).toBe('One\n  Two');
  });

  it('returns "" for missing or blank text', () => {
    expect(tidyDescription(undefined)).toBe('');
    expect(tidyDescription(' \n \n ')).toBe('');
  });
});
