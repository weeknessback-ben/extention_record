import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Node's fetch gives up when a server sends no response headers for 5 minutes (undici's headersTimeout).
 * Speech-to-text on a CPU can take longer than that for one 5-minute segment, so allow `ms` instead;
 * lib/ai.ts still aborts each request after its own timeout.
 */
export function allowSlowResponses(ms = 20 * 60_000): void {
  setGlobalDispatcher(new Agent({ headersTimeout: ms, bodyTimeout: ms }));
}
