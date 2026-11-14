/** 数据源连接检查 / 隔离 / 恢复的领域类型。页面只展示，判定与写回都由 api 层负责。 */

export const CONNECTION_VERDICTS = ['可连接', '隔离', '待人工确认'] as const

export type ConnectionVerdict = (typeof CONNECTION_VERDICTS)[number]

/** 未提交过检查时，连接资格还没有证据，不能等同于“可连接”。 */
export type ConnectionEligibility = ConnectionVerdict | '未检查'

export type FactorOutcome = '通过' | '阻塞' | '待确认'

export type FactorKey = 'connectionType' | 'authMode' | 'timeout' | 'retry' | 'syncLink'

export type CheckFactor = {
  key: FactorKey
  label: string
  value: string
  outcome: FactorOutcome
  detail: string
}

/**
 * 一次检查从“启动快照”到“写回”之间可能被配置变更、并发检查或人工裁定作废。
 * 未写回的检查仍然保留在回看时间线上，只是不参与当前连接资格。
 */
export type CheckWriteStatus =
  | '已写回'
  | '未写回-配置变更'
  | '未写回-并发覆盖'
  | '未写回-优先级裁定'
  | '未写回-人工裁定'

export type ConnectionCheck = {
  id: string
  runId: string
  connectionId: string
  /** 启动顺序号：并发检查按“较晚启动、先写回”的优先级裁定。 */
  sequence: number
  /** 检查启动时捕获的配置版本；配置变更后旧结论不能继续算数。 */
  configVersion: string
  startedAt: string
  finishedAt: string
  actor: string
  verdict: ConnectionVerdict
  factors: CheckFactor[]
  evidence: string[]
  reason: string
  /** 是否被采纳进连接资格；未采纳的记录仍然保留为回看证据。 */
  applied: boolean
  adjudication: string
  writeStatus: CheckWriteStatus
  writeStatusReason: string
  /** 启动时的写回令牌快照，用于发现配置/人工裁定已经发生变化。 */
  snapshotToken: number
  /** 启动快照里引用的 SYNC 链路，写回后仍可核对当时看到的是哪几条链路。 */
  snapshotSyncLinks: string[]
}

export type ConnectionEventType =
  | '配置变更'
  | '隔离'
  | '待人工确认'
  | '恢复'
  | '检查写回'
  | '检查未写回'

export type ConnectionEvent = {
  id: string
  connectionId: string
  at: string
  type: ConnectionEventType
  title: string
  detail: string
  configVersion: string
}

export type ManualConfirmation = {
  at: string
  actor: string
  note: string
  decision: '可连接' | '隔离'
  configVersion: string
  evidenceCheckIds: string[]
}

/** 相反结论的裁定记录：时间、配置版本、规则和胜出检查都留在回看里。 */
export type ConnectionConflict = {
  at: string
  previousId: string
  previousVerdict: ConnectionVerdict
  previousVersion: string
  nextId: string
  nextVerdict: ConnectionVerdict
  nextVersion: string
  rule: string
  summary: string
  winnerId: string
}

export type ConnectionRuntime = {
  connectionId: string
  verdict: ConnectionEligibility
  verdictReason: string
  /** 当前资格结论对应的配置版本；配置变更后旧证据不能继续算数。 */
  effectiveConfigVersion: string
  lastCheckAt: string
  /** 乐观并发令牌:配置变更、人工隔离/恢复都会递增。 */
  writeToken: number
  /** 最近一次启动的检查序号。 */
  lastSequence: number
  /** 最近一次写回成功的检查序号，较晚启动的检查先写回时用它拒绝旧结论。 */
  lastCommittedSequence: number
  lastCommittedRunId: string
  /** 同一配置版本下连续写回为“可连接”的检查；隔离后至少 2 条才具备恢复资格。 */
  successStreakIds: string[]
  checks: ConnectionCheck[]
  events: ConnectionEvent[]
  conflicts: ConnectionConflict[]
  manualConfirmation?: ManualConfirmation
  isolatedAt?: string
  isolationReason?: string
  /** 隔离发生时的检查序号下界：只有序号更大的成功检查才算恢复门槛。用序号而非时间，避免同毫秒比较失真。 */
  isolationBoundarySequence: number
}

/** 检查启动时冻结的配置与链路快照，检查期间配置被改也不会用新配置“补算”旧检查。 */
export type CheckSnapshot = {
  runId: string
  /** 页面展示用的短编号（CHK-0003），与写回令牌无关。 */
  label: string
  connectionId: string
  startedAt: string
  configVersion: string
  token: number
  sequence: number
  actor: string
  input: CheckInput
}

export type SyncLinkSnapshot = {
  linkId: string
  status: string
  targetConnection: string
  syncMode: string
}

/** 一次探测的握手结果；除配置外，握手是否完成也会改变结论，供并发/相反结论场景使用。 */
export type ProbeOutcome = '正常' | '握手超时'

export type CheckInput = {
  probe: ProbeOutcome
  connectionId: string
  configVersion: string
  connectionType: string
  endpoint: string
  authMode: string
  timeoutSeconds: string
  retryCount: string
  syncLinks: SyncLinkSnapshot[]
}

