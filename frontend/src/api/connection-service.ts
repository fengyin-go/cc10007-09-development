/** 连接检查 / 隔离 / 恢复 / 续跑的核心引擎。
 *
 * - 检查分两步：beginCheck 冻结配置与链路快照，commitCheck 按快照重新判定后才写回。
 *   检查期间配置被改，旧快照的结论不能拿新配置“补算”，写回会被拒绝并留痕。
 * - 并发写回：较晚启动的检查先到就写回，较早启动的检查随后到达会被优先级裁定拒绝，
 *   不会把旧结论盖回新结论。
 * - 恢复资格：隔离位点之后、同一配置版本连续两次独立检查写回“可连接”才具备恢复资格，
 *   之后仍需人工确认才能变为可连接；单次成功响应不足以恢复。
 * - SYNC 与 MONI 共用 recoveryEvidenceFor() 生成的同一份证据。
 */
import { evaluateConnection } from '@/data/connection-check'
import {
  REQUIRED_SUCCESS_STREAK,
  configVersionOf,
  formatTimestamp,
  nowIso,
  textOf,
} from '@/data/connection-config'
import type {
  CheckBeginOutcome,
  CheckCommitOutcome,
  CheckInput,
  CheckSnapshot,
  CheckWriteStatus,
  ConnectionCheck,
  ConnectionConflict,
  ConnectionEligibility,
  ConnectionEvent,
  ConnectionEventType,
  ConnectionLaunchGuard,
  ConnectionRuntime,
  ConnectionState,
  CreateSourceInput,
  ManualOutcome,
  MonitorListResult,
  MonitorRowView,
  ProbeOutcome,
  RecoveryEvidenceView,
  ResumePlan,
  SourceListResult,
  SourceReview,
  SourceRowView,
  SyncLinkListResult,
  SyncLinkSnapshot,
  SyncLinkView,
  SyncRunOutcome,
  SyncRunRecord,
} from '@/data/connection-types'
import type { EntryRow } from '@/data/types'
import { listRows, resetRows, saveRows } from '@/data/local-store'

const SOURCE_KEY = 'source'
const SYNC_KEY = 'datasync'
const MONITOR_KEY = 'monitor'
const ACTOR = '值班管理员'
const STATE_KEY = 'data-layer-studio:connection-state'

const SOURCE_STATUS_TO_VERDICT: Record<string, ConnectionEligibility> = {
  已连通: '可连接',
  已隔离: '隔离',
  待人工确认: '待人工确认',
  草稿: '未检查',
  待连通: '未检查',
}

const VERDICT_TO_SOURCE_STATUS: Record<ConnectionEligibility, string> = {
  可连接: '已连通',
  隔离: '已隔离',
  待人工确认: '待人工确认',
  未检查: '待连通',
}

/** 本地临时会话状态；连接域状态单独持久化，避免与业务行混在一起。 */
const session = {
  state: null as ConnectionState | null,
  seq: 0,
}

/** 重置后需要把示例运行记录重新播种；否则沿用上次的内存状态。 */
let seedPendingState = false

function readState(): ConnectionState {
  if (session.state && !seedPendingState) return session.state
  seedPendingState = false
  const empty: ConnectionState = { version: 1, runtimes: {}, pending: {}, runs: [] }
  if (typeof window === 'undefined' || !window.localStorage) {
    session.state = seedState(empty)
    return session.state
  }
  const raw = window.localStorage.getItem(STATE_KEY)
  if (!raw) {
    const seeded = seedState(empty)
    writeState(seeded)
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as ConnectionState
    if (!parsed || parsed.version !== 1) {
      const seeded = seedState(empty)
      writeState(seeded)
      return seeded
    }
    parsed.runtimes ??= {}
    parsed.pending ??= {}
    parsed.runs ??= []
    session.state = parsed
    return parsed
  } catch {
    const seeded = seedState(empty)
    writeState(seeded)
    return seeded
  }
}

function writeState(next: ConnectionState): void {
  session.state = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(next))
  }
}

function findSourceRow(connectionId: string): EntryRow | undefined {
  return listRows(SOURCE_KEY).find((row) => textOf(row['连接编号']) === connectionId)
}

function findLinkRow(linkId: string): EntryRow | undefined {
  return listRows(SYNC_KEY).find((row) => textOf(row['链路编号']) === linkId)
}

function seedState(state: ConnectionState): ConnectionState {
  const source1 = findSourceRow('SOUR-0001')
  const source2 = findSourceRow('SOUR-0002')
  const source5 = findSourceRow('SOUR-0005')
  const runs: SyncRunRecord[] = [
    {
      id: 'RUN-0001-D001',
      linkId: 'DATA-0001',
      attempt: 1,
      status: '成功',
      startedAt: '2026-11-13T02:15:00.000Z',
      finishedAt: '2026-11-13T02:18:00.000Z',
      checkpointStart: 0,
      checkpointEnd: 1200,
      consumedRows: 1200,
      nextResumeOffset: 1200,
      sourceConfigVersion: source1 ? configVersionOf(source1) : '',
      note: '增量批 1 完成，水位推进到 1200',
    },
    {
      id: 'RUN-0002-D001',
      linkId: 'DATA-0001',
      attempt: 2,
      status: '成功',
      startedAt: '2026-11-13T02:30:00.000Z',
      finishedAt: '2026-11-13T02:32:00.000Z',
      checkpointStart: 1200,
      checkpointEnd: 1500,
      consumedRows: 300,
      nextResumeOffset: 1500,
      sourceConfigVersion: source1 ? configVersionOf(source1) : '',
      note: '增量批 2 完成，水位推进到 1500',
    },
    {
      id: 'RUN-0003-D002',
      linkId: 'DATA-0002',
      attempt: 1,
      status: '失败',
      startedAt: '2026-11-13T03:00:00.000Z',
      finishedAt: '2026-11-13T03:04:00.000Z',
      checkpointStart: 0,
      checkpointEnd: 640,
      consumedRows: 640,
      failureReason: '源端连接 SOUR-0002 在偏移 640 处握手超时，后续 120 行未消费',
      nextResumeOffset: 640,
      sourceConfigVersion: source2 ? configVersionOf(source2) : '',
      note: '失败位点已固化，等待连接恢复后从 640 续跑',
    },
    {
      id: 'RUN-0004-D004',
      linkId: 'DATA-0004',
      attempt: 1,
      status: '中断',
      startedAt: '2026-11-13T03:10:00.000Z',
      finishedAt: '2026-11-13T03:12:00.000Z',
      checkpointStart: 0,
      checkpointEnd: 320,
      consumedRows: 320,
      failureReason: '源端连接 SOUR-0005 转人工确认，任务按隔离规则中断',
      nextResumeOffset: 320,
      sourceConfigVersion: source5 ? configVersionOf(source5) : '',
      note: '人工确认前不允许新任务；已写入的水位 320 保留',
    },
  ]
  return { ...state, runs }
}

