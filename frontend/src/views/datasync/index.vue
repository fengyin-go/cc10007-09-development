<template>
  <section class="page" data-module="datasync">
    <header class="page-head">
      <div>
        <h2>数据同步</h2>
        <p class="page-desc">
          同步链路只引用数据源管理里的连接资格：源端被隔离、待人工确认或未检查时阻止新任务，
          已有运行记录保留；连接恢复后从失败位点续跑，不重复消费整段数据。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记同步链路</button>
        <button class="btn" type="button" @click="exportRows">导出数据同步清单</button>
      </div>
    </header>

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
      <span class="legend-item legend-warn">源端阻断 {{ blockedCount }} 条</span>
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
          <th>链路编号</th>
          <th>源端连接</th>
          <th>目标端连接</th>
          <th>同步表列表</th>
          <th>全量增量标识</th>
          <th>同步频率</th>
          <th>当前状态</th>
          <th>源端资格</th>
          <th>最近运行</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="row.linkId">
          <tr :class="{ 'row-focus': focus === row.linkId }">
            <td>{{ row.linkId }}</td>
            <td>{{ row.sourceConnection || '未填写' }}</td>
            <td>{{ row.targetConnection || '未填写' }}</td>
            <td>{{ row.tables }}</td>
            <td>{{ row.syncMode }}</td>
            <td>{{ row.frequency }}</td>
            <td>{{ row.status }}</td>
            <td>
              <span
                class="verdict-chip"
                :class="`verdict-${verdictTone(row.evidence?.verdict)}`"
              >
                {{ row.evidence?.verdict ?? '无证据' }}
              </span>
              <span v-if="!row.guard.ok" class="guard-reason">{{ row.guard.code }}</span>
            </td>
            <td>
              <span v-if="row.lastRun">
                {{ row.lastRun.status }} · 水位 {{ row.lastRun.checkpointEnd }}
                <span class="muted-text">（共 {{ row.runCount }} 次运行）</span>
              </span>
              <span v-else class="muted-text">没有运行记录</span>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="start(row, false)">启动同步</button>
              <button class="link" type="button" @click="start(row, true)">从失败点续跑</button>
              <button class="link" type="button" @click="stop(row)">停止同步</button>
              <button class="link" type="button" @click="openEvidence(row)">恢复证据</button>
              <button class="link" type="button" @click="simulateFailure(row)">模拟失败</button>
            </td>
          </tr>
          <tr v-if="focus === row.linkId" class="focus-row">
            <td :colspan="10">
              <div class="review-block">
                <RecoveryEvidencePanel v-if="row.evidence" :evidence="row.evidence" />
                <p v-else class="muted-text">
                  源端 {{ row.sourceConnection || '未填写' }} 没有可引用的连接资格证据：
                  {{ row.guard.reason }}
                </p>
                <div class="review-grid">
                  <section>
                    <h4>启动闸门</h4>
                    <p :class="row.guard.ok ? 'ok-text' : 'error-text'">
                      {{ row.guard.ok ? '允许启动 / 续跑' : '阻止新任务' }}：{{ row.guard.reason }}
                    </p>
                    <h4>续跑计划</h4>
                    <p :class="row.resumePlan.ok ? 'ok-text' : 'muted-text'">
                      {{ row.resumePlan.reason }}
                    </p>
                    <p v-if="row.resumePlan.failedRun" class="detail-line">
                      失败运行 <span class="mono">{{ row.resumePlan.failedRun.id }}</span>：
                      起点 {{ row.resumePlan.failedRun.checkpointStart }}，失败位点
                      {{ row.resumePlan.failedRun.checkpointEnd }}，续跑起点
                      <span class="mono">{{ row.resumePlan.fromOffset }}</span>，
                      重放 {{ row.resumePlan.replayRows }} 行
                    </p>
                  </section>
                  <section>
                    <h4>运行记录（保留历史，不随隔离删除）</h4>
                    <p v-if="!runsOf(row.linkId).length" class="muted-text">还没有运行记录。</p>
                    <ul v-else class="timeline">
                      <li v-for="run in [...runsOf(row.linkId)].reverse()" :key="run.id">
                        <span class="mono">{{ run.id }}</span>
                        <span class="run-status" :class="`run-${runTone(run.status)}`">{{ run.status }}</span>
                        <span class="muted-text">
                          {{ formatTimestamp(run.startedAt) }} ·
                          水位 {{ run.checkpointStart }} → {{ run.checkpointEnd }} ·
                          消费 {{ run.consumedRows }} 行
                        </span>
                        <div class="detail-line">{{ run.note }}</div>
                        <div v-if="run.failureReason" class="detail-line error-text">
                          失败原因：{{ run.failureReason }}；续跑起点 {{ run.nextResumeOffset }}
                        </div>
                      </li>
                    </ul>
                  </section>
                </div>
              </div>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td colspan="10" class="empty-state">
            {{ allTotal === 0 ? '还没有登记同步链路，先点右上角登记' : '没有命中同步链路，按当前条件清空检索词或重置条件再试' }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条同步链路记录（全部 {{ allTotal }} 条）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listSyncLinks, runsForLink, setLinkStatus, startSync, failRun } from '@/api/connection-service'
