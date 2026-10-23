// The AI the editors use is the platform's in-house LLM server (OpenAI compatible),
// configured on the server only. The editors' own provider layer is kept: the
// host hands it a `custom` endpoint, so every AI path in the fork (stream, chat,
// PDF translation, sheets/slides tools) reaches the same model.
//
// Variables follow process-gpt (office-mcp: CUSTOM_LLM_*, deepagents: LLM_PROXY_*):
//   CUSTOM_LLM_BASE_URL | LLM_PROXY_URL      e.g. http://<llm-server>/v1
//   CUSTOM_LLM_API_KEY  | LLM_PROXY_API_KEY
//   CUSTOM_LLM_MODEL    | LLM_MODEL          default frentis-ai-model
//   CUSTOM_LLM_REASONING_EFFORT              default low (empty = leave to the server)
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultAiSettings } from '@ieum/packages/ai-provider/src/providers'

const ENDPOINT_ID = 'ep-inhouse'
const MASK = 'server-managed'

export const llm = {
  baseUrl: process.env.CUSTOM_LLM_BASE_URL || process.env.LLM_PROXY_URL || '',
  apiKey: process.env.CUSTOM_LLM_API_KEY || process.env.LLM_PROXY_API_KEY || '',
  model: process.env.CUSTOM_LLM_MODEL || process.env.LLM_MODEL || 'frentis-ai-model',
  name: process.env.CUSTOM_LLM_NAME || '사내 LLM',
}

function settingsWith(apiKey) {
  const settings = defaultAiSettings()
  const endpoint = { id: ENDPOINT_ID, name: llm.name, baseUrl: llm.baseUrl, apiKey, model: llm.model, models: [llm.model] }
  settings.provider = 'custom'
  settings.providers.custom = { baseUrl: llm.baseUrl, apiKey, model: llm.model }
  settings.customEndpoints = [endpoint]
  settings.customEndpoint = ENDPOINT_ID
  return settings
}

/** what the model calls run with; never sent to a page */
export const serverAiSettings = () => settingsWith(llm.apiKey)

/** what pages see: the same choice with the key replaced by a marker */
export const pageAiSettings = () => settingsWith(llm.apiKey ? MASK : '')

/**
 * Some editor code reads ai-settings.json from userData (search/media capability
 * checks); keep that file equal to the server settings.
 */
export function writeSettingsFile(userData) {
  writeFileSync(join(userData, 'ai-settings.json'), JSON.stringify(serverAiSettings(), null, 2))
}

/**
 * Pages send their settings along with each AI request (`request.settings`); the
 * host swaps in the server settings so the masked key never reaches a provider
 * and a page cannot point the call at another endpoint.
 */
export function withServerSettings(args) {
  for (const arg of args) {
    if (arg && typeof arg === 'object' && !ArrayBuffer.isView(arg) && 'settings' in arg) {
      arg.settings = serverAiSettings()
    }
  }
  return args
}

/**
 * Reasoning models (gpt-oss behind frentis-ai-model) spend the output budget on thinking;
 * a heavy edit turn can end at the cap with no answer. process-gpt calls this server with
 * reasoning_effort "low" (office-mcp REASONING_EFFORT); the fork's `custom` provider has
 * no field for it, so the host adds it to requests bound for the in-house endpoint.
 */
export function installRequestTuning() {
  const effort = process.env.CUSTOM_LLM_REASONING_EFFORT ?? 'low'
  if (!llm.baseUrl || !effort) return
  const base = llm.baseUrl.replace(/\/+$/, '')
  const nativeFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url
    if (url?.startsWith(base) && url.endsWith('/chat/completions') && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        if (body.reasoning_effort === undefined) body.reasoning_effort = effort
        init = { ...init, body: JSON.stringify(body) }
      } catch {
        // not JSON: leave the request as it is
      }
    }
    return nativeFetch(input, init)
  }
}

export function describeLlm() {
  const effort = process.env.CUSTOM_LLM_REASONING_EFFORT ?? 'low'
  return `${llm.name} ${llm.model} @ ${llm.baseUrl || '(CUSTOM_LLM_BASE_URL not set)'}${llm.apiKey ? '' : ' (no key)'}${effort ? `, reasoning ${effort}` : ''}`
}
