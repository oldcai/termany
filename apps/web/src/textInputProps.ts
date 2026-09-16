/** Keep app text fields free of browser autofill and automatic text changes. */
export const textInputProps = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  writingsuggestions: "false",
} as const;

/** Apply the same policy to text fields created by editors and terminals. */
export function applyTextInputProps(element: HTMLElement): void {
  for (const [name, value] of Object.entries(textInputProps)) {
    element.setAttribute(name.toLowerCase(), String(value));
  }
}
