/**
 * Cliente LLM opcional (SDK oficial da Anthropic).
 * Sem ANTHROPIC_API_KEY no ambiente, retorna null e o sistema usa só o fallback determinístico.
 */
export async function createAnthropicLLM({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
  maxTokens = 800,
  timeoutMs = 30_000,
} = {}) {
  if (!apiKey) return null;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
  return async function llm(prompt) {
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  };
}
