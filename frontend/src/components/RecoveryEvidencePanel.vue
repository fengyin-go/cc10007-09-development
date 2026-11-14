<template>
  <div class="evidence-panel" :class="`verdict-${tone}`" data-testid="recovery-evidence">
    <div class="evidence-head">
      <span class="verdict-chip" :class="`verdict-${tone}`">{{ evidence.verdict }}</span>
      <strong>连接资格证据 · {{ evidence.connectionId }}</strong>
      <span class="evidence-source">{{ evidence.evidenceSource }}</span>
    </div>
    <p class="evidence-reason">{{ evidence.reason }}</p>
    <dl class="evidence-grid">
      <div>
        <dt>配置版本</dt>
        <dd>
          {{ evidence.configVersion }}
          <span v-if="evidence.configVersion !== evidence.effectiveConfigVersion" class="error-text">
            （结论基于 {{ evidence.effectiveConfigVersion }}，已失效）
          </span>
        </dd>
      </div>
      <div>
        <dt>最近检查</dt>
        <dd>{{ formatTimestamp(evidence.lastCheckAt) }}</dd>
      </div>
      <div>
        <dt>恢复门槛</dt>
        <dd>
          连续 {{ evidence.requiredSuccesses }} 次可连接 + 人工确认；
          当前 {{ evidence.successCount }}/{{ evidence.requiredSuccesses }}
          <span v-if="evidence.successCheckIds.length">（{{ evidence.successCheckIds.join('、') }}）</span>
        </dd>
      </div>
      <div>
        <dt>相反结论裁定</dt>
        <dd>{{ evidence.conflictSummary }}</dd>
      </div>
      <div v-if="evidence.manualNote">
        <dt>人工确认</dt>
        <dd>{{ evidence.manualNote }}</dd>
      </div>
      <div>
        <dt>回看入口</dt>
        <dd>
          <RouterLink class="link" :to="`/source?focus=${encodeURIComponent(evidence.connectionId)}`">
            在数据源管理中核对 {{ evidence.connectionId }}
          </RouterLink>
          <span class="evidence-hint">（连接资格以数据源管理为主对象）</span>
        </dd>
      </div>
    </dl>
    <p class="evidence-foot">
      本面板与数据同步、任务监控引用同一份恢复证据；修改或人工裁定连接后，两处会一起刷新。
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { formatTimestamp } from '@/data/connection-config'
import type { RecoveryEvidenceView } from '@/data/connection-types'

const props = defineProps<{ evidence: RecoveryEvidenceView }>()

const tone = computed(() => {
  switch (props.evidence.verdict) {
    case '可连接':
      return 'ok'
    case '隔离':
      return 'bad'
    case '待人工确认':
      return 'warn'
    default:
      return 'muted'
  }
})
</script>