import RecoveryEvidencePanel from '@/components/RecoveryEvidencePanel.vue'
import { downloadEntries } from '@/api/local-service'
import { formatTimestamp } from '@/data/connection-config'
import type { SyncLinkView } from '@/data/connection-types'

const meta = { key: 'datasync', name: '数据同步' }
const filterFields = ['链路编号', '源端连接', '目标端连接']
const rows = ref<SyncLinkView[]>([])
const total = ref(0)
const allTotal = ref(0)
const errorMessage = ref('')
const banner = ref('')
const bannerTone = ref<'ok' | 'bad' | 'warn'>('ok')
const filters = ref<Record<string, string>>({})
const focus = ref('')

const stats = computed(() => [
  { label: '同步链路总数', value: allTotal.value },
  { label: '运行中链路', value: rows.value.filter((row) => row.status === '运行中').length },
  {
    label: '已中断链路',
    value: rows.value.filter((row) => row.status === '已中断').length,
  },
])

const statusSummary = computed(() =>
  (['草稿', '待校验', '运行中', '已中断', '已停止'] as const).map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

const blockedCount = computed(() => rows.value.filter((row) => !row.guard.ok).length)

function verdictTone(verdict: string | undefined): string {
  if (verdict === '可连接') return 'ok'
  if (verdict === '隔离') return 'bad'
  if (verdict === '待人工确认') return 'warn'
  return 'muted'
}

function runTone(status: string): string {
  if (status === '成功') return 'ok'
  if (status === '失败' || status === '中断') return 'bad'
  return 'warn'
}

function runsOf(linkId: string) {
  return runsForLink(linkId)
}

function setBanner(message: string, tone: 'ok' | 'bad' | 'warn' = 'ok') {
  banner.value = message
  bannerTone.value = tone
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listSyncLinks(filters.value)
    rows.value = payload.items
    total.value = payload.total
    allTotal.value = payload.allTotal
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据同步列表读取失败'
  }
}

function openEvidence(row: SyncLinkView) {
  focus.value = focus.value === row.linkId ? '' : row.linkId
}

function start(row: SyncLinkView, resume: boolean) {
  const result = startSync(row.linkId, { resume })
  if (!result.ok) {
    errorMessage.value = result.message
    setBanner(
      `${row.linkId} ${resume ? '续跑' : '启动'}失败：${result.message}`,
      result.code === 'isolated' || result.code === 'manual-pending' ? 'bad' : 'warn',
    )
  } else {
    setBanner(`${row.linkId}：${result.message}`, 'ok')
    focus.value = row.linkId
  }
  reload()
}

function stop(row: SyncLinkView) {
  const result = setLinkStatus(row.linkId, '已停止')
  setBanner(result.message, result.ok ? 'warn' : 'bad')
  if (!result.ok) errorMessage.value = result.message
  reload()
}

function simulateFailure(row: SyncLinkView) {
  const base = row.lastRun?.checkpointEnd ?? 0
  const result = failRun(row.linkId, base + 160)
  if (!result.ok) {
    setBanner(result.message, 'bad')
    errorMessage.value = result.message
  } else {
    setBanner(`${row.linkId}：${result.message}`, 'warn')
    focus.value = row.linkId
  }
  reload()
}

function openCreate() {
  setBanner('同步链路登记入口尚未接入审批流；当前可直接在数据同步清单核对源端与目标端连接', 'warn')
}

function exportRows() {
  downloadEntries(meta.key)
}

function resetFilters() {
  filters.value = {}
  reload()
}

onMounted(reload)
</script>
