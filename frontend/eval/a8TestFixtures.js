// Fixtures shared by the a8 replay and tail tests: a three-model council with
// the same B and chairman, flat prices, and a fake Stage 2 judge.

export const COUNCIL = ['alpha/one', 'beta/two', 'gamma/three'];
export const FROZEN = { councilModels: COUNCIL, chairmanModel: COUNCIL[0], bModel: COUNCIL[0] };
export const PRICES = Object.fromEntries(COUNCIL.map((id) => [id, { prompt: '0.000001', completion: '0.000001' }]));

// A judge reply in the Stage 2 format that ranks the responses in label order.
export function stage2Answer(prompt) {
  const head = prompt.split('Your task:')[0];
  const labels = [...new Set([...head.matchAll(/Response (\d+)/g)].map((match) => `Response ${match[1]}`))];
  const reviews = labels.map((label, index) => `${label}:\nReviewed.\nCorrectness: ${9 - index}/10\nIssues: none`);
  const ranking = labels.map((label, index) => `${index + 1}. ${label}`).join('\n');
  return `${reviews.join('\n\n')}\n\nDISPUTED CLAIMS:\nnone\n\nFINAL RANKING:\n${ranking}`;
}
