export function printShortcutDisposition(input: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}) {
  const block = (input.ctrlKey || input.metaKey) && input.key.toLowerCase() === "p";
  return { block, notify: block && !input.repeat };
}
