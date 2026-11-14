/** 连接检查的判定规则：把配置与 SYNC 链路快照折算成三类证据。判定只在这里发生，页面与 api 层不各写一套。 */
import type { CheckFactor, CheckInput, ConnectionVerdict, FactorOutcome } from './connection-types'

type AuthRule = {
  allowed: string[]
  manual: string[]
}

const TYPE_RULES: Record<string, { label: string; auth: AuthRule }> = {
  MySQL: {
    label: 'MySQL',
    auth: { allowed: ['账号密码', '证书认证'], manual: [] },
  },
  PostgreSQL: {
    label: 'PostgreSQL',
    auth: { allowed: ['账号密码', '证书认证'], manual: [] },
  },
  Kafka: {
    label: 'Kafka',
    auth: { allowed: ['SASL/SCRAM', 'SASL/PLAIN', '证书认证'], manual: [] },
  },
  Hive: {
    label: 'Hive',
    auth: { allowed: ['账号密码', 'Kerberos'], manual: ['Kerberos'] },
  },
  SQLServer: {
    label: 'SQLServer',
    auth: { allowed: ['账号密码'], manual: [] },
  },
  Oracle: {
    label: 'Oracle',
    auth: { allowed: ['账号密码'], manual: [] },
  },
}

const TYPE_ALIASES: Array<[string, string]> = [
  ['mysql', 'MySQL'],
  ['postgres', 'PostgreSQL'],
  ['pg', 'PostgreSQL'],
  ['kafka', 'Kafka'],
  ['hive', 'Hive'],
  ['sqlserver', 'SQLServer'],
  ['mssql', 'SQLServer'],
  ['oracle', 'Oracle'],
]

/** 需要外部凭据材料、单次自动探测无法验完的认证方式。 */
const MANUAL_AUTH = new Set(['Kerberos', 'IAM', 'OAuth2', 'Windows 集成认证', 'Kerberos 票据'])

const OUTCOME_RANK: Record<FactorOutcome, number> = { 通过: 0, 待确认: 1, 阻塞: 2 }

function normalizeType(value: string): string | null {
  const raw = value.trim().toLowerCase()
  if (!raw) return null
  for (const [alias, name] of TYPE_ALIASES) {
    if (raw.includes(alias)) return name
  }
  return value.trim()
}

