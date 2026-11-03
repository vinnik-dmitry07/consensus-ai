export class EvalInvariantError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = 'EvalInvariantError';
    this.detail = detail;
  }
}

export function isEvalInvariant(error) {
  return error?.name === 'EvalInvariantError';
}
