<template>
  <section class="page" data-module="monitor">
    <header class="page-head">
      <div>
        <h2>任务监控</h2>
        <p class="page-desc">
          监控配置不维护第二份连接结论：源端恢复证据与数据同步引用同一条记录，
          隔离与恢复在两边保持同一个版本、同一个理由。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记监控配置</button>
        <button class="btn" type="button" @click="exportRows">导出任务监控清单</button>
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
      <span class="legend-item legend-warn">引用证据 {{ evidenceCount }} 条</span>
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
          <th>配置编号</th>
          <th>关联任务</th>
          <th>监控指标</th>
          <th>告警阈值</th>
          <th>告警级别</th>
          <th>通知渠道</th>
          <th>当前状态</th>
          <th>源端资格</th>
          <th>说明</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="row.configId">
          <tr>
            <td>{{ row.configId }}</td>
            <td>{{ row.linkedLink }}</td>
            <td>{{ row.metric }}</td>
            <td>{{ row.threshold }}</td>
            <td>{{ row.level }}</td>
            <td>{{ row.channel }}</td>
            <td>{{ row.status }}</td>
            <td>
              <span class="verdict-chip" :class="`verdict-${verdictTone(row.evidence?.verdict)}`">
                {{ row.linkFound ? row.evidence?.verdict ?? '无证据' : '未关联' }}
              </span>
            </td>
            <td>{{ row.explanation }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="toggleEvidence(row.configId)">
                {{ focus === row.configId ? '收起证据' : '查看恢复证据' }}
              </button>
              <RouterLink
                v-if="row.linkFound"
                class="link"
                :to="`/source?focus=${encodeURIComponent(row.sourceConnection)}`"
              >
                去数据源核对
              </RouterLink>
            </td>
          </tr>
          <tr v-if="focus === row.configId" class="focus-row">
            <td colspan="10">
              <div class="review-block">
                <RecoveryEvidencePanel v-if="row.evidence" :evidence="row.evidence" />
                <p v-else class="muted-text">
                  关联任务 {{ row.linkedLink }} 没有可引用的源端连接证据；先确认任务编号是否登记在数据同步里。
                </p>
                <p class="detail-line">
                  监控恢复条件：{{ row.recoveryCondition }} ·
                  监控自身的恢复动作不改变连接资格，只引用数据源管理写回的结论。
                </p>
              </div>
            </td>
          </tr>
        </template>
        <tr v-if="!rows.length">
          <td colspan="10" class="empty-state">
            {{ allTotal === 0 ? '还没有登记监控配置，先点右上角登记' : '没有命中监控配置，按当前条件清空检索词或重置条件再试' }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条监控配置记录（全部 {{ allTotal }} 条）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listMonitorRows } from '@/api/connection-service'
import RecoveryEvidencePanel from '@/components/RecoveryEvidencePanel.vue'
import { downloadEntries } from '@/api/local-service'
import type { MonitorRowView } from '@/data/connection-types'

const meta = { key: 'monitor', name: '任务监控' }
const filterFields = ['配置编号', '关联任务', '监控指标']
const rows = ref<MonitorRowView[]>([])
const total = ref(0)
const allTotal = ref(0)
const errorMessage = ref('')
const banner = ref('')
const bannerTone = ref<'ok' | 'bad' | 'warn'>('ok')
const filters = ref<Record<string, string>>({})
const focus = ref('')

const stats = computed(() => [
  { label: '监控配置总数', value: allTotal.value },
  { label: '已启用配置', value: rows.value.filter((row) => row.status === '已启用').length },
  { label: '关联任务缺失', value: rows.value.filter((row) => !row.linkFound).length },
])

const statusSummary = computed(() =>
  (['草稿', '待校验', '已启用', '已停用'] as const).map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

const evidenceCount = computed(() => rows.value.filter((row) => Boolean(row.evidence)).length)

function verdictTone(verdict: string | undefined): string {
  if (verdict === '可连接') return 'ok'
  if (verdict === '隔离') return 'bad'
  if (verdict === '待人工确认') return 'warn'
  return 'muted'
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listMonitorRows(filters.value)
    rows.value = payload.items
    total.value = payload.total
    allTotal.value = payload.allTotal
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '任务监控列表读取失败'
  }
}

function toggleEvidence(configId: string) {
  focus.value = focus.value === configId ? '' : configId
}

function openCreate() {
  banner.value = '监控配置登记入口尚未接入审批流；当前可直接在监控清单查看源端恢复证据'
  bannerTone.value = 'warn'
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
