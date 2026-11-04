/**
 * The message of a commit that absorbs another squashed commit in Edit
 * history. What git would propose is the head's own message followed by every
 * squashed one, built from the commits each time: rebuilt from the message
 * prefilled before, which already held the earlier squashes, they came out
 * twice ("A, B, B, C"). A message the user typed in keeps what they wrote, and
 * the newly squashed commit's message is added below it.
 */
export function messageAfterSquash(head: { message?: string; edited?: boolean }, own: string, squashed: string[], added: string): string {
  if (head.edited && head.message !== undefined) return `${head.message}\n\n${added}`
  return [own, ...squashed].join('\n\n')
}
