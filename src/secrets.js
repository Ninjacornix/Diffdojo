'use strict';
// Secret scan applied to every excerpt before it is stored or sent to a model.
// Any match drops the excerpt entirely.

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\baws_secret_access_key\b\s*[:=]/i,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
  /\bsk-[A-Za-z0-9]{32,}\b/, // OpenAI-style
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/, // Google OAuth
  /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/, // Stripe
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  /:\/\/[^\s:@/]+:[^\s:@/]{6,}@/, // credentials in URLs
];

function hasSecret(text) {
  if (!text) return false;
  return PATTERNS.some((re) => re.test(text));
}

module.exports = { hasSecret, PATTERNS };
