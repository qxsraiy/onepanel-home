<script setup>
import { ref } from 'vue'
import axios from 'axios'
import AppIcon from './AppIcon.vue'
import SelectBox from './SelectBox.vue'
import { toast } from '../utils/common'

const props = defineProps({ groups: Array })
const emit = defineEmits(['update-groups-immediate', 'refresh-items'])

const DEFAULT_GROUP = '书签'
const newGroup = ref('')
const deleteTarget = ref(null)
const deleteMode = ref('transfer')
const transferTarget = ref('')
const renaming = ref(null)
const renameValue = ref('')
const busy = ref(false)

const addGroup = () => {
  // 【F-07】防连点：props.groups 的更新是异步的，同步连点会重复添加同名分组
  if (busy.value) return
  busy.value = true
  setTimeout(() => { busy.value = false }, 300)
  const name = newGroup.value.trim()
  if (!name) { busy.value = false; return }
  if (name === DEFAULT_GROUP || props.groups.includes(name)) return toast('分组已存在', 'warn')
  emit('update-groups-immediate', [...props.groups, name])
  newGroup.value = ''
  toast('已新增分组', 'success')
}

const startRename = (g) => { renaming.value = g; renameValue.value = g }
const cancelRename = () => { renaming.value = null; renameValue.value = '' }
const commitRename = async () => {
  const from = renaming.value
  const to = renameValue.value.trim()
  if (!from || !to || to === from) return cancelRename()
  if (props.groups.includes(to)) return toast('目标分组已存在', 'warn')
  busy.value = true
  try {
    await axios.put('/api/items/group/transfer', { oldGroup: from, newGroup: to })
    emit('update-groups-immediate', props.groups.map((x) => (x === from ? to : x)))
    emit('refresh-items')
    toast('已改名为「' + to + '」', 'success')
    cancelRename()
  } catch (e) {
    toast(e.response?.data?.error || '改名失败', 'error')
  } finally { busy.value = false }
}

const promptDelete = (g) => {
  if (g === DEFAULT_GROUP) return toast('默认分组「书签」不可删除', 'warn')
  deleteTarget.value = g
  deleteMode.value = 'transfer'
  transferTarget.value = props.groups.filter((x) => x !== g)[0] || DEFAULT_GROUP
}

const closeDelete = () => { deleteTarget.value = null }

const doDelete = async () => {
  if (!deleteTarget.value) return
  busy.value = true
  try {
    if (deleteMode.value === 'transfer') {
      await axios.put('/api/items/group/transfer', { oldGroup: deleteTarget.value, newGroup: transferTarget.value })
      toast('卡片已并入「' + transferTarget.value + '」', 'success')
    } else {
      await axios.delete(`/api/items/group/${encodeURIComponent(deleteTarget.value)}`)
      toast('已删除分组及其卡片', 'success')
    }
    removeGroupFromArray(deleteTarget.value)
    emit('refresh-items')
  } catch (error) {
    toast(error.response?.data?.error || '删除失败', 'error')
  } finally { busy.value = false }
}

const removeGroupFromArray = (groupName) => {
  emit('update-groups-immediate', props.groups.filter((g) => g !== groupName))
  deleteTarget.value = null
}
</script>