function countOf(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

function factorOf(
  key: CheckFactor['key'],
  label: string,
  value: string,
  outcome: FactorOutcome,
  detail: string,
): CheckFactor {
  return { key, label, value: value || '未填写', outcome, detail }
}

function evalType(input: CheckInput): CheckFactor {
  const raw = input.connectionType
  if (!raw.trim()) {
    return factorOf('connectionType', '连接类型', raw, '待确认', '连接类型为空，无法选择探测驱动')
  }
  const normalized = normalizeType(raw)
  if (!normalized || !TYPE_RULES[normalized]) {
    return factorOf(
      'connectionType',
      '连接类型',
      raw,
      '待确认',
      `驱动清单里没有 ${raw} 的可用探测实现，需要人工确认驱动是否登记`,
    )
  }
  return factorOf(
    'connectionType',
    '连接类型',
    raw,
    '通过',
    `${TYPE_RULES[normalized].label} 驱动已登记，可按 ${normalized} 协议发起握手`,
  )
}

function evalAuth(input: CheckInput): CheckFactor {
  const raw = input.authMode
  if (!raw.trim()) {
    return factorOf('authMode', '认证方式', raw, '待确认', '认证方式为空，探测无法决定使用哪套凭据')
  }
  const normalizedType = normalizeType(input.connectionType) ?? ''
  const rule = TYPE_RULES[normalizedType]
  if (!rule) {
    return factorOf(
      'authMode',
      '认证方式',
      raw,
      '待确认',
      '连接类型未知，认证方式无法与类型比对',
    )
  }
  if (MANUAL_AUTH.has(raw)) {
    return factorOf(
      'authMode',
      '认证方式',
      raw,
      '待确认',
      `${raw} 依赖外部票据或密钥材料，自动探测只能确认协议可达，需人工核对凭据`,
    )
  }
  if (!rule.auth.allowed.includes(raw)) {
    return factorOf(
      'authMode',
      '认证方式',
      raw,
      '阻塞',
      `${normalizedType} 不支持「${raw}」，认证握手会在协议层直接失败；可选：${rule.auth.allowed.join('、')}`,
    )
  }
  return factorOf('authMode', '认证方式', raw, '通过', `${normalizedType} 支持「${raw}」，凭据形态可自动校验`)
}

function evalTimeout(input: CheckInput): CheckFactor {
  const raw = input.timeoutSeconds
  const seconds = countOf(raw)
  if (seconds === null) {
    return factorOf('timeout', '超时秒数', raw, '待确认', '超时秒数不是有效数字，探测没有截止时间')
  }
  if (seconds < 10) {
    return factorOf(
      'timeout',
      '超时秒数',
      raw,
      '阻塞',
      `超时 ${seconds}s 低于 10s 下限，握手还没完成就会判定失败；建议 ≥ 30s`,
    )
  }
  if (input.probe === '握手超时') {
    return factorOf(
      'timeout',
      '超时秒数',
      `${seconds}s`,
      '阻塞',
      `本次探测在 ${seconds}s 阈值内没有完成握手（连接类型 ${input.connectionType || '未填写'}，地址 ${input.endpoint || '未填写'}），判定为握手超时`,
    )
  }
  if (seconds > 120) {
    return factorOf(
      'timeout',
      '超时秒数',
      raw,
      '待确认',
      `超时 ${seconds}s 超过 120s，单次检查会长时间占住检查队列，需人工确认是否必要`,
    )
  }
  return factorOf('timeout', '超时秒数', raw, '通过', `超时 ${seconds}s 在 10–120s 可用区间内`)
}

function evalRetry(input: CheckInput): CheckFactor {
  const raw = input.retryCount
  const retry = countOf(raw)
  if (retry === null) {
    return factorOf('retry', '重试次数', raw, '待确认', '重试次数不是有效数字，无法判断抖动容忍度')
  }
  if (retry < 1) {
    return factorOf(
      'retry',
      '重试次数',
      raw,
      '阻塞',
      '重试次数为 0，一次瞬时网络抖动就会把连接判定为失败；建议 ≥ 2',
    )
  }
  if (retry < 2) {
    return factorOf('retry', '重试次数', raw, '待确认', '仅 1 次重试，抖动容忍不足，需人工确认是否可以放宽')
  }
  return factorOf('retry', '重试次数', raw, '通过', `重试 ${retry} 次，可消化握手阶段的瞬时抖动`)
}

function evalSyncLink(input: CheckInput): CheckFactor {
  const links = input.syncLinks
  if (links.length === 0) {
    return factorOf(
      'syncLink',
      'SYNC 链路',
      '无引用',
      '待确认',
      '没有 SYNC 链路引用该源端，无法用同步方向反证连接可用，需人工确认',
    )
  }
  const bad = links.filter((link) => !link.targetConnection.trim() || !link.status.trim())
  const interrupted = links.filter((link) => link.status === '已中断' || link.status === '已失败')
  if (bad.length > 0) {
    return factorOf(
      'syncLink',
      'SYNC 链路',
      `${links.length} 条`,
      '待确认',
      `${bad.map((link) => link.linkId).join('、')} 缺少目标端或状态，链路引用不完整，需人工补齐`,
    )
  }
  // 链路的中断记录属于“已有运行事实”，说明连接曾经可用、失败位点已保留；
  // 它不改变本次握手结论，只作为回看上下文，避免恢复判定与续跑互相锁死。
  const details = links
    .map((link) => {
      const failure = interrupted.some((item) => item.linkId === link.linkId)
        ? `，${link.status}（失败位点已保留，恢复后从此处续跑）`
        : `，${link.status}`
      return `${link.linkId}（目标端 ${link.targetConnection}，${link.syncMode}${failure}）`
    })
    .join('；')
  return factorOf(
    'syncLink',
    'SYNC 链路',
    `${links.length} 条`,
    '通过',
    `被 ${details} 引用，链路目标端与同步模式已登记`,
  )
}

export type FactorEvaluation = {
  factors: CheckFactor[]
  verdict: ConnectionVerdict
  reason: string
  evidence: string[]
}

/** 任一项阻塞即隔离；没有阻塞但存在待确认项则转人工；五项全过才可连接。 */
export function evaluateConnection(input: CheckInput): FactorEvaluation {
  const factors = [
    evalType(input),
    evalAuth(input),
    evalTimeout(input),
    evalRetry(input),
    evalSyncLink(input),
  ]
  const worst = factors.reduce<FactorOutcome>(
    (acc, factor) => (OUTCOME_RANK[factor.outcome] > OUTCOME_RANK[acc] ? factor.outcome : acc),
    '通过',
  )
  const blockers = factors.filter((factor) => factor.outcome === '阻塞')
  const pending = factors.filter((factor) => factor.outcome === '待确认')

  let verdict: ConnectionVerdict = '可连接'
  let reason = ''
  if (worst === '阻塞') {
    verdict = '隔离'
    reason = `触发隔离的阻塞项：${blockers.map((factor) => `${factor.label}(${factor.value})`).join('；')}`
  } else if (worst === '待确认') {
    verdict = '待人工确认'
    reason = `无法自动判定的待确认项：${pending.map((factor) => `${factor.label}(${factor.value})`).join('；')}`
  } else {
    reason = '连接类型、认证方式、超时秒数、重试次数与 SYNC 链路五项检查全部通过'
  }

  const evidence = factors.map(
    (factor) => `${factor.label}=${factor.value} → ${factor.outcome}：${factor.detail}`,
  )
  return { factors, verdict, reason, evidence }
}
