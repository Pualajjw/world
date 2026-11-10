/** Local-clock helpers for the life line: a world runs on one machine, so the system clock is the clock. */
const pad = value => String(value).padStart(2, '0')

export const dayKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
export const hhmm = date => `${pad(date.getHours())}:${pad(date.getMinutes())}`

/** `HH:MM` as { hour, minute }, or undefined when it is not a clock time. */
export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return undefined
  const hour = Number(match[1]), minute = Number(match[2])
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? { hour, minute } : undefined
}

/** The next time the clock reads `value`, strictly after `now`. */
export function nextClock(now, value) {
  const clock = parseClock(value)
  if (!clock) return undefined
  const at = new Date(now)
  at.setHours(clock.hour, clock.minute, 0, 0)
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  return at
}

/** The same reading today, or yesterday when it has not come yet — for a look back that covers the day just ended. */
export function lastClock(now, value) {
  const clock = parseClock(value)
  if (!clock) return undefined
  const at = new Date(now)
  at.setHours(clock.hour, clock.minute, 0, 0)
  if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 1)
  return at
}

const MINUTE = 60_000

/** `at` (an ISO instant with an offset) or `after_minutes`; at least a minute ahead, at most a week. */
export function alarmTime(input, now) {
  const { at, after_minutes: after } = input || {}
  if (after !== undefined && after !== null) {
    const minutes = Number(after)
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 24 * 60) throw new Error('after_minutes 需要 1 到 10080 之间的分钟数。')
    return new Date(now.getTime() + Math.round(minutes * MINUTE))
  }
  if (typeof at !== 'string' || !at.trim()) throw new Error('请给 at（带时区的完整时间）或 after_minutes。')
  const value = Date.parse(at)
  if (!Number.isFinite(value)) throw new Error('at 需要带时区的完整时间，例如 2026-11-09T21:30:00+08:00。')
  if (value < now.getTime() + MINUTE) throw new Error('闹钟至少要在一分钟之后。')
  if (value > now.getTime() + 7 * 24 * 60 * MINUTE) throw new Error('闹钟最多定到一周以后。')
  return new Date(value)
}

/** `今天 21:30` / `明天 09:00` / `11-11 09:00`, so a wake message reads like a person saying the time. */
export function whenText(date, now) {
  const target = dayKey(date), today = dayKey(now)
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
  if (target === today) return `今天 ${hhmm(date)}`
  if (target === dayKey(tomorrow)) return `明天 ${hhmm(date)}`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm(date)}`
}

/** Whole minutes between two instants, floored at zero. */
export const minutesBetween = (from, to) => Math.max(0, Math.round((to.getTime() - from.getTime()) / MINUTE))
