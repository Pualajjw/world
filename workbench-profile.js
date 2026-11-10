import { parseClock } from './companion-time.js'

export const DEFAULT_WAKE_TIME = '09:00'
export const DEFAULT_REVIEW_TIME = '23:00'

export const DEFAULT_BACKGROUND = '她在 world 里过日子，有自己的时间和打算。愿意动手做事，也愿意安静待着；对这里的东西有耐心，会照料已经积累下来的记录、约定和没做完的事。说话自然具体，接得上前文。'
export const WORKBENCH_PRIORITY = '你的任务优先；没有任务时，她自己安排时间。'

export const EXPRESSION_STYLES = [
  { value: 'natural', label: '自然交流', instruction: '自然、具体地交流，接得上前文，按需要提供解释。' },
  { value: 'concise', label: '简洁直接', instruction: '先说结论，使用简洁直接的表达，保留必要依据和下一步。' },
  { value: 'detailed', label: '耐心详细', instruction: '耐心说明背景、选择和结果，提供有用的细节，但不重复堆砌。' },
]

const clock = (value, name, fallback) => {
  if (value === undefined || value === null || value === '') return fallback
  if (!parseClock(value)) throw Object.assign(new Error(`${name}需要 HH:MM 形式的时间。`), { code: 'WORLD_DESKTOP_PROFILE' })
  return String(value)
}

export function workbenchProfile(input = DEFAULT_BACKGROUND) {
  const invalid = message => { throw Object.assign(new Error(message), { code: 'WORLD_DESKTOP_PROFILE' }) }
  const value = typeof input === 'string' ? { background: input } : input
  if (!value || Array.isArray(value) || typeof value !== 'object' || (value.version !== undefined && ![1, 2, 3].includes(value.version)))
    invalid('助手个性化配置无效。')
  const { background = DEFAULT_BACKGROUND, name = '助手', userName = '', tone = 'natural',
    wakeTime = DEFAULT_WAKE_TIME, reviewTime = DEFAULT_REVIEW_TIME, life = true } = value
  if (typeof background !== 'string' || !background.trim() || background.length > 4000)
    invalid('助手背景需为 1 到 4000 字的文字。')
  if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 16 || /[\u0000-\u001f\u007f]/u.test(name))
    invalid('助手名字需为 1 到 16 字，不能包含换行或控制字符。')
  if (typeof userName !== 'string' || [...userName.trim()].length > 24 || /[\u0000-\u001f\u007f]/u.test(userName))
    invalid('对你的称呼最多 24 字，不能包含换行或控制字符。')
  if (!EXPRESSION_STYLES.some(style => style.value === tone)) invalid('请选择有效的表达风格。')
  if (typeof life !== 'boolean') invalid('生活线开关需要是布尔值。')
  return { version: 3, background: background.trim(), name: name.trim(), userName: userName.trim(), tone,
    wakeTime: clock(wakeTime, '早上时间', DEFAULT_WAKE_TIME), reviewTime: clock(reviewTime, '回顾时间', DEFAULT_REVIEW_TIME), life }
}