/** 示例数据里已经“已连通”的连接补两条历史检查，避免出现没有证据的可连接。 */
function seededChecks(row: EntryRow, version: string): ConnectionCheck[] {
  const connectionId = textOf(row['连接编号'])
  const make = (index: number, finishedAt: string): ConnectionCheck => ({
    id: `CHK-${String(index).padStart(4, '0')}-${version.slice(-4)}`,
    runId: `SEED-${connectionId}-${index}`,
    connectionId,
    sequence: index,
    configVersion: version,
    startedAt: finishedAt,
    finishedAt,
    actor: ACTOR,
    verdict: '可连接',
    factors: [],
    evidence: ['示例数据：历史检查记录，作为初始可连接的依据'],
    reason: '示例数据：历史检查五项通过',
    applied: true,
    adjudication: '示例初始结论',
    writeStatus: '已写回',
    writeStatusReason: '',
    snapshotToken: 0,
    snapshotSyncLinks: [],
  })
  return [make(1, '2026-11-13T02:00:00.000Z'), make(2, '2026-11-13T02:18:00.000Z')]
}

function runtimeFor(row: EntryRow, connectionId: string): ConnectionRuntime {
  const status = textOf(row.status)
  const verdict = SOURCE_STATUS_TO_VERDICT[status] ?? '未检查'
  const version = configVersionOf(row)
  const seededAt = '2026-11-13T03:04:00.000Z'
  const history = verdict === '可连接' ? seededChecks(row, version) : []
  return {
    connectionId,
    verdict,
    verdictReason:
      verdict === '未检查'
        ? '尚未提交连接检查，没有可引用的资格证据；不能按可连接对待'
        : history.length > 0
          ? `历史状态「${status}」带入（附 ${history.length} 条示例检查记录），等待新检查写回覆盖`
          : `历史状态「${status}」带入，但没有写回的检查记录；提交检查后才有可引用证据`,
    effectiveConfigVersion: version,
    lastCheckAt: verdict === '可连接' ? '2026-11-13T02:18:00.000Z' : seededAt,
    writeToken: 1,
    lastSequence: history.length,
    lastCommittedSequence: history.length,
    lastCommittedRunId: history[history.length - 1]?.runId ?? '',
    successStreakIds: history.slice(-REQUIRED_SUCCESS_STREAK).map((check) => check.id),
    checks: history,
    events: [],
    conflicts: [],
    manualConfirmation: undefined,
    isolatedAt: verdict === '隔离' ? seededAt : undefined,
    isolationReason:
      verdict === '隔离'
        ? '历史记录：连续 3 次握手超时后隔离；当前配置版本下的成功检查次数 0/2'
        : undefined,
    isolationBoundarySequence: 0,
  }
}

/** 读取连接域状态，并把源端行补进运行时（不回写）。 */
function loadState(): ConnectionState {
  const state = readState()
  for (const row of listRows(SOURCE_KEY)) {
    const connectionId = textOf(row['连接编号'])
    if (!connectionId) continue
    if (!state.runtimes[connectionId]) {
      state.runtimes[connectionId] = runtimeFor(row, connectionId)
    }
  }
  return state
}

function eventOf(
  connectionId: string,
  type: ConnectionEventType,
  title: string,
  detail: string,
  configVersion: string,
  at: string,
): ConnectionEvent {
  session.seq += 1
  return {
    id: `EVT-${Date.now().toString(36)}-${String(session.seq).padStart(3, '0')}`,
    connectionId,
    at,
    type,
    title,
    detail,
    configVersion,
  }
}

function pushEvent(runtime: ConnectionRuntime, event: ConnectionEvent): ConnectionRuntime {
  return { ...runtime, events: [event, ...runtime.events].slice(0, 160) }
}

function syncSourceStatus(runtime: ConnectionRuntime): void {
  const rows = listRows(SOURCE_KEY)
  const index = rows.findIndex((row) => textOf(row['连接编号']) === runtime.connectionId)
  if (index < 0) return
  const nextStatus = VERDICT_TO_SOURCE_STATUS[runtime.verdict]
  const abnormal = runtime.verdict === '隔离' || runtime.verdict === '待人工确认'
  const pending = runtime.verdict === '待人工确认'
  const current = rows[index]
  if (
    textOf(current.status) === nextStatus &&
    Boolean(current.abnormal) === abnormal &&
    Boolean(current.pending) === pending
  ) {
    return
  }
  const updated: EntryRow = { ...current, status: nextStatus, pending, abnormal }
  const next = [...rows]
  next[index] = updated
  saveRows(SOURCE_KEY, next)
}

/**
 * 配置变更检测：当前配置版本与资格结论对应的版本不一致时，旧证据失效。
 * 可连接降级为未检查；隔离/待人工确认保持阻断，避免一次配置修改就静默放行。
 */
function syncConfigTokens(state: ConnectionState): ConnectionState {
  for (const row of listRows(SOURCE_KEY)) {
    const connectionId = textOf(row['连接编号'])
    const runtime = state.runtimes[connectionId]
    if (!runtime) continue
    const version = configVersionOf(row)
    if (version === runtime.effectiveConfigVersion) continue
    const at = nowIso()
    const keepBlocking = runtime.verdict === '隔离' || runtime.verdict === '待人工确认'
    state.runtimes[connectionId] = pushEvent(
      {
        ...runtime,
        effectiveConfigVersion: version,
        writeToken: runtime.writeToken + 1,
        successStreakIds: [],
        verdict: keepBlocking ? runtime.verdict : '未检查',
        verdictReason: keepBlocking
          ? `连接配置已变更（${runtime.effectiveConfigVersion} → ${version}），原「${runtime.verdict}」结论作废；新配置下重新检查前继续阻断`
          : `连接配置已变更（${runtime.effectiveConfigVersion} → ${version}），原检查证据不再参与当前资格`,
      },
      eventOf(
        connectionId,
        '配置变更',
        '连接配置变更',
        `配置版本 ${runtime.effectiveConfigVersion} → ${version}；历史检查保留为回看证据，需按新配置重新检查`,
        version,
        at,
      ),
    )
  }
  return state
}

function appliedChecks(runtime: ConnectionRuntime, version: string): ConnectionCheck[] {
  return runtime.checks.filter((check) => check.applied && check.configVersion === version)
}

function latestApplied(runtime: ConnectionRuntime, version: string): ConnectionCheck | undefined {
  const applied = appliedChecks(runtime, version)
  return applied[applied.length - 1]
}

/** 隔离位点之后的连续成功才算恢复门槛；隔离前的成功不能拿来“凑两次”。 */
function successesSinceIsolation(runtime: ConnectionRuntime, version: string): ConnectionCheck[] {
  const boundary = runtime.isolationBoundarySequence ?? 0
  return appliedChecks(runtime, version).filter(
    (check) => check.verdict === '可连接' && check.sequence > boundary,
  )
}

