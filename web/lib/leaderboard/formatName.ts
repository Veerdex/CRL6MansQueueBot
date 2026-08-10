// Some players stack decorative suffixes onto their Discord display name (e.g. "aWannaBe-_-NERD"),
// which blows out table/card layouts. Rather than a generic character-count truncation, cut at the
// first "-" — the decorative part almost always starts there — and mark it with "...". Names with
// no "-" are left untouched.
export function formatDisplayName(name: string): string {
  const dashIndex = name.indexOf("-");
  if (dashIndex === -1) return name;
  return `${name.slice(0, dashIndex)}...`;
}