<template>
  <div class="group-manager-module">
    <!-- 新建：放最上面 -->
    <div class="add-group-row">
      <input v-model="newGroup" type="text" placeholder="输入新分组名称，回车创建" class="glass-input flex-1" @keyup.enter="addGroup" />
      <button class="btn-primary" :disabled="!newGroup.trim()" @click="addGroup">新增分组</button>
    </div>

    <!-- 列表：一行一个，沿用原来的胶囊配色 -->
    <div class="group-rows mt-3">
      <div v-for="g in groups" :key="g" class="group-row">
        <template v-if="renaming === g">
          <input v-model="renameValue" type="text" class="glass-input flex-1" @keyup.enter="commitRename" @keyup.esc="cancelRename" />
          <button class="btn-primary row-btn" :disabled="busy" @click="commitRename">保存</button>
          <button class="btn-outline row-btn" @click="cancelRename">取消</button>
        </template>
        <template v-else>
          <span class="group-name">{{ g }}</span>
          <span v-if="g === '书签'" class="group-default">默认</span>
          <span class="row-spacer"></span>
          <button class="row-action" title="改名称" @click="startRename(g)"><AppIcon icon="mdi:pencil-outline" /></button>
          <button v-if="g !== '书签'" class="row-action row-danger" title="删除分组" @click="promptDelete(g)"><AppIcon icon="mdi:close" /></button>
        </template>
      </div>
      <p v-if="!groups.length" class="group-empty">还没有分组</p>
    </div>

    <!-- 删除确认：二选一，和上面的胶囊同一套配色 -->
    <div v-if="deleteTarget" class="danger-zone mt-4">
      <h5>删除分组「{{ deleteTarget }}」</h5>
      <div class="mode-row" :class="{ active: deleteMode === 'transfer' }" @click="deleteMode = 'transfer'">
        <input v-model="deleteMode" type="radio" value="transfer" @click.stop />
        <div class="mode-text">
          <b>把卡片移到别的分组</b>
          <span>分组消失，卡片保留</span>
        </div>
        <div class="mode-select" @click.stop>
          <SelectBox v-model="transferTarget" :options="groups.filter((x) => x !== deleteTarget)" placeholder="选择分组" />
        </div>
      </div>
      <div class="mode-row" :class="{ active: deleteMode === 'purge' }" @click="deleteMode = 'purge'">
        <input v-model="deleteMode" type="radio" value="purge" @click.stop />
        <div class="mode-text">
          <b>连同卡片一起删除</b>
          <span>不可恢复，会同步到所有节点</span>
        </div>
      </div>
      <div class="flex-row" style="justify-content: flex-end;">
        <button class="btn-outline" @click="closeDelete">取消</button>
        <button class="btn-primary" :style="deleteMode === 'purge' ? 'background:#ef4444' : ''" :disabled="busy" @click="doDelete">
          {{ busy ? '处理中…' : (deleteMode === 'transfer' ? '移送并删除分组' : '彻底删除') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 完全沿用原版控件样式，只新增"行"布局 */
.add-group-row { display: flex; gap: 10px; }
.mt-3 { margin-top: 16px; }
.mt-4 { margin-top: 24px; }
.flex-1 { flex: 1; }
.flex-row { display: flex; gap: 10px; }

.glass-input {
  background: color-mix(in srgb, var(--theme-color) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-color) 20%, transparent);
  padding: 8px 12px; border-radius: 8px;
  color: var(--theme-color); outline: none; transition: 0.2s;
}
.glass-input:focus { border-color: #3b82f6; }

.btn-primary { background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; transition: 0.2s; }
.btn-primary:hover { background: #2563eb; }
.btn-primary:disabled { opacity: .5; cursor: not-allowed; }

.btn-outline {
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--theme-color) 20%, transparent);
  color: var(--theme-color); padding: 8px 16px; border-radius: 8px; cursor: pointer; transition: 0.2s;
}
.btn-outline:hover { background: color-mix(in srgb, var(--theme-color) 10%, transparent); }

/* 列表：一行一个，沿用 group-tag 的蓝调 */
.group-rows { display: flex; flex-direction: column; gap: 8px; }
.group-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: 10px;
  background: rgba(59, 130, 246, 0.10);
  border: 1px solid rgba(59, 130, 246, 0.22);
  transition: 0.2s;
}
.group-row:hover { background: rgba(59, 130, 246, 0.16); border-color: rgba(59, 130, 246, 0.35); }
.group-name { font-size: 13px; color: var(--theme-color); }
.group-default {
  font-size: 10px; padding: 1px 7px; border-radius: 999px;
  background: rgba(59, 130, 246, 0.25); color: #93c5fd;
}
.row-spacer { flex: 1; }
.row-action {
  width: 26px; height: 26px; padding: 0; display: inline-flex; align-items: center; justify-content: center;
  background: none; border: none; border-radius: 6px; cursor: pointer;
  color: color-mix(in srgb, var(--theme-color) 55%, transparent); transition: 0.2s;
}
.row-action:hover { color: var(--theme-color); background: rgba(59, 130, 246, 0.2); }
.row-danger:hover { color: #ef4444; background: rgba(239, 68, 68, 0.15); }
.row-btn { padding: 6px 12px; font-size: 12px; }
.group-empty { font-size: 12px; opacity: .5; padding: 8px 2px; }

/* 删除确认 */
.danger-zone {
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.28);
  border-radius: 12px; padding: 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.danger-zone h5 { margin: 0 0 2px; font-size: 13px; color: #f87171; }
.mode-row {
  display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 9px;
  cursor: pointer; border: 1px solid transparent; transition: 0.2s;
}
.mode-row:hover { background: color-mix(in srgb, var(--theme-color) 6%, transparent); }
.mode-row.active { background: color-mix(in srgb, var(--theme-color) 10%, transparent); border-color: color-mix(in srgb, var(--theme-color) 20%, transparent); }
.mode-row input { accent-color: #3b82f6; }
.mode-text { display: flex; flex-direction: column; gap: 2px; }
.mode-text b { font-size: 12.5px; font-weight: 600; color: var(--theme-color); }
.mode-text span { font-size: 11.5px; color: color-mix(in srgb, var(--theme-color) 55%, transparent); }
.mode-select { margin-left: auto; width: 168px; flex-shrink: 0; }
</style>
