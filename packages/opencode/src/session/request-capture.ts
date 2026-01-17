/**
 * Module for capturing and storing the last HTTP request sent to LLM backends.
 * This allows users to reproduce server-side errors by running the captured
 * request as a curl command.
 */

interface CapturedRequest {
  sessionID: string
  timestamp: number
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

// In-memory storage of last request per session
const requests = new Map<string, CapturedRequest>()

/**
 * Escape a string for use in a single-quoted shell string.
 * Single quotes in the content are escaped by ending the quote, adding an escaped quote, and resuming.
 */
function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''")
}

/**
 * Capture an HTTP request for a session.
 */
function capture(request: CapturedRequest): void {
  requests.set(request.sessionID, request)
}

/**
 * Get the last captured request for a session.
 */
function get(sessionID: string): CapturedRequest | undefined {
  return requests.get(sessionID)
}

/**
 * Clear the captured request for a session.
 */
function clear(sessionID: string): void {
  requests.delete(sessionID)
}

interface ToCurlOptions {
  /** Include auth tokens in the output. Default: true */
  includeAuth?: boolean
}

/**
 * Convert a captured request to a curl command string.
 */
function toCurl(request: CapturedRequest, options: ToCurlOptions = {}): string {
  const { includeAuth = true } = options

  const parts: string[] = ["curl"]

  // Add method
  parts.push(`-X ${request.method}`)

  // Add URL (escaped for shell)
  parts.push(`'${shellEscape(request.url)}'`)

  // Add headers
  for (const [key, value] of Object.entries(request.headers)) {
    // Skip auth headers if not including auth
    if (!includeAuth) {
      const lowerKey = key.toLowerCase()
      if (lowerKey === "authorization" || lowerKey === "x-api-key") {
        continue
      }
    }

    // Skip internal headers that shouldn't be in curl
    const lowerKey = key.toLowerCase()
    if (lowerKey === "content-length") {
      continue
    }

    parts.push(`-H '${shellEscape(key)}: ${shellEscape(value)}'`)
  }

  // Add body if present
  if (request.body) {
    parts.push(`-d '${shellEscape(request.body)}'`)
  }

  // Join with line continuations for readability
  return parts.join(" \\\n  ")
}

export const RequestCapture = {
  capture,
  get,
  clear,
  toCurl,
}
