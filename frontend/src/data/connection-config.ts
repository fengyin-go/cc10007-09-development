/** 连接检查里用到的纯函数：配置版本、时间格式化和文案归一化。 */
import type { EntryRow } from './types'

/** 影响连接资格的配置字段；改负责人或状态不会让已有检查证据失效。 */
export const CONNECTION_CONFIG_FIELDS = [
  '连接类型',
  '接入地址',
  '认证方式',
  '连接池配置',
  '超时秒数',
  '重试次数',
] as const

export const REQUIRED_SUCCESS_STREAK = 2

export function textOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

/** 配置版本：同一组连接配置得到同一个值，任一连接配置变更就会换版本。 */
export function configVersionOf(row: EntryRow | Record<string, unknown>): string {
  const source = row as Record<string, unknown>
  const payload = CONNECTION_CONFIG_FIELDS.map((field) => `${field}=${textOf(source[field])}`).join('|')
  let hash = 0x811c9dc5
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `cfg-${hash.toString(16).padStart(8, '0')}`
}

export function formatTimestamp(value: string | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (part: number) => String(part).padStart(2, '0')
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return (
    `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ` +
    `${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`
  )
}

export function nowIso(): string {
  return new Date().toISOString()
}

