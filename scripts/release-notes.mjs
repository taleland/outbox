export function releaseNotes (changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex(line => line.trim() === `## ${version}`);
  if (start < 0) throw new Error(`Missing changelog for ${version}`);
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const notes = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
  if (!notes) throw new Error(`Empty changelog for ${version}`);
  return notes;
}
