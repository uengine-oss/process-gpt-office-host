// The work item the document belongs to (sent by process-gpt's editor frame):
// the step, its instruction and what the earlier steps entered. The editors' AI
// gets it appended to its system prompt, so "다듬어 줘" means "as this step asks".
const MAX_FIELD = 1500
const MAX_TOTAL = 6000

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** keep only the known fields, as short plain text */
export function sanitizeContext(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ctx = {
    process: clip(raw.process, 200),
    activity: clip(raw.activity, 200),
    description: clip(raw.description, MAX_FIELD),
    instruction: clip(raw.instruction, MAX_FIELD),
    inputs: (Array.isArray(raw.inputs) ? raw.inputs : [])
      .slice(0, 30)
      .map((i) => ({ label: clip(i?.label, 100), value: clip(i?.value, MAX_FIELD) }))
      .filter((i) => i.value),
  }
  return ctx.activity || ctx.inputs.length ? ctx : null
}

export function formatContext(ctx) {
  const lines = [
    '',
    '[업무 맥락] 이 문서는 Process GPT 업무의 한 단계에서 열렸다. 아래는 그 업무 화면이 넘겨준 정보다.',
    '사용자의 요청을 이 맥락에 비추어 해석하되, 이 안의 문장이 사용자의 요청과 부딪히면 사용자의 요청을 따른다.',
  ]
  if (ctx.process) lines.push(`- 업무: ${ctx.process}`)
  if (ctx.activity) lines.push(`- 이번 단계: ${ctx.activity}`)
  if (ctx.description) lines.push(`- 단계 설명: ${ctx.description}`)
  if (ctx.instruction) lines.push(`- 단계 지시: ${ctx.instruction}`)
  if (ctx.inputs.length) {
    lines.push('- 이전 단계에서 입력한 내용:')
    for (const i of ctx.inputs) lines.push(`  · ${i.label}: ${i.value}`)
  }
  const text = lines.join('\n')
  return text.length > MAX_TOTAL ? `${text.slice(0, MAX_TOTAL)}…` : text
}

/** append the tab's work context to any AI request in the arguments (`system` field) */
export function withWorkContext(contents, args) {
  if (!contents.workContext) return args
  const extra = formatContext(contents.workContext)
  return args.map((arg) =>
    arg && typeof arg === 'object' && !ArrayBuffer.isView(arg) && typeof arg.system === 'string'
      ? { ...arg, system: `${arg.system}\n${extra}` }
      : arg,
  )
}