/** SYNC 与 MONI 共用的恢复证据视图。两处页面都只调用这一个函数。 */
export function recoveryEvidenceFor(connectionId: string): RecoveryEvidenceView | undefined {
  const state = loadState()
  const row = findSourceRow(connectionId)
  if (!row) return undefined
  const runtime = state.runtimes[connectionId]
  if (!runtime) return undefined
  const currentVersion = configVersionOf(row)
  const applied = appliedChecks(runtime, runtime.effectiveConfigVersion)
  const latest = applied[applied.length - 1]
  const successes = successesSinceIsolation(runtime, runtime.effectiveConfigVersion)
  const successIds = successes.slice(-REQUIRED_SUCCESS_STREAK).map((check) => check.id)
  const manualConfirmed = Boolean(
    runtime.manualConfirmation &&
      runtime.manualConfirmation.configVersion === runtime.effectiveConfigVersion,
  )
  // 隔离：必须在隔离位点之后连续两次成功；待人工确认：自动检查已定不了案，
  // 由人工基于最近一次写回的检查证据裁定（仍需填写说明）。
  const latestCheck = latest
  const recoveryEligible =
    runtime.verdict === '隔离'
      ? successes.length >= REQUIRED_SUCCESS_STREAK
      : runtime.verdict === '待人工确认'
        ? Boolean(latestCheck)
        : false
  const canStartSync = runtime.verdict === '可连接'

  let reason = ''
  if (runtime.verdict === '可连接') {
    reason = manualConfirmed
      ? `人工确认恢复后可连接（${formatTimestamp(runtime.manualConfirmation?.at)}，依据 ${runtime.manualConfirmation?.evidenceCheckIds.join('、')}）`
      : '当前配置版本下最新写回的检查结论为可连接，允许启动或续跑任务'
  } else if (runtime.verdict === '未检查') {
    reason = '当前配置版本还没有写回的检查结论，启动同步前必须先在数据源管理提交连接检查'
  } else if (runtime.verdict === '隔离') {
    if (recoveryEligible) {
      reason = `已有 ${successes.length} 次同一配置版本的可连接检查（${successIds.join('、')}），恢复资格满足，等待人工确认后可解除隔离`
    } else {
      reason = `隔离中：${runtime.verdictReason}；恢复需同一配置版本连续 ${REQUIRED_SUCCESS_STREAK} 次可连接检查（目前 ${successes.length}/${REQUIRED_SUCCESS_STREAK}）再经人工确认`
    }
  } else {
    reason = latestCheck
      ? `待人工确认：${runtime.verdictReason}；最近写回的 ${latestCheck.id} 已作为裁定依据（${formatTimestamp(latestCheck.finishedAt)}），人工填写说明后可确认恢复或继续隔离`
      : `待人工确认：${runtime.verdictReason}；还没有写回的检查，先提交连接检查再裁定`
  }

  const conflict = runtime.conflicts[runtime.conflicts.length - 1]
  const conflictSummary = conflict
    ? `${conflict.summary}；裁定规则：${conflict.rule}`
    : '没有相反结论需要裁定'

  return {
    connectionId,
    verdict: runtime.verdict,
    configVersion: currentVersion,
    effectiveConfigVersion: runtime.effectiveConfigVersion,
    lastCheckAt: runtime.lastCheckAt,
    requiredSuccesses: REQUIRED_SUCCESS_STREAK,
    successCount: successes.length,
    successCheckIds: successIds,
    recoveryEligible,
    canStartSync,
    reason,
    conflictSummary,
    manualNote: manualConfirmed ? runtime.manualConfirmation?.note : undefined,
    manualConfirmed,
    evidenceSource: '数据源管理 · 连接资格',
    latestCheckId: latest?.id,
    isolatedAt: runtime.isolatedAt,
    isolationReason: runtime.isolationReason,
  }
}

/** 同步任务的启动闸门：被隔离的源端不允许新任务，但已有运行记录不动。 */
export function launchGuardForLink(linkId: string): ConnectionLaunchGuard {
  const link = findLinkRow(linkId)
  if (!link) {
    return { ok: false, code: 'no-link', reason: `没有找到链路编号 ${linkId}，无法校验源端连接资格` }
  }
  const connectionId = textOf(link['源端连接'])
  if (!connectionId) {
    return { ok: false, code: 'no-source', reason: `链路 ${linkId} 没有填写源端连接，不能启动同步` }
  }
  const row = findSourceRow(connectionId)
  if (!row) {
    return {
      ok: false,
      code: 'no-connection',
      reason: `链路 ${linkId} 的源端连接 ${connectionId} 不在数据源管理中，先把连接登记进来再启动`,
    }
  }
  const evidence = recoveryEvidenceFor(connectionId)
  if (!evidence) {
    return { ok: false, code: 'no-connection', reason: `源端连接 ${connectionId} 缺少连接资格记录` }
  }
  if (evidence.configVersion !== evidence.effectiveConfigVersion) {
    return {
      ok: false,
      code: 'config-stale',
      reason: `源端连接 ${connectionId} 的配置已变更，旧结论失效，请先在数据源管理重新检查`,
      evidence,
    }
  }
  if (evidence.verdict === '未检查') {
    return {
      ok: false,
      code: 'unchecked',
      reason: `源端连接 ${connectionId} 还没提交过连接检查，按未检查阻断新任务；已有运行记录保留`,
      evidence,
    }
  }
  if (evidence.verdict === '隔离') {
    return {
      ok: false,
      code: 'isolated',
      reason: `源端连接 ${connectionId} 已隔离：${evidence.reason}；新同步任务被阻止，已有运行记录不删除`,
      evidence,
    }
  }
  if (evidence.verdict === '待人工确认') {
    return {
      ok: false,
      code: 'manual-pending',
      reason: `源端连接 ${connectionId} 待人工确认：${evidence.reason}；确认前不启动新任务`,
      evidence,
    }
  }
  return { ok: true, code: 'ok', reason: `源端连接 ${connectionId} 可连接，允许启动或续跑`, evidence }
}

function checkInputOf(row: EntryRow, probe: ProbeOutcome = '正常'): CheckInput {
  const connectionId = textOf(row['连接编号'])
  return {
    probe,
    connectionId,
    configVersion: configVersionOf(row),
    connectionType: textOf(row['连接类型']),
    endpoint: textOf(row['接入地址']),
    authMode: textOf(row['认证方式']),
    timeoutSeconds: textOf(row['超时秒数']),
    retryCount: textOf(row['重试次数']),
    syncLinks: listRows(SYNC_KEY)
      .filter((link) => textOf(link['源端连接']) === connectionId)
      .map<SyncLinkSnapshot>((link) => ({
        linkId: textOf(link['链路编号']),
        status: textOf(link.status),
        targetConnection: textOf(link['目标端连接']),
        syncMode: textOf(link['全量增量标识']),
      })),
  }
}

