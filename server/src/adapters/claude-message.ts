/** Claude 注入的伴随说明不属于用户输入；stdout 有时不保留 transcript 的 meta 标记。 */
const META_TEXT_PREFIXES = [
  "<command-name>", "<local-command-stdout>", "<local-command-caveat>",
  "<task-notification>", "<bash-input>", "<bash-stdout>",
];

const IMAGE_DIMENSIONS_NOTE = /^\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.\]$/;

export function isClaudeMetaText(text: string): boolean {
  const trimmed = text.trim();
  return META_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) || IMAGE_DIMENSIONS_NOTE.test(trimmed);
}