export type PendingCheck = {
  snapshot: CheckSnapshot
  startedAt: string
}

/** 本地持久化的连接域状态：运行时证据与同步运行记录分开保存。 */
export type ConnectionState = {
  version: 1
  runtimes: Record<string, ConnectionRuntime>
  pending: Record<string, PendingCheck>
  runs: SyncRunRecord[]
}

/** SYNC / MONI 共用的恢复证据视图：同一函数生成，同一组件渲染。 */
export type RecoveryEvidenceView = {
  connectionId: string
  verdict: ConnectionEligibility
  configVersion: string
  effectiveConfigVersion: string
  lastCheckAt: string
  requiredSuccesses: number
  successCount: number
  successCheckIds: string[]
  /** 解除隔离的资格是否已满足（仍需人工确认恢复）。 */
  recoveryEligible: boolean
  /** 是否已经具备启动/续跑新任务的条件。 */
  canStartSync: boolean
  reason: string
  conflictSummary: string
  manualNote?: string
  manualConfirmed: boolean
  evidenceSource: string
  latestCheckId?: string
  isolatedAt?: string
  isolationReason?: string
}

export type LaunchGuardCode =
  | 'ok'
  | 'no-link'
  | 'no-source'
  | 'no-connection'
  | 'unchecked'
  | 'isolated'
  | 'manual-pending'
  | 'config-stale'

export type ConnectionLaunchGuard = {
  ok: boolean
  code: LaunchGuardCode
  reason: string
  evidence?: RecoveryEvidenceView
}

export type SyncRunStatus = '成功' | '失败' | '中断' | '运行中'

export type SyncRunRecord = {
  id: string
  linkId: string
  attempt: number
  status: SyncRunStatus
  startedAt: string
  finishedAt?: string
  /** 本条运行从哪个水位开始（已消费行数，不含）。 */
  checkpointStart: number
  /** 本条运行结束/中断时的水位；失败时就是失败位点。 */
  checkpointEnd: number
  consumedRows: number
  failureReason?: string
  /** 下一次允许续跑的水位：失败位点，不回到 0。 */
  nextResumeOffset: number
  sourceConfigVersion: string
  note: string
}

export type ResumePlanCode =
  | 'ok'
  | 'no-failure'
  | 'no-runs'
  | 'source-not-recovered'

export type ResumePlan = {
  ok: boolean
  code: ResumePlanCode
  reason: string
  fromOffset: number
  consumedBefore: number
  replayRows: number
  failedRun?: SyncRunRecord
  guard?: ConnectionLaunchGuard
  evidence?: RecoveryEvidenceView
}

/** 数据源连接页的行视图：配置行 + 连接资格运行时。 */
export type SourceRowView = {
  id: number
  connectionId: string
  连接编号: string
  连接类型: string
  接入地址: string
  认证方式: string
  连接池配置: string
  超时秒数: string
  重试次数: string
  负责人: string
  status: string
  configVersion: string
  eligibility: ConnectionEligibility
  lastCheckAt: string
  evidenceSummary: string
  pendingChecks: number
}

export type SourceListResult = {
  items: SourceRowView[]
  total: number
  allTotal: number
}

export type SourceReview = {
  row: SourceRowView
  evidence: RecoveryEvidenceView
  runtime: ConnectionRuntime
  latestApplied?: ConnectionCheck
  pendingChecks: number
}

export type SyncLinkView = {
  id: number
  linkId: string
  sourceConnection: string
  targetConnection: string
  tables: string
  syncMode: string
  frequency: string
  latencyThreshold: string
  owner: string
  status: string
  guard: ConnectionLaunchGuard
  evidence?: RecoveryEvidenceView
  lastRun?: SyncRunRecord
  runCount: number
  resumePlan: ResumePlan
}

export type SyncLinkListResult = {
  items: SyncLinkView[]
  total: number
  allTotal: number
}

export type MonitorRowView = {
  id: number
  configId: string
  linkedLink: string
  metric: string
  threshold: string
  level: string
  silenceMinutes: string
  channel: string
  recoveryCondition: string
  status: string
  linkFound: boolean
  sourceConnection: string
  guard: ConnectionLaunchGuard
  evidence?: RecoveryEvidenceView
  explanation: string
}

export type MonitorListResult = {
  items: MonitorRowView[]
  total: number
  allTotal: number
}

export type CheckBeginOutcome = {
  ok: boolean
  message: string
  runId?: string
  startedAt?: string
  verdict?: ConnectionVerdict
  factors?: CheckFactor[]
  reason?: string
}

export type CheckCommitOutcome = CheckBeginOutcome & {
  check?: ConnectionCheck
  evidence?: RecoveryEvidenceView
  writeStatus?: CheckWriteStatus
}

export type SyncRunOutcome = {
  ok: boolean
  message: string
  run?: SyncRunRecord
  plan?: ResumePlan
  guard?: ConnectionLaunchGuard
  code?: ResumePlanCode | LaunchGuardCode | 'link-not-found'
}

export type ManualOutcome = {
  ok: boolean
  message: string
  evidence?: RecoveryEvidenceView
}

export type CreateSourceInput = {
  连接类型: string
  接入地址: string
  认证方式: string
  超时秒数: string
  重试次数: string
  负责人: string
}