/** 第一步：冻结配置与链路快照。此时不产生结论，也不改连接资格。 */
export function beginCheck(
  connectionId: string,
  options: { actor?: string; probe?: ProbeOutcome } = {},
): CheckBeginOutcome {
  const actor = options.actor ?? ACTOR
  const state = syncConfigTokens(loadState())
  const row = findSourceRow(connectionId)
  if (!row) {
    return { ok: false, message: `没有找到连接编号 ${connectionId} 的数据源连接` }
  }
  const runtime = state.runtimes[connectionId] ?? runtimeFor(row, connectionId)
  const version = configVersionOf(row)
  const sequence = runtime.lastSequence + 1
  const startedAt = nowIso()
  const snapshot: CheckSnapshot = {
    runId: `CHK-${String(sequence).padStart(4, '0')}-${connectionId.replace(/[^0-9A-Za-z]/g, '').slice(-4)}-${Date.now().toString(36).slice(-3)}`,
    label: `CHK-${String(sequence).padStart(4, '0')}`,
    connectionId,
    startedAt,
    configVersion: version,
    token: runtime.writeToken,
    sequence,
    actor,
    input: checkInputOf(row, options.probe ?? '正常'),
  }
  state.pending[snapshot.runId] = { snapshot, startedAt }
  state.runtimes[connectionId] = { ...runtime, lastSequence: sequence }
  writeState(state)
  const evaluation = evaluateConnection(snapshot.input)
  return {
    ok: true,
    message: `已冻结 ${connectionId} 的配置快照（${version}），五项检查已出具证据（探测：${snapshot.input.probe}），等待写回`,
    runId: snapshot.runId,
    startedAt,
    verdict: evaluation.verdict,
    factors: evaluation.factors,
    reason: evaluation.reason,
  }
}

function conflictBetween(
  previous: ConnectionCheck,
  next: ConnectionCheck,
  rule: string,
  summary: string,
  winnerId: string,
): ConnectionConflict {
  return {
    at: next.finishedAt,
    previousId: previous.id,
    previousVerdict: previous.verdict,
    previousVersion: previous.configVersion,
    nextId: next.id,
    nextVerdict: next.verdict,
    nextVersion: next.configVersion,
    rule,
    summary,
    winnerId,
  }
}

