/**
 * In-browser inference adapter (WebGPU via WebLLM).
 * Capability-detects WebGPU and falls back to server-side routing on unsupported clients.
 * Implementation lands in Phase 3.
 */
export async function hasWebGPU(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const gpu = (navigator as Navigator & { gpu?: unknown }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await (
      gpu as { requestAdapter: () => Promise<unknown> }
    ).requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

export type WebLLMModelId = 'llama-3.2-3b-instruct' | 'phi-3.5-mini-instruct';
