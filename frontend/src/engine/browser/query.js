/**
 * Port of the request-shaping helpers in backend/main.py.
 * A follow-up is recomposed against the earlier final answer so a retry
 * cannot re-ask a bare fragment.
 */

const PRIOR_GONE = (
  'The earlier council answer this message follows up on is no longer '
  + 'available. Retry that message first.'
);

export function formatFilesForPrompt(files) {
  if (!files || !files.length) return '';
  return files.map((fileInfo) => {
    const name = fileInfo.name || 'file';
    const content = fileInfo.content || '';
    return `--- Attached file: ${name} ---\n${content}\n--- End of ${name} ---`;
  }).join('\n\n');
}

export function getEffectiveText(text, files = null) {
  const fileSection = formatFilesForPrompt(files || []);
  if (String(text || '').trim() && fileSection) return `${text}\n\n${fileSection}`;
  if (fileSection) return fileSection;
  return text;
}

export function composeFollowUpQuery(priorAnswer, followUp) {
  return `Previous council answer:\n\n${priorAnswer}\n\nUser message:\n\n${followUp}`;
}

export function buildUserMessage(text, images = null, files = null) {
  const effectiveText = getEffectiveText(text, files);
  if (!images || !images.length) return effectiveText;
  const content = [{ type: 'text', text: effectiveText }];
  for (const imageUrl of images) {
    content.push({ type: 'image_url', image_url: { url: imageUrl } });
  }
  return content;
}

export function usableFinalAnswer(stage3) {
  if (!stage3 || stage3.model === 'error') return null;
  const text = stage3.response;
  if (typeof text !== 'string') return null;
  const stripped = text.trim();
  if (!stripped || stripped.startsWith('Error:')) return null;
  if (stripped === 'All models failed to respond. Please try again.') return null;
  return text;
}

export function findLatestFollowUpTarget(conversation) {
  const messages = conversation?.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (usableFinalAnswer(message.stage3)) return index;
  }
  return null;
}

function priorFinalAnswer(conversation, messageIndex) {
  const messages = conversation?.messages || [];
  if (messageIndex < 0 || messageIndex >= messages.length) {
    throw new Error('Invalid follow-up message index');
  }
  const message = messages[messageIndex];
  if (message.role !== 'assistant') {
    throw new Error('Follow-up must target an assistant message');
  }
  const priorAnswer = usableFinalAnswer(message.stage3);
  if (!priorAnswer) throw new Error('No final council answer to follow up on');
  return priorAnswer;
}

export function prepareCouncilQuery(conversation, content, images, files) {
  let target = null;
  if (!(images && images.length)) {
    target = findLatestFollowUpTarget(conversation);
  }

  if (target != null) {
    const priorAnswer = priorFinalAnswer(conversation, target);
    const followUpText = getEffectiveText(content, files);
    const composed = composeFollowUpQuery(priorAnswer, followUpText);
    return { userMessage: composed, queryText: composed, followUpTo: target };
  }

  const userMessage = buildUserMessage(content, images, files);
  return {
    userMessage,
    queryText: getEffectiveText(content, files),
    followUpTo: null,
  };
}

export function rebuildCouncilQuery(conversation, userMsgIndex) {
  const messages = conversation?.messages || [];
  const userMessage = messages[userMsgIndex];
  const content = userMessage?.content || '';
  const images = userMessage?.images || [];
  const files = userMessage?.files || [];
  const followUpTo = userMessage?.follow_up_to;

  if (followUpTo == null) {
    return {
      userMessage: buildUserMessage(content, images, files),
      queryText: getEffectiveText(content, files),
    };
  }

  let priorAnswer = null;
  if (followUpTo >= 0 && followUpTo < messages.length) {
    priorAnswer = usableFinalAnswer(messages[followUpTo].stage3);
  }
  if (!priorAnswer) throw new Error(PRIOR_GONE);

  const composed = composeFollowUpQuery(priorAnswer, getEffectiveText(content, files));
  return { userMessage: composed, queryText: composed };
}
