export function ruleSetNames(value: string): string[] {
  return value.startsWith('rule-set:')
    ? value
        .slice('rule-set:'.length)
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    : [];
}
