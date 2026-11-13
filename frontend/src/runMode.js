/**
 * Which pipeline produced an assistant message. A Self-MoA (S8) message
 * records its mode in metadata, in its run roster, or in its final answer.
 */
export function isSelfMoaMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return message.metadata?.mode === 'self_moa'
    || message.run_roster?.mode === 'self_moa'
    || message.stage3?.mode === 'self_moa';
}
