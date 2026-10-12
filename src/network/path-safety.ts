export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

export function hasUnsafePathCharacters(value: string): boolean {
  return value.includes('/') || value.includes('\\') || hasControlCharacters(value)
}
