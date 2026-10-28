export function recoveryNotes (changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex(line => line.match(/^#{1,2} \[?([^\] (]+)/)?.[1] === version);
  if (start < 0) throw new Error(`Missing changelog for ${version}`);
  const next = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  const notes = lines.slice(start, next < 0 ? undefined : next).join('\n').trim();
  if (lines.slice(start + 1, next < 0 ? undefined : next).join('').trim() === '') throw new Error('Empty release notes');
  return notes;
}