/** 第二步：按冻结快照重新判定后写回，并处理配置变更 / 并发 / 优先级 / 恢复门槛。 */
export function commitCheck(runId: string, actor = ACTOR): CheckCommitOutcome {
  const state = syncConfigTokens(loadState())
  const pendingEntry = state.pending[runId]
  if (!pendingEntry) {
    return { ok: false, message: `检查 ${runId} 不存在或已写回，不能重复提交` }
  }
  const snapshot = pendingEntry.snapshot
  const row = findSourceRow(snapshot.connectionId)
  if (!row) {
    delete state.pending[runId]
    writeState(state)
    return { ok: false, message: `连接 ${snapshot.connectionId} 已不存在，检查作废` }
  }
  const runtime = state.runtimes[snapshot.connectionId] ?? runtimeFor(row, snapshot.connectionId)
  const currentVersion = configVersionOf(row)
  const finishedAt = nowIso()
  const evaluation = evaluateConnection(snapshot.input)

  const check: ConnectionCheck = {
    id: `${snapshot.label}-${snapshot.configVersion.slice(-4)}`,
    runId,
    connectionId: snapshot.connectionId,
    sequence: snapshot.sequence,
    configVersion: snapshot.configVersion,
    startedAt: snapshot.startedAt,
    finishedAt,
    actor,
    verdict: evaluation.verdict,
    factors: evaluation.factors,
    evidence: evaluation.evidence,
    reason: evaluation.reason,
    applied: false,
    adjudication: '',
    writeStatus: '已写回',
    writeStatusReason: '',
    snapshotToken: snapshot.token,
    snapshotSyncLinks: snapshot.input.syncLinks.map((link) => link.linkId),
  }

  let nextRuntime: ConnectionRuntime = runtime
  let writeStatus: CheckWriteStatus = '已写回'

  if (currentVersion !== snapshot.configVersion) {
    // 优先级一：配置在检查期间变更，冻结快照与当前配置不一致，旧结论不能算数。
    writeStatus = '未写回-配置变更'
    check.writeStatusReason = `检查启动时配置版本 ${snapshot.configVersion}，写回时已是 ${currentVersion}；冻结快照拒绝用新配置补算旧结论`
    check.adjudication = '结论作废，不参与当前连接资格'
  } else if (runtime.writeToken !== snapshot.token) {
    // 优先级二：人工隔离/恢复推进了写回令牌，自动结论不得覆盖人工决定。
    writeStatus = '未写回-人工裁定'
    check.writeStatusReason = `检查期间人工裁定已推进写回令牌（${snapshot.token} → ${runtime.writeToken}），自动结论不得覆盖人工决定`
    check.adjudication = '结论作废，人工裁定优先'
  } else if (snapshot.sequence < runtime.lastCommittedSequence) {
    // 优先级三：较晚启动的检查先写回，较早启动的检查后到，旧结论不得回写。
    writeStatus = '未写回-并发覆盖'
    check.writeStatusReason = `本次检查启动序号 ${snapshot.sequence} 早于已写回的最新检查（序号 ${runtime.lastCommittedSequence}，${runtime.lastCommittedRunId}）；旧结论不得覆盖新结论`
    check.adjudication = `保留为回看证据，不改变当前资格（胜出：${runtime.lastCommittedRunId}）`
    const winner = runtime.checks.find((item) => item.runId === runtime.lastCommittedRunId)
    if (winner && winner.verdict !== evaluation.verdict) {
      nextRuntime = {
        ...nextRuntime,
        conflicts: [
          ...nextRuntime.conflicts,
          conflictBetween(
            winner,
            check,
            '较晚启动的检查优先；旧启动序号的回写一律不采纳',
            `${winner.id}（${winner.verdict}，配置 ${winner.configVersion}，写出于 ${formatTimestamp(winner.finishedAt)}，启动序号 ${winner.sequence}）先写回；${check.id}（${evaluation.verdict}，启动序号 ${snapshot.sequence}）后到，按旧结论处理`,
            winner.id,
          ),
        ],
      }
    }
  } else {
    check.applied = true
    check.adjudication = '结论写入连接资格'
    const previous = latestApplied(runtime, snapshot.configVersion)
    const successIds = successesSinceIsolation(runtime, snapshot.configVersion).map((item) => item.id)
    const streak = evaluation.verdict === '可连接' ? [...successIds, check.id] : []
    // 注意：写回令牌只由配置变更与人工裁定推进。检查之间用启动序号排序，
    // 若在这里也推进令牌，会把“较早启动的旧结论”误判成人工裁定而绕开并发裁定分支。
    nextRuntime = {
      ...nextRuntime,
      lastCommittedSequence: snapshot.sequence,
      lastCommittedRunId: runId,
      lastCheckAt: finishedAt,
      checks: [...runtime.checks, check],
      successStreakIds: streak.slice(-REQUIRED_SUCCESS_STREAK),
    }

    if (previous && previous.verdict !== evaluation.verdict) {
      nextRuntime = {
        ...nextRuntime,
        conflicts: [
          ...nextRuntime.conflicts,
          conflictBetween(
            previous,
            check,
            '配置版本一致时，较晚启动且先写回的检查优先；其余相反结论只留痕不覆盖',
            `${previous.id}（${previous.verdict}，写出于 ${formatTimestamp(previous.finishedAt)}，启动序号 ${previous.sequence}）→ ${check.id}（${evaluation.verdict}，启动序号 ${snapshot.sequence}）；按较晚启动优先采纳后者`,
            check.id,
          ),
        ],
      }
    }

    const manualValid = Boolean(
      runtime.manualConfirmation && runtime.manualConfirmation.configVersion === snapshot.configVersion,
    )

    if (evaluation.verdict === '隔离') {
      nextRuntime = pushEvent(
        {
          ...nextRuntime,
          verdict: '隔离',
          verdictReason: evaluation.reason,
          effectiveConfigVersion: snapshot.configVersion,
          isolatedAt: finishedAt,
          isolationReason: evaluation.reason,
          isolationBoundarySequence: snapshot.sequence,
          successStreakIds: [],
          manualConfirmation: manualValid ? runtime.manualConfirmation : undefined,
        },
        eventOf(
          snapshot.connectionId,
          '隔离',
          `检查 ${check.id} 判定隔离`,
          `${evaluation.reason}；新同步任务被阻止，已有运行记录保留`,
          snapshot.configVersion,
          finishedAt,
        ),
      )
    } else if (evaluation.verdict === '待人工确认') {
      nextRuntime = pushEvent(
        {
          ...nextRuntime,
          verdict: '待人工确认',
          verdictReason: evaluation.reason,
          effectiveConfigVersion: snapshot.configVersion,
          successStreakIds: [],
          manualConfirmation: manualValid ? runtime.manualConfirmation : undefined,
        },
        eventOf(
          snapshot.connectionId,
          '待人工确认',
          `检查 ${check.id} 转人工确认`,
          `${evaluation.reason}；确认前不启动新任务`,
          snapshot.configVersion,
          finishedAt,
        ),
      )
    } else if (manualValid) {
      nextRuntime = pushEvent(
        {
          ...nextRuntime,
          verdict: '可连接',
          verdictReason: `人工确认恢复（${runtime.manualConfirmation?.evidenceCheckIds.join('、') ?? '—'}）后由检查 ${check.id} 复核通过`,
          effectiveConfigVersion: snapshot.configVersion,
          isolatedAt: undefined,
          isolationReason: undefined,
        },
        eventOf(
          snapshot.connectionId,
          '检查写回',
          `检查 ${check.id} 复核通过`,
          '人工确认恢复依据仍然有效，检查结论为可连接',
          snapshot.configVersion,
          finishedAt,
        ),
      )
    } else if (nextRuntime.verdict === '可连接') {
      // 已可连接的连接，后续检查维持即可；不做升级。
      nextRuntime = {
        ...nextRuntime,
        verdict: '可连接',
        verdictReason: evaluation.reason,
        effectiveConfigVersion: snapshot.configVersion,
      }
    } else if (streak.length >= REQUIRED_SUCCESS_STREAK) {
      // 连续两次成功只取得恢复资格，仍停在待人工确认，不能自动解除隔离。
      nextRuntime = pushEvent(
        {
          ...nextRuntime,
          verdict: '待人工确认',
          verdictReason: `同一配置版本、隔离位点之后已连续 ${streak.length} 次检查可连接（${streak.join('、')}），恢复资格已满足，等待人工确认恢复`,
          effectiveConfigVersion: snapshot.configVersion,
        },
        eventOf(
          snapshot.connectionId,
          '待人工确认',
          `检查 ${check.id} 满足恢复门槛`,
          `连续 ${streak.length} 次可连接，转人工确认；单次成功不解除隔离`,
          snapshot.configVersion,
          finishedAt,
        ),
      )
    } else {
      nextRuntime = {
        ...nextRuntime,
        verdict: nextRuntime.verdict === '未检查' ? '待人工确认' : nextRuntime.verdict,
        verdictReason: `检查 ${check.id} 可连接，但恢复门槛要求同一配置版本连续 ${REQUIRED_SUCCESS_STREAK} 次可连接检查（目前 ${streak.length}/${REQUIRED_SUCCESS_STREAK}）；单次成功不足以免除隔离`,
        effectiveConfigVersion: snapshot.configVersion,
      }
    }
    nextRuntime = pushEvent(
      nextRuntime,
      eventOf(
        snapshot.connectionId,
        '检查写回',
        `检查 ${check.id} 写回：${evaluation.verdict}`,
        evaluation.reason,
        snapshot.configVersion,
        finishedAt,
      ),
    )
  }

  if (!check.applied) {
    // 未写回的检查完整保留，供回看核对。
    check.writeStatus = writeStatus
    nextRuntime = {
      ...nextRuntime,
      checks: [...nextRuntime.checks, check],
    }
    nextRuntime = pushEvent(
      nextRuntime,
      eventOf(
        snapshot.connectionId,
        '检查未写回',
        `检查 ${check.id} 未写回：${writeStatus}`,
        check.writeStatusReason,
        snapshot.configVersion,
        finishedAt,
      ),
    )
  }

  state.runtimes[snapshot.connectionId] = nextRuntime
  delete state.pending[runId]
  writeState(state)
  syncSourceStatus(nextRuntime)

  return {
    ok: check.applied,
    message: check.applied
      ? `检查 ${check.id} 已写回，连接资格为「${nextRuntime.verdict}」`
      : `检查 ${check.id} ${writeStatus}：${check.writeStatusReason}`,
    runId,
    check,
    writeStatus,
    verdict: evaluation.verdict,
    factors: evaluation.factors,
    reason: evaluation.reason,
    evidence: recoveryEvidenceFor(snapshot.connectionId),
  }
}

export function pendingChecksFor(connectionId: string): CheckSnapshot[] {
  return Object.values(readState().pending)
    .filter((entry) => entry.snapshot.connectionId === connectionId)
    .map((entry) => entry.snapshot)
    .sort((a, b) => b.sequence - a.sequence)
}

