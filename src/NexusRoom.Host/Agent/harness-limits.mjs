export const name = 'nexusroom-limits'

function limit(value, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error('Invalid NexusRoom task limit')
  return value
}

export function apply(ctx, config) {
  const maxCalls = limit(config.maxCalls, 200)
  const maxSteps = limit(config.maxSteps, 100)
  let calls = 0
  let steps = 0
  ctx.on('llm/stream', (options, next) => {
    if (++calls > maxCalls) {
      throw Object.assign(new Error('已达到模型方案的最多模型调用次数（' + maxCalls + ' 次）'), { code: 'NEXUSROOM_LIMIT' })
    }
    return next()
  })
  ctx.on('tools/execute', (exec, next) => {
    if (++steps <= maxSteps) return next()
    const message = '已达到模型方案的最多工具操作步数（' + maxSteps + ' 步）；此操作未执行'
    return { content: [{ type: 'text', text: message }], isError: true, concludesTurn: true,
      error: { message, info: { name: 'NexusRoomLimitError', code: 'NEXUSROOM_LIMIT' } } }
  })
}
