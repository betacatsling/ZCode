// Length caps for Claude event text, measured in UTF-16 code units like the event schema's max().

/** agentEventSchema session.error `message` max(1024). */
export const SESSION_ERROR_MESSAGE_MAX = 1024;

/**
 * `text` cut to at most `maxUnits` UTF-16 code units without splitting a surrogate pair: a pair
 * that would straddle the cap is dropped whole. Text within the cap is returned unchanged.
 */
export function truncateCodePointSafe(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = Math.max(0, Math.floor(maxUnits));
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end)))
    end -= 1;
  return text.slice(0, end);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
