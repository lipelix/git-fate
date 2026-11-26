import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { excerptForLine, parseHunks } from '../../git/diffParser';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,6 +1,7 @@',
  ' one',
  ' two',
  '-three',
  '+THREE',
  '+three and a half',
  ' four',
  ' five',
  ' six',
  '@@ -20 +21,2 @@ function tail() {',
  '-old tail',
  '+new tail',
  '+more tail',
  '\\ No newline at end of file',
].join('\n');

describe('parseHunks', () => {
  it('reads ranges and keeps prefixed lines', () => {
    const hunks = parseHunks(DIFF);
    assert.equal(hunks.length, 2);
    assert.deepEqual(
      { ...hunks[0], lines: hunks[0].lines.length },
      { oldStart: 1, oldLines: 6, newStart: 1, newLines: 7, lines: 8 },
    );
    assert.deepEqual(
      { ...hunks[1], lines: undefined },
      { oldStart: 20, oldLines: 1, newStart: 21, newLines: 2, lines: undefined },
    );
    assert.deepEqual(hunks[1].lines, ['-old tail', '+new tail', '+more tail']);
  });

  it('returns nothing for an empty diff', () => {
    assert.deepEqual(parseHunks(''), []);
  });
});

describe('excerptForLine', () => {
  const hunks = parseHunks(DIFF);

  it('shows the changed block around the line with two lines of context', () => {
    assert.deepEqual(excerptForLine(hunks, 4), {
      lines: [' one', ' two', '-three', '+THREE', '+three and a half', ' four', ' five'],
      truncated: false,
    });
  });

  it('finds lines in later hunks by their new line number', () => {
    assert.deepEqual(excerptForLine(hunks, 22)?.lines, ['-old tail', '+new tail', '+more tail']);
  });

  it('shows the surroundings when the line is only context', () => {
    assert.deepEqual(excerptForLine(hunks, 6)?.lines, [
      '+three and a half',
      ' four',
      ' five',
      ' six',
    ]);
  });

  it('returns undefined for a line outside every hunk', () => {
    assert.equal(excerptForLine(hunks, 12), undefined);
  });

  it('keeps long changes short around the line and long lines narrow', () => {
    const added = Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`);
    const long = parseHunks(['@@ -0,0 +1,40 @@', ...added].join('\n'));
    const excerpt = excerptForLine(long, 30, { maxLines: 6 })!;
    assert.equal(excerpt.truncated, true);
    assert.deepEqual(excerpt.lines, [
      '+line 27',
      '+line 28',
      '+line 29',
      '+line 30',
      '+line 31',
      '+line 32',
    ]);
    const wide = parseHunks(`@@ -1 +1 @@\n-x\n+${'y'.repeat(200)}`);
    assert.equal(excerptForLine(wide, 1, { maxWidth: 10 })!.lines[1], '+yyyyyyyy…');
  });
});
