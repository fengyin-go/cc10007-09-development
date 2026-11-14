<template>
  <section class="page" data-module="source">
    <header class="page-head">
      <div>
        <h2>数据源管理</h2>
        <p class="page-desc">
          连接资格以这里为准：提交连接检查后按连接类型、认证方式、超时、重试与 SYNC 链路出具证据，
          再把「可连接 / 隔离 / 待人工确认」写回；隔离只阻止新同步任务，已有运行记录保留。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleCreate">
          {{ creating ? '收起登记表单' : '登记数据源连接' }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出数据源管理清单</button>
        <button class="btn ghost" type="button" @click="resetAll">重置连接证据</button>
      </div>
    </header>

    <form v-if="creating" class="inline-form" @submit.prevent="submitCreate">
      <label v-for="field in createFields" :key="field.key" class="filter-item">
        <span>{{ field.label }}</span>
        <input v-model="createDraft[field.key]" :placeholder="field.placeholder" />
      </label>
      <button class="btn primary" type="submit">提交登记</button>
      <span class="form-hint">登记后为「未检查」，提交连接检查前不会放行同步</span>
    </form>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <p v-if="banner" class="banner" :class="bannerTone">{{ banner }}</p>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>配置版本</th>
          <th>连接资格</th>
          <th>最近证据</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="row.connectionId">
          <tr :class="{ 'row-focus': focus === row.connectionId }">
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td class="mono">{{ row.configVersion }}</td>
            <td>
              <span class="verdict-chip" :class="`verdict-${toneOf(row.eligibility)}`">
                {{ row.eligibility }}
              </span>
              <span v-if="row.pendingChecks" class="pending-chip">待写回 {{ row.pendingChecks }}</span>
            </td>
            <td>{{ row.evidenceSummary }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="submitCheck(row)">
                {{ row.eligibility === '未检查' ? '提交连接检查' : '重新检查' }}
              </button>
              <button
                v-for="check in pendingFor(row.connectionId)"
                :key="check.runId"
                class="link"
                type="button"
                @click="writeBack(check.runId)"
              >
                写回 {{ check.label }}
              </button>
              <button class="link" type="button" @click="openReview(row.connectionId)">回看证据</button>
              <button class="link" type="button" @click="openManual(row.connectionId)">人工裁定</button>
            </td>
          </tr>
          <tr v-if="focus === row.connectionId" class="focus-row">
            <td :colspan="columns.length + 4">
              <div v-if="review" class="review-block">
                <RecoveryEvidencePanel :evidence="review.evidence" />
                <div class="review-grid">
                  <section>
                    <h4>检查时间线（含未写回结论）</h4>
                    <p v-if="!review.runtime.checks.length" class="muted-text">
                      当前配置版本还没有检查记录：未检查不代表可连接，提交检查后才会产生证据。
                    </p>
                    <ul v-else class="timeline">
                      <li
                        v-for="check in [...review.runtime.checks].reverse()"
                        :key="check.id"
                        :class="`write-${check.writeStatus === '已写回' ? 'ok' : 'bad'}`"
                      >
                        <span class="mono">{{ check.id }}</span>
                        <span class="verdict-chip" :class="`verdict-${toneOf(check.verdict)}`">{{ check.verdict }}</span>
                        <span class="muted-text">
                          启动 {{ formatTimestamp(check.startedAt) }} · 写回 {{ formatTimestamp(check.finishedAt) }} ·
                          配置 {{ check.configVersion }} · 序号 {{ check.sequence }}
                        </span>
                        <div class="detail-line">
                          裁定：{{ check.adjudication }}
                          <span v-if="check.writeStatus !== '已写回'" class="error-text">
                            （{{ check.writeStatus }}：{{ check.writeStatusReason }}）
                          </span>
                        </div>
                        <div class="factor-list">
                          <span
                            v-for="factor in check.factors"
                            :key="factor.key"
                            class="factor"
                            :class="`factor-${outcomeTone(factor.outcome)}`"
                            :title="factor.detail"
                          >
                            {{ factor.label }} {{ factor.value }} · {{ factor.outcome }}
                          </span>
                        </div>
                      </li>
                    </ul>
                  </section>
                  <section>
                    <h4>事件回看</h4>
                    <p v-if="!review.runtime.events.length" class="muted-text">还没有事件记录。</p>
                    <ul v-else class="timeline">
                      <li v-for="event in review.runtime.events" :key="event.id">
                        <strong>{{ event.type }}</strong>
                        <span class="muted-text">{{ formatTimestamp(event.at) }} · 配置 {{ event.configVersion }}</span>
                        <div class="detail-line">{{ event.title }}：{{ event.detail }}</div>
                      </li>
                    </ul>
                    <h4>相反结论裁定</h4>
                    <p v-if="!review.runtime.conflicts.length" class="muted-text">没有相反结论需要裁定。</p>
                    <ul v-else class="timeline">
                      <li v-for="(conflict, index) in review.runtime.conflicts" :key="index">
                        <span class="muted-text">{{ formatTimestamp(conflict.at) }}</span>
                        <div class="detail-line">
                          {{ conflict.summary }}
                        </div>
                        <div class="detail-line">胜出：<span class="mono">{{ conflict.winnerId }}</span></div>
                      </li>
                    </ul>
                  </section>
                </div>
                <form
                  v-if="manualOpen === row.connectionId"
                  class="inline-form"
                  @submit.prevent="submitManual(row.connectionId)"
                >
                  <label class="filter-item wide">
                    <span>人工裁定说明（恢复必须写说明，说明本身是证据）</span>
                    <input
                      v-model="manualNote"
                      placeholder="例如：已核对 Kerberos 票据更新，双次检查通过"
                    />
                  </label>
                  <button
                    class="btn primary"
                    type="submit"
                    :disabled="!review.evidence.recoveryEligible"
                  >
                    确认恢复
                  </button>
                  <button class="btn" type="button" @click="submitIsolate(row.connectionId)">人工隔离</button>
                  <span v-if="!review.evidence.recoveryEligible" class="form-hint">
                    恢复资格未满足：{{ review.evidence.reason }}
                  </span>
                  <span v-else-if="review.evidence.verdict === '待人工确认'" class="form-hint">
                    待人工确认由维护者基于最近一次写回的检查裁定；隔离态则要求隔离位点之后连续两次可连接。
                  </span>
                </form>
                <div class="config-editor">
                  <label class="filter-item">
                    <span>调整认证方式（触发配置版本变更，旧证据失效）</span>
                    <select v-model="configDraft.auth">
                      <option value="">不修改</option>
                      <option v-for="option in authOptions" :key="option" :value="option">{{ option }}</option>
                    </select>
                  </label>
                  <label class="filter-item">
                    <span>超时秒数</span>
                    <input v-model="configDraft.timeout" placeholder="如 30" />
                  </label>
                  <label class="filter-item">
                    <span>重试次数</span>
                    <input v-model="configDraft.retry" placeholder="如 3" />
                  </label>
                  <button class="btn" type="button" @click="submitConfig(row.connectionId)">保存配置</button>
                </div>
              </div>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">
            {{ allTotal === 0 ? '还没有登记数据源连接，先点右上角登记' : '没有命中数据源连接，按当前条件清空检索词或重置条件再试' }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据源连接记录（全部 {{ allTotal }} 条）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <p class="foot-note">
      颜色含义：可连接 = 允许新任务；隔离 = 阻止新任务但保留运行记录；待人工确认 = 自动检查无法定案，等人工裁定。
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  beginCheck,
  commitCheck,
  confirmManualRecovery,
  createSource,
  isolateManually,
  updateSourceConfig,
  listSourceRows,
  pendingChecksFor,
  resetConnections,
  reviewSource,
} from '@/api/connection-service'
import RecoveryEvidencePanel from '@/components/RecoveryEvidencePanel.vue'
import { downloadEntries } from '@/api/local-service'
import { formatTimestamp } from '@/data/connection-config'
import type {
  CheckSnapshot,
  ConnectionEligibility,
  CreateSourceInput,
  SourceReview,
  SourceRowView,
} from '@/data/connection-types'

const route = useRoute()
const meta = { key: 'source', name: '数据源管理', entity: '数据源连接' }
const columns = ['连接编号', '连接类型', '接入地址', '认证方式', '超时秒数', '重试次数', '负责人'] as const
const filterFields = ['连接编号', '连接类型', '接入地址']
const rows = ref<SourceRowView[]>([])
const total = ref(0)
const allTotal = ref(0)
const errorMessage = ref('')
const banner = ref('')
const bannerTone = ref<'ok' | 'bad' | 'warn'>('ok')
const filters = ref<Record<string, string>>({})
const focus = ref('')
const review = ref<SourceReview>()
const manualOpen = ref('')
const manualNote = ref('')
const creating = ref(false)
const authOptions = ['账号密码', '证书认证', 'SASL/SCRAM', 'SASL/PLAIN', 'Kerberos', 'IAM', 'Windows 集成认证']
const configDraft = ref({ auth: '', timeout: '', retry: '' })

const createFields: Array<{ key: keyof CreateSourceInput; label: string; placeholder: string }> = [
  { key: '连接类型', label: '连接类型', placeholder: 'MySQL / PostgreSQL / Kafka / Hive' },
  { key: '接入地址', label: '接入地址', placeholder: 'jdbc:mysql://host:3306/db' },
  { key: '认证方式', label: '认证方式', placeholder: '账号密码 / 证书认证 / Kerberos' },
  { key: '超时秒数', label: '超时秒数', placeholder: '30' },
  { key: '重试次数', label: '重试次数', placeholder: '3' },
  { key: '负责人', label: '负责人', placeholder: '负责人姓名' },
]

const createDraft = ref<CreateSourceInput>({
  连接类型: '',
  接入地址: '',
  认证方式: '',
  超时秒数: '',
  重试次数: '',
  负责人: '',
})

const stats = computed(() => [
  { label: '数据源连接总数', value: allTotal.value },
  { label: '可连接', value: countOf('可连接') },
  { label: '隔离', value: countOf('隔离') },
  { label: '待人工确认连接', value: countOf('待人工确认') },
])

const statusSummary = computed(() =>
  (['未检查', '可连接', '隔离', '待人工确认'] as ConnectionEligibility[]).map((status) => ({
    status,
    count: countOf(status),
  })),
)

function countOf(eligibility: ConnectionEligibility): number {
  return rows.value.filter((row) => row.eligibility === eligibility).length
}

function toneOf(eligibility: string): string {
  if (eligibility === '可连接') return 'ok'
  if (eligibility === '隔离') return 'bad'
  if (eligibility === '待人工确认') return 'warn'
  return 'muted'
}

function outcomeTone(outcome: string): string {
  if (outcome === '通过') return 'ok'
  if (outcome === '阻塞') return 'bad'
  return 'warn'
}

function pendingFor(connectionId: string): CheckSnapshot[] {
  return pendingChecksFor(connectionId)
}

function setBanner(message: string, tone: 'ok' | 'bad' | 'warn' = 'ok') {
  banner.value = message
  bannerTone.value = tone
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listSourceRows(filters.value)
    rows.value = payload.items
    total.value = payload.total
    allTotal.value = payload.allTotal
    if (focus.value) {
      review.value = reviewSource(focus.value)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据源管理列表读取失败'
  }
}

function openReview(connectionId: string) {
  focus.value = connectionId
  manualNote.value = ''
  review.value = reviewSource(connectionId)
  if (!review.value) {
    errorMessage.value = `没有找到连接 ${connectionId} 的回看记录`
  }
  reload()
}

function openManual(connectionId: string) {
  openReview(connectionId)
  manualOpen.value = connectionId
}

function submitCheck(row: SourceRowView) {
  const result = beginCheck(row.connectionId)
  if (!result.ok) {
    errorMessage.value = result.message
    setBanner(result.message, 'bad')
    return
  }
  focus.value = row.connectionId
  manualNote.value = ''
  setBanner(`${result.message}；判定「${result.verdict}」，点「写回」前结论还不生效`, result.verdict === '可连接' ? 'ok' : result.verdict === '隔离' ? 'bad' : 'warn')
  reload()
}

function writeBack(runId: string) {
  const result = commitCheck(runId)
  if (!result.ok) {
    errorMessage.value = result.message
    setBanner(result.message, 'bad')
  } else {
    setBanner(result.message, 'ok')
  }
  reload()
}

function submitManual(connectionId: string) {
  const result = confirmManualRecovery(connectionId, manualNote.value)
  if (!result.ok) {
    errorMessage.value = result.message
    setBanner(result.message, 'bad')
  } else {
    manualOpen.value = ''
    manualNote.value = ''
    setBanner(result.message, 'ok')
  }
  reload()
}

function submitConfig(connectionId: string) {
  const patch: { 认证方式?: string; 超时秒数?: string; 重试次数?: string } = {}
  if (configDraft.value.auth) patch.认证方式 = configDraft.value.auth
  if (configDraft.value.timeout.trim()) patch.超时秒数 = configDraft.value.timeout.trim()
  if (configDraft.value.retry.trim()) patch.重试次数 = configDraft.value.retry.trim()
  if (Object.keys(patch).length === 0) {
    setBanner('没有填写要修改的配置字段，配置版本保持不变', 'warn')
    return
  }
  const result = updateSourceConfig(connectionId, patch)
  setBanner(result.message, result.ok ? 'warn' : 'bad')
  if (!result.ok) errorMessage.value = result.message
  configDraft.value = { auth: '', timeout: '', retry: '' }
  reload()
}

function submitIsolate(connectionId: string) {
  const result = isolateManually(connectionId, manualNote.value)
  setBanner(result.message, result.ok ? 'warn' : 'bad')
  if (!result.ok) errorMessage.value = result.message
  reload()
}

function submitCreate() {
  const result = createSource(createDraft.value)
  if (!result.ok) {
    errorMessage.value = result.message
    setBanner(result.message, 'bad')
    return
  }
  creating.value = false
  createDraft.value = { 连接类型: '', 接入地址: '', 认证方式: '', 超时秒数: '', 重试次数: '', 负责人: '' }
  setBanner(result.message, 'ok')
  reload()
}

function toggleCreate() {
  creating.value = !creating.value
  errorMessage.value = ''
}

function exportRows() {
  downloadEntries(meta.key)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function resetAll() {
  resetConnections()
  focus.value = ''
  review.value = undefined
  setBanner('已重置连接证据与示例运行记录', 'warn')
  reload()
}

onMounted(() => {
  const focusParam = route.query.focus
  if (typeof focusParam === 'string' && focusParam) {
    focus.value = focusParam
  }
  reload()
})
</script>