/** 人工裁定：恢复必须基于同一配置版本下、隔离位点之后已写回的双次成功检查。 */
export function confirmManualRecovery(connectionId: string, note: string, actor = ACTOR): ManualOutcome {
  const state = syncConfigTokens(loadState())
  const row = findSourceRow(connectionId)
  if (!row) {
    return { ok: false, message: `没有找到连接编号 ${connectionId} 的数据源连接` }
  }
  const runtime = state.runtimes[connectionId] ?? runtimeFor(row, connectionId)
  const version = configVersionOf(row)
  const trimmedNote = note.trim()
  if (version !== runtime.effectiveConfigVersion) {
    return { ok: false, message: `连接 ${connectionId} 的配置在检查后变更，请先按新配置重新提交连接检查再裁定` }
  }
  if (runtime.verdict === '可连接') {
    return { ok: false, message: `连接 ${connectionId} 已经是可连接，无需人工确认恢复` }
  }
  if (!trimmedNote) {
    return { ok: false, message: '人工确认恢复必须填写确认说明，说明本身也是回看证据' }
  }
  const appliedNow = appliedChecks(runtime, version)
  const successes = successesSinceIsolation(runtime, version)
  let evidenceIds: string[] = []
  if (runtime.verdict === '隔离') {
    if (successes.length < REQUIRED_SUCCESS_STREAK) {
      return {
        ok: false,
        message: `连接 ${connectionId} 隔离位点之后只有 ${successes.length} 次可连接检查，不足恢复门槛（同一配置版本连续 ${REQUIRED_SUCCESS_STREAK} 次）`,
      }
    }
    evidenceIds = successes.slice(-REQUIRED_SUCCESS_STREAK).map((check) => check.id)
  } else {
    // 待人工确认：自动检查无法定案，按最近一次写回的检查作为裁定依据。
    const latestCheck = appliedNow[appliedNow.length - 1]
    if (!latestCheck) {
      return { ok: false, message: `连接 ${connectionId} 还没有写回的检查，人工裁定没有依据` }
    }
    evidenceIds = [latestCheck.id]
  }
  const at = nowIso()
  const nextRuntime = pushEvent(
    {
      ...runtime,
      verdict: '可连接',
      verdictReason: `人工确认恢复：${trimmedNote}`,
      writeToken: runtime.writeToken + 1,
      successStreakIds: evidenceIds,
      manualConfirmation: {
        at,
        actor,
        note: trimmedNote,
        decision: '可连接',
        configVersion: version,
        evidenceCheckIds: evidenceIds,
      },
      isolatedAt: undefined,
      isolationReason: undefined,
    },
    eventOf(
      connectionId,
      '恢复',
      '人工确认恢复',
      `依据 ${evidenceIds.join('、')}（配置版本 ${version}）；说明：${trimmedNote}`,
      version,
      at,
    ),
  )
  state.runtimes[connectionId] = nextRuntime
  writeState(state)
  syncSourceStatus(nextRuntime)
  return {
    ok: true,
    message: `连接 ${connectionId} 已人工确认恢复为可连接；SYNC 与 MONI 引用同一份证据`,
    evidence: recoveryEvidenceFor(connectionId),
  }
}

export function isolateManually(connectionId: string, note: string, actor = ACTOR): ManualOutcome {
  const state = syncConfigTokens(loadState())
  const row = findSourceRow(connectionId)
  if (!row) {
    return { ok: false, message: `没有找到连接编号 ${connectionId} 的数据源连接` }
  }
  const runtime = state.runtimes[connectionId] ?? runtimeFor(row, connectionId)
  const version = configVersionOf(row)
  const at = nowIso()
  const trimmedNote = note.trim() || '维护者手动隔离，等待重新检查'
  const nextRuntime = pushEvent(
    {
      ...runtime,
      verdict: '隔离',
      verdictReason: `人工隔离：${trimmedNote}`,
      effectiveConfigVersion: version,
      writeToken: runtime.writeToken + 1,
      isolatedAt: at,
      isolationReason: trimmedNote,
      isolationBoundarySequence: runtime.lastSequence,
      successStreakIds: [],
      manualConfirmation: undefined,
    },
    eventOf(connectionId, '隔离', '人工隔离', `${trimmedNote}；操作人：${actor}`, version, at),
  )
  state.runtimes[connectionId] = nextRuntime
  writeState(state)
  syncSourceStatus(nextRuntime)
  return {
    ok: true,
    message: `连接 ${connectionId} 已人工隔离：${trimmedNote}；新同步任务被阻止，已有运行记录保留`,
    evidence: recoveryEvidenceFor(connectionId),
  }
}

/** 调整连接配置：版本随字段变化，旧检查证据自动失效。 */
export function updateSourceConfig(
  connectionId: string,
  patch: Partial<Pick<SourceRowView, '认证方式' | '超时秒数' | '重试次数' | '接入地址'>>,
  actor = ACTOR,
): ManualOutcome {
  const rows = listRows(SOURCE_KEY)
  const index = rows.findIndex((row) => textOf(row['连接编号']) === connectionId)
  if (index < 0) {
    return { ok: false, message: `没有找到连接编号 ${connectionId} 的数据源连接` }
  }
  const before = configVersionOf(rows[index])
  const updated: EntryRow = { ...rows[index] }
  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined) updated[field] = value
  }
  const after = configVersionOf(updated)
  if (before === after) {
    return { ok: false, message: `连接 ${connectionId} 的配置没有变化，配置版本仍为 ${before}` }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(SOURCE_KEY, next)
  const state = syncConfigTokens(loadState())
  const runtime = state.runtimes[connectionId] ?? runtimeFor(updated, connectionId)
  // syncConfigTokens 已经记录了配置变更事件，这里只补充操作人，避免出现两条重复事件。
  state.runtimes[connectionId] = {
    ...runtime,
    events: runtime.events.map((event, pos) =>
      pos === 0 && event.type === '配置变更'
        ? { ...event, detail: `${event.detail}；操作人：${actor}` }
        : event,
    ),
  }
  writeState(state)
  return {
    ok: true,
    message: `连接 ${connectionId} 配置已更新（${before} → ${after}），需重新提交连接检查`,
    evidence: recoveryEvidenceFor(connectionId),
  }
}

