// Each choice owns its requests. A late result can only update its own choice.
export function createLoadSession() {
  let controller = new AbortController();
  return {
    get signal() { return controller.signal; },
    start() { controller.abort(); controller = new AbortController(); return controller.signal; },
    cancel() { controller.abort(); },
    current(signal) { return signal === controller.signal && !signal.aborted; },
  };
}

export function requestSignal(signal, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  if (!signal) return timeout;
  if (AbortSignal.any) return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  for (const part of [signal, timeout]) {
    if (part.aborted) controller.abort(part.reason);
    else part.addEventListener('abort', () => controller.abort(part.reason), { once: true, signal: controller.signal });
  }
  return controller.signal;
}
