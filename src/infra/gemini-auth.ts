/**
 * Shared Gemini authentication utilities.
 *
 * Supports both traditional API keys and OAuth JSON format.
 */

/**
 * Parse Gemini API key and return appropriate auth headers.
 *
 * OAuth format: `{"token": "...", "projectId": "..."}`
 */
export function parseGeminiAuth(apiKey: string): { headers: Record<string, string> } {
  if (apiKey.startsWith("{")) {
    try {
      const parsed = JSON.parse(apiKey) as { token?: string };
      if (typeof parsed.token === "string" && parsed.token) {
        return {
          headers: {
            Authorization: `Bearer ${parsed.token}`,
            "Content-Type": "application/json",
          },
        };
      }
    } catch {
      // Fall back to API-key mode.
    }
  }

  return {
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
  };
}