/** 登记新连接：从“待连通 / 未检查”开始，必须提交检查后才能参与同步。 */
export function createSource(input: CreateSourceInput, actor = ACTOR): ManualOutcome {
  const rows = listRows(SOURCE_KEY)
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const connectionId = `SOUR-${String(nextId).padStart(4, '0')}`
  const missing = (Object.entries(input) as Array<[string, string]>)
    .filter(([, value]) => !value.trim())
    .map(([field]) => field)
  if (missing.length > 0) {
    return { ok: false, message: `登记失败：${missing.join('、')} 不能为空，连接资格需要完整的配置证据` }
  }
  const entry: EntryRow = {
    id: nextId,
    status: '待连通',
    pending: true,
    abnormal: false,
    连接编号: connectionId,
    连接类型: input.连接类型.trim(),
    接入地址: input.接入地址.trim(),
    认证方式: input.认证方式.trim(),
    连接池配置: '最小 2 / 最大 8 / 空闲回收 60s',
    超时秒数: input.超时秒数.trim(),
    重试次数: input.重试次数.trim(),
    负责人: input.负责人.trim(),
  }
  saveRows(SOURCE_KEY, [...rows, entry])
  const state = readState()
  state.runtimes[connectionId] = runtimeFor(entry, connectionId)
  writeState(state)
  return {
    ok: true,
    message: `已登记 ${connectionId}（操作人：${actor}）；当前未检查，提交连接检查前不会放行同步`,
    evidence: recoveryEvidenceFor(connectionId),
  }
}

/** 同步链路状态切换；启动/续跑必须走 startSync 的连接闸门。 */
export function setLinkStatus(linkId: string, status: string): ManualOutcome {
  const rows = listRows(SYNC_KEY)
  const index = rows.findIndex((row) => textOf(row['链路编号']) === linkId)
  if (index < 0) {
    return { ok: false, message: `没有找到链路编号 ${linkId}` }
  }
  const next = [...rows]
  next[index] = { ...rows[index], status, pending: status === '待校验', abnormal: status === '已中断' }
  saveRows(SYNC_KEY, next)
  return { ok: true, message: `链路 ${linkId} 状态已改为「${status}」` }
}

/* ---------- 列表视图:数据源 / 同步 / 监控 ---------- */

function matchesFilters(row: Record<string, unknown>, filters: Record<string, string>): boolean {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) return true
  return pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim()))
}

export function listSourceRows(filters: Record<string, string> = {}): SourceListResult {
  const state = loadState()
  const all = listRows(SOURCE_KEY)
  const items = all
    .map<SourceRowView>((row) => {
      const connectionId = textOf(row['连接编号'])
      const runtime = state.runtimes[connectionId]
      const applied = appliedChecks(runtime, runtime.effectiveConfigVersion)
      const latest = applied[applied.length - 1]
      return {
        id: Number(row.id),
        connectionId,
        连接编号: textOf(row['连接编号']),
        连接类型: textOf(row['连接类型']),
        接入地址: textOf(row['接入地址']),
        认证方式: textOf(row['认证方式']),
        连接池配置: textOf(row['连接池配置']),
        超时秒数: textOf(row['超时秒数']),
        重试次数: textOf(row['重试次数']),
        负责人: textOf(row['负责人']),
        status: textOf(row.status),
        configVersion: configVersionOf(row),
        eligibility: runtime.verdict,
        lastCheckAt: runtime.lastCheckAt,
        evidenceSummary: latest
          ? `${latest.id}：${latest.verdict}（${formatTimestamp(latest.finishedAt)}）`
          : runtime.verdict === '未检查'
            ? '尚无写回检查'
            : '历史状态带入，无检查记录',
        pendingChecks: Object.values(state.pending).filter(
          (entry) => entry.snapshot.connectionId === connectionId,
        ).length,
      }
    })
    .filter((row) => matchesFilters(row, filters))
  return { items, total: items.length, allTotal: all.length }
}

export function reviewSource(connectionId: string): SourceReview | undefined {
  const state = loadState()
  const row = listSourceRows({}).items.find((item) => item.connectionId === connectionId)
  if (!row) return undefined
  const runtime = state.runtimes[connectionId]
  const applied = appliedChecks(runtime, runtime.effectiveConfigVersion)
  return {
    row,
    evidence: recoveryEvidenceFor(connectionId)!,
    runtime,
    latestApplied: applied[applied.length - 1],
    pendingChecks: pendingChecksFor(connectionId).length,
  }
}

export function listSyncLinks(filters: Record<string, string> = {}): SyncLinkListResult {
  const all = listRows(SYNC_KEY)
  const items = all
    .map<SyncLinkView>((row) => {
      const linkId = textOf(row['链路编号'])
      const guard = launchGuardForLink(linkId)
      const runs = runsOf(linkId)
      const lastRun = runs[runs.length - 1]
      const plan = resumePlanForLink(linkId)
      return {
        id: Number(row.id),
        linkId,
        sourceConnection: textOf(row['源端连接']),
        targetConnection: textOf(row['目标端连接']),
        tables: textOf(row['同步表列表']),
        syncMode: textOf(row['全量增量标识']),
        frequency: textOf(row['同步频率']),
        latencyThreshold: textOf(row['延迟阈值']),
        owner: textOf(row['告警接收人']),
        status: textOf(row.status),
        guard,
        evidence: guard.evidence,
        lastRun,
        runCount: runs.length,
        resumePlan: plan,
      }
    })
    .filter((row) =>
      matchesFilters(
        { 链路编号: row.linkId, 源端连接: row.sourceConnection, 目标端连接: row.targetConnection },
        filters,
      ),
    )
  return { items, total: items.length, allTotal: all.length }
}

export function listMonitorRows(filters: Record<string, string> = {}): MonitorListResult {
  const all = listRows(MONITOR_KEY)
  const items = all
    .map<MonitorRowView>((row) => {
      const linkedLink = textOf(row['关联任务'])
      const link = findLinkRow(linkedLink)
      const guard: ConnectionLaunchGuard = link
        ? launchGuardForLink(linkedLink)
        : {
            ok: false,
            code: 'no-link',
            reason: `监控配置关联的任务 ${linkedLink} 不在数据同步里，无法引用连接恢复证据`,
          }
      const sourceConnection = link ? textOf(link['源端连接']) : ''
      const linkFound = Boolean(link)
      let explanation = ''
      if (!linkFound) {
        explanation = `监控配置关联的任务 ${linkedLink} 不在数据同步里，无法引用连接恢复证据；先确认任务编号或登记同步链路`
      } else if (guard.ok) {
        explanation = `源端 ${sourceConnection} 可连接，监控按正常阈值观察；恢复证据与数据同步引用同一份记录`
      } else {
        explanation = `源端 ${sourceConnection} 当前「${guard.evidence?.verdict ?? '无证据'}」：${guard.reason}`
      }
      return {
        id: Number(row.id),
        configId: textOf(row['配置编号']),
        linkedLink,
        metric: textOf(row['监控指标']),
        threshold: textOf(row['告警阈值']),
        level: textOf(row['告警级别']),
        silenceMinutes: textOf(row['静默分钟']),
        channel: textOf(row['通知渠道']),
        recoveryCondition: textOf(row['恢复条件']),
        status: textOf(row.status),
        linkFound,
        sourceConnection,
        guard,
        evidence: guard.evidence,
        explanation,
      }
    })
    .filter((row) =>
      matchesFilters(
        { 配置编号: row.configId, 关联任务: row.linkedLink, 监控指标: row.metric },
        filters,
      ),
    )
  return { items, total: items.length, allTotal: all.length }
}

