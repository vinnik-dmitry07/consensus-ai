/**
 * Engine switch. Browser mode is the default so a static deploy works with
 * no server. Local mode keeps the FastAPI backend for development.
 */

import { browserEngine } from './browser/engine.js';
import { getApiBase, remoteEngine, setApiBase } from './remote.js';

const MODE_KEY = 'llm-council-engine';

export function getEngineMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'local' ? 'local' : 'browser';
  } catch {
    return 'browser';
  }
}

export function setEngineMode(mode) {
  const next = mode === 'local' ? 'local' : 'browser';
  localStorage.setItem(MODE_KEY, next);
  return next;
}

export function engineLabel(mode = getEngineMode()) {
  return mode === 'local' ? 'Local backend' : 'In browser';
}

export function getEngine() {
  return getEngineMode() === 'local' ? remoteEngine : browserEngine;
}

export { getApiBase, setApiBase };
