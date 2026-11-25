// A saved API key belongs to the endpoint it was entered for. Reusing it after the
// user switches hosts would send one provider's secret to another provider.
// The origin (scheme + host + port) is the security boundary; paths may change.

export function apiOrigin(apiUrl) {
  try {
    const parsed = new URL(String(apiUrl ?? '').trim());
    // Non-hierarchical URLs have the opaque origin "null".
    return parsed.origin === 'null' ? '' : parsed.origin;
  } catch {
    return '';
  }
}

export function sameApiOrigin(left, right) {
  const origin = apiOrigin(left);
  return !!origin && origin === apiOrigin(right);
}

// Returns the key that may be sent to the newly selected endpoint.
// A typed key always wins; a stored key is reused only for the same origin.
export function resolveApiKey({storedKey = '', typedKey = '', storedUrl = '', nextUrl = ''}) {
  const typed = String(typedKey ?? '').trim();
  if (typed) return typed;
  const stored = String(storedKey ?? '').trim();
  return stored && sameApiOrigin(storedUrl, nextUrl) ? stored : '';
}