/* ---------- 同步运行记录与续跑 ---------- */

function runsOf(linkId: string): SyncRunRecord[] {
  return readState().runs.filter((run) => run.linkId === linkId)
}

export function runsForLink(linkId: string): SyncRunRecord[] {
  return runsOf(linkId)
}

function appendRun(run: SyncRunRecord): void {
  const state = readState()
  writeState({ ...state, runs: [...state.runs, run] })
}

function latestFailure(runs: SyncRunRecord[]): SyncRunRecord | undefined {
  const failed = runs.filter((run) => run.status === '失败' || run.status === '中断')
  return failed[failed.length - 1]
}

function latestWatermark(runs: SyncRunRecord[]): number {
  if (runs.length === 0) return 0
  return runs.reduce((max, run) => Math.max(max, run.nextResumeOffset), 0)
}

/** 续跑计划：从失败位点继续，不回到 0；同时校验源端是否已恢复。 */
export function resumePlanForLink(linkId: string): ResumePlan {
  const link = findLinkRow(linkId)
  if (!link) {
    return {
      ok: false,
      code: 'no-runs',
      reason: `没有找到链路 ${linkId}，无法生成续跑计划`,
      fromOffset: 0,
      consumedBefore: 0,
      replayRows: 0,
    }
  }
  const runs = runsOf(linkId)
  const failed = latestFailure(runs)
  const guard = launchGuardForLink(linkId)
  if (runs.length === 0) {
    return {
      ok: false,
      code: 'no-runs',
      reason: `链路 ${linkId} 还没有运行记录，启动同步会从水位 0 开始，不存在续跑`,
      fromOffset: 0,
      consumedBefore: 0,
      replayRows: 0,
      guard,
      evidence: guard.evidence,
    }
  }
  if (!failed) {
    const last = runs[runs.length - 1]
    return {
      ok: false,
      code: 'no-failure',
      reason: `链路 ${linkId} 最近一次运行是「${last.status}」，没有可续跑的失败点；下一次运行从水位 ${last.nextResumeOffset} 开始`,
      fromOffset: last.nextResumeOffset,
      consumedBefore: last.nextResumeOffset,
      replayRows: 0,
      guard,
      evidence: guard.evidence,
    }
  }
  const failureOffset = failed.checkpointEnd
  return {
    ok: guard.ok,
    code: guard.ok ? 'ok' : 'source-not-recovered',
    reason: guard.ok
      ? `从失败位点 ${failureOffset} 续跑：失败运行 ${failed.id} 已消费 ${failed.consumedRows} 行，续跑只消费偏移 ${failureOffset} 之后的数据，不重复消费前 ${failureOffset} 行`
      : `失败位点 ${failureOffset} 已保留，但源端还不满足续跑条件：${guard.reason}`,
    fromOffset: failureOffset,
    consumedBefore: failureOffset,
    replayRows: 0,
    failedRun: failed,
    guard,
    evidence: guard.evidence,
  }
}

/** 启动/续跑同步：先过连接闸门，再从失败位点续跑。已有运行记录只追加不删除。 */
export function startSync(
  linkId: string,
  options: { resume: boolean; totalRows?: number } = { resume: false },
): SyncRunOutcome {
  const guard = launchGuardForLink(linkId)
  const link = findLinkRow(linkId)
  if (!link) {
    return { ok: false, message: `没有找到链路 ${linkId}`, code: 'link-not-found', guard }
  }
  if (!guard.ok) {
    return { ok: false, message: guard.reason, code: guard.code, guard }
  }
  const runs = runsOf(linkId)
  const failed = latestFailure(runs)
  if (options.resume && !failed) {
    const plan = resumePlanForLink(linkId)
    return { ok: false, message: plan.reason, code: plan.code, plan, guard }
  }
  const fromOffset = options.resume && failed ? failed.checkpointEnd : latestWatermark(runs)
  const totalRows = Math.max(options.totalRows ?? fromOffset + 480, fromOffset + 1)
  const consumed = Math.max(totalRows - fromOffset, 0)
  const now = nowIso()
  const run: SyncRunRecord = {
    id: `RUN-${String(runs.length + 1).padStart(4, '0')}-${linkId.slice(-4)}`,
    linkId,
    attempt: runs.length + 1,
    status: '成功',
    startedAt: now,
    finishedAt: now,
    checkpointStart: fromOffset,
    checkpointEnd: totalRows,
    consumedRows: consumed,
    nextResumeOffset: totalRows,
    sourceConfigVersion: guard.evidence?.configVersion ?? '',
    note: options.resume
      ? `从失败位点 ${fromOffset} 续跑，消费 ${consumed} 行；未重复消费前 ${fromOffset} 行`
      : `从水位 ${fromOffset} 启动，消费 ${consumed} 行`,
  }
  appendRun(run)
  setLinkStatus(linkId, '运行中')
  return { ok: true, message: run.note, run, plan: resumePlanForLink(linkId), guard }
}

/** 模拟一次运行失败：失败位点固化，供后续续跑验证。 */
export function failRun(linkId: string, atOffset: number): SyncRunOutcome {
  const link = findLinkRow(linkId)
  if (!link) {
    return { ok: false, message: `没有找到链路 ${linkId}`, code: 'link-not-found' }
  }
  const guard = launchGuardForLink(linkId)
  const runs = runsOf(linkId)
  const from = latestWatermark(runs)
  const offset = Math.max(Math.floor(atOffset), from)
  const now = nowIso()
  const run: SyncRunRecord = {
    id: `RUN-${String(runs.length + 1).padStart(4, '0')}-${linkId.slice(-4)}`,
    linkId,
    attempt: runs.length + 1,
    status: '失败',
    startedAt: now,
    finishedAt: now,
    checkpointStart: from,
    checkpointEnd: offset,
    consumedRows: offset - from,
    failureReason: `模拟失败：偏移 ${offset} 处源端不可读`,
    nextResumeOffset: offset,
    sourceConfigVersion: guard.evidence?.configVersion ?? '',
    note: `失败位点 ${offset} 已固化，连接恢复后从该点续跑`,
  }
  appendRun(run)
  setLinkStatus(linkId, '已中断')
  return { ok: true, message: run.note, run, plan: resumePlanForLink(linkId) }
}

export function resetConnections(): void {
  // 一并清掉连接域证据与运行记录，避免示例行换了而检查结论还留在旧版本。
  resetRows(SOURCE_KEY)
  resetRows(SYNC_KEY)
  resetRows(MONITOR_KEY)
  session.state = null
  seedPendingState = true
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(STATE_KEY)
  }
  // 重新播种示例运行记录（此时源端行已恢复为示例数据）。
  writeState(readState())
}

export { ACTOR }
