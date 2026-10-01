import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { maintenanceApi } from './api';
import type { HangarSnapshot, ImportOutcome, QueueChange } from './server';

export type StageSignature = { stage: string; status: '待签署' | '已签署' | '待同步'; actor: string; time: string };
export type OfflineCard = {
  id: string;
  title: string;
  estimated: number;
  zone: string;
  dependencies: string[];
  tolerance: string;
  evidence: string;
  witness: string;
  status: '未开始' | '执行中' | '待授权' | '已完成';
  measurement: string;
  finding: string;
  stage: string;
};

export type OfflineQueueItem = {
  requestId: string;
  kind: 'card' | 'signature';
  targetId: string;
  title: string;
  changes: QueueChange[];
  baselineVersion: number;
  status: '待合并' | '已合并' | '待确认' | '失败';
  attempts: number;
  lastError: string;
  note: string;
  actor: string;
  time: string;
  conflict?: { serverVersion: number; updatedBy: string; fields: { key: string; field: string; local: string; server: string }[] };
};

type AuditEntry = { time: string; actor: string; action: string; detail: string };

type MaintenanceState = {
  cards: OfflineCard[];
  activeCardId: string;
  syncVersion: number;
  serverVersion: number;
  offline: boolean;
  lastSaved: string;
  conflictMessage: string;
  signatures: StageSignature[];
  released: boolean;
  releaseBaseline: { revision: number; time: string } | null;
  offlineQueue: OfflineQueueItem[];
  queueSeq: number;
  audit: AuditEntry[];
};

const initialCards: OfflineCard[] = [
  { id: 'CARD-01', title: '右主起落架收放检查', zone: '起落架舱 RH', estimated: 3.5, dependencies: [], tolerance: '间隙 1.2–2.0 mm', evidence: '近照 + 动作记录', witness: '检验员', status: '已完成', measurement: '1.62 mm', finding: '正常', stage: '机械签署' },
  { id: 'CARD-02', title: '发动机 2 风扇叶片孔探', zone: '发动机 2', estimated: 4.2, dependencies: ['CARD-01'], tolerance: '凹坑 ≤ 0.3 mm', evidence: '孔探照片 + 视频', witness: '发动机工程师', status: '执行中', measurement: '', finding: '', stage: '发动机签署' },
  { id: 'CARD-03', title: '液压系统压力保持测试', zone: '轮舱 / 系统 A', estimated: 2.0, dependencies: ['CARD-01'], tolerance: '≥ 2850 psi / 10 min', evidence: '压力仪记录', witness: '质量检验', status: '待授权', measurement: '2762 psi', finding: '低于容差，等待授权', stage: '系统签署' },
  { id: 'CARD-04', title: '前起落架时寿件核对', zone: '前起落架', estimated: 1.5, dependencies: [], tolerance: '剩余循环 ≥ 500', evidence: '件号照片 + 履历页', witness: '检验员', status: '已完成', measurement: '剩余 836 循环', finding: '正常', stage: '适航签署' },
  { id: 'CARD-05', title: 'AD 2024-15-03 执行确认', zone: '机身后段', estimated: 2.5, dependencies: ['CARD-04'], tolerance: '按 AD 标准施工', evidence: '施工记录 + 签署', witness: '放行人员', status: '未开始', measurement: '', finding: '', stage: '适航签署' },
  { id: 'CARD-06', title: '客舱应急设备检查', zone: '客舱全舱', estimated: 2.8, dependencies: [], tolerance: '全部在有效期内', evidence: '清单复核', witness: '客舱检验', status: '未开始', measurement: '', finding: '', stage: '客舱签署' },
  { id: 'CARD-07', title: 'APU 排故后试车', zone: 'APU 舱', estimated: 3.0, dependencies: ['CARD-03'], tolerance: '参数在 AMM 范围', evidence: '试车数据 + 油样', witness: '动力工程师', status: '未开始', measurement: '', finding: '', stage: '动力签署' },
  { id: 'CARD-08', title: '重复缺陷趋势复核', zone: '全机', estimated: 1.0, dependencies: ['CARD-02', 'CARD-03'], tolerance: '无新增重复缺陷', evidence: '近 3 次记录', witness: '质量经理', status: '执行中', measurement: '发现 2 次压力偏低', finding: '移交可靠性分析', stage: '放行签署' }
];

const now = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

const TRACKED_FIELDS: { key: 'measurement' | 'finding' | 'evidence' | 'status'; field: string }[] = [
  { key: 'measurement', field: '测量值' },
  { key: 'finding', field: '发现与处置' },
  { key: 'evidence', field: '证据要求' },
  { key: 'status', field: '状态' }
];

// 工卡阶段 → 签字阶段映射；未映射的阶段不发生签字重置。
const cardStageToSignature: Record<string, string> = {
  机械签署: '机械',
  系统签署: '系统',
  动力签署: '动力',
  发动机签署: '动力',
  适航签署: '放行',
  放行签署: '放行'
};

// 断网期间的工卡改动进入离线队列：同一工卡合并到同一条待并入项，保留原请求编号。
function queueCardChanges(state: MaintenanceState, card: OfflineCard, changes: QueueChange[]) {
  if (!changes.length) return;
  const existing = state.offlineQueue.find((item) => item.kind === 'card' && item.targetId === card.id && (item.status === '待合并' || item.status === '失败'));
  if (existing) {
    for (const change of changes) {
      const recorded = existing.changes.find((entry) => entry.key === change.key);
      if (recorded) recorded.to = change.to;
      else existing.changes.push(change);
    }
    existing.time = state.lastSaved;
    if (existing.status === '失败') {
      existing.status = '待合并';
      existing.lastError = '';
    }
    state.audit.unshift({ time: state.lastSaved, actor: '宋杰 · 机械', action: '离线暂存', detail: `${card.id} 改动已并入待合并项 ${existing.requestId}` });
    return;
  }
  state.queueSeq += 1;
  const requestId = `OQ-${String(state.queueSeq).padStart(3, '0')}`;
  state.offlineQueue.unshift({
    requestId,
    kind: 'card',
    targetId: card.id,
    title: card.title,
    changes,
    baselineVersion: state.serverVersion,
    status: '待合并',
    attempts: 0,
    lastError: '',
    note: '',
    actor: '宋杰 · 机械',
    time: state.lastSaved
  });
  state.audit.unshift({ time: state.lastSaved, actor: '宋杰 · 机械', action: '离线暂存', detail: `${card.id} 已保存本地草稿（${requestId} · 基线 R${state.serverVersion}），回网后并入` });
}

// 工卡并入后的连锁处理：证据更新 → 受影响签字退回待签；已放行包 → 退回审阅。
function applyMergeSideEffects(state: MaintenanceState, item: OfflineQueueItem) {
  const card = state.cards.find((entry) => entry.id === item.targetId);
  const evidenceTouched = item.changes.some((change) => change.key === 'measurement' || change.key === 'finding' || change.key === 'evidence');
  if (card && evidenceTouched) {
    const stage = cardStageToSignature[card.stage];
    const signature = state.signatures.find((entry) => entry.stage === stage);
    if (signature && signature.status === '已签署') {
      signature.status = '待签署';
      signature.actor = '待指定';
      signature.time = '-';
      state.audit.unshift({ time: now(), actor: '系统', action: '签字重置', detail: `${item.targetId} 证据更新，${stage}签署退回待签` });
    }
  }
  if (state.released) {
    state.released = false;
    const release = state.signatures.find((entry) => entry.stage === '放行');
    if (release && release.status === '已签署') {
      release.status = '待签署';
      release.actor = '质量经理';
      release.time = '-';
    }
    state.audit.unshift({ time: now(), actor: '系统', action: '退回审阅', detail: `离线并入更新了证据，已放行包退回审阅；放行基线 R${state.releaseBaseline?.revision ?? state.serverVersion} 保留为只读快照` });
  }
}

const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('yy61-work-package') : null;
const saved = raw ? JSON.parse(raw) : null;
const defaultState: MaintenanceState = {
  cards: initialCards,
  activeCardId: 'CARD-03',
  syncVersion: 7,
  serverVersion: 7,
  offline: false,
  lastSaved: '09:46',
  conflictMessage: '',
  signatures: [
    { stage: '机械', status: '已签署', actor: '赵明 · 机械师', time: '09:18' },
    { stage: '系统', status: '待签署', actor: '待指定', time: '-' },
    { stage: '动力', status: '待签署', actor: '待指定', time: '-' },
    { stage: '放行', status: '待签署', actor: '质量经理', time: '-' }
  ],
  released: false,
  releaseBaseline: null,
  offlineQueue: [],
  queueSeq: 0,
  audit: [
    { time: '08:54', actor: '赵明', action: '完成工卡', detail: 'CARD-01 间隙测量 1.62 mm' },
    { time: '09:05', actor: '宋杰', action: '提交测量', detail: 'CARD-03 压力 2762 psi，低于容差' },
    { time: '09:20', actor: '系统', action: '阻断', detail: 'CARD-03 等待授权处理' }
  ]
};
// 兼容旧版本地存档：新增的离线合并字段用默认值补齐。
const initialState: MaintenanceState = saved ? { ...defaultState, ...saved } : defaultState;

const slice = createSlice({
  name: 'maintenance',
  initialState,
  reducers: {
    selectCard(state, action: PayloadAction<string>) {
      state.activeCardId = action.payload;
    },
    updateCard(state, action: PayloadAction<Partial<OfflineCard>>) {
      const card = state.cards.find((item) => item.id === state.activeCardId);
      if (!card) return;
      const changes = TRACKED_FIELDS.filter(({ key }) => action.payload[key] !== undefined && action.payload[key] !== card[key]).map(({ key, field }) => ({ key, field, from: String(card[key]), to: String(action.payload[key]) }));
      Object.assign(card, action.payload);
      state.syncVersion += 1;
      state.lastSaved = now();
      if (state.offline) {
        queueCardChanges(state, card, changes);
        if (changes.length) return;
      }
      state.audit.unshift({ time: state.lastSaved, actor: '宋杰 · 机械', action: '离线暂存', detail: `${card.id} 已保存本地草稿` });
    },
    setConflict(state, action: PayloadAction<string>) {
      state.conflictMessage = action.payload;
    },
    refreshVersion(state) {
      state.syncVersion = state.serverVersion;
      state.conflictMessage = '';
    },
    toggleOffline(state) {
      state.offline = !state.offline;
    },
    authorizeOverride(state) {
      const card = state.cards.find((item) => item.id === state.activeCardId);
      if (!card) return;
      const changes: QueueChange[] = [
        { key: 'status', field: '状态', from: card.status, to: '执行中' },
        { key: 'finding', field: '发现与处置', from: card.finding, to: '超差已由授权人员批准，按工程指令继续' }
      ];
      card.status = '执行中';
      card.finding = '超差已由授权人员批准，按工程指令继续';
      if (state.offline) queueCardChanges(state, card, changes);
      state.audit.unshift({ time: now(), actor: '放行授权人', action: '授权继续', detail: `${card.id} 超差放行审批${state.offline ? '（离线，待并入）' : ''}` });
    },
    signStage(state, action: PayloadAction<string>) {
      const signature = state.signatures.find((item) => item.stage === action.payload);
      if (!signature || signature.status !== '待签署') return;
      if (state.offline) {
        signature.status = '待同步';
        state.queueSeq += 1;
        const requestId = `OQ-${String(state.queueSeq).padStart(3, '0')}`;
        state.offlineQueue.unshift({
          requestId,
          kind: 'signature',
          targetId: action.payload,
          title: `${action.payload}阶段签字`,
          changes: [{ key: 'signature', field: '阶段签字', from: '待签署', to: '已签署' }],
          baselineVersion: state.serverVersion,
          status: '待合并',
          attempts: 0,
          lastError: '',
          note: '',
          actor: '宋杰 · 机械',
          time: now()
        });
        state.audit.unshift({ time: now(), actor: '宋杰 · 机械', action: '离线签字', detail: `${action.payload}阶段签字尝试已记录（${requestId} · 基线 R${state.serverVersion}），回网后并入` });
        return;
      }
      signature.status = '已签署';
      signature.actor = `${action.payload}负责人`;
      signature.time = now();
      state.audit.unshift({ time: signature.time, actor: signature.actor, action: '阶段签署', detail: `${action.payload}阶段确认完成` });
    },
    releasePackage(state) {
      const hasBlockers = state.cards.some((card) => card.status === '待授权');
      const allSigned = state.signatures.every((item) => item.status === '已签署');
      if (!hasBlockers && allSigned) {
        state.released = true;
        state.releaseBaseline = { revision: state.serverVersion, time: now() };
        state.audit.unshift({ time: now(), actor: '质量经理', action: '锁定放行', detail: `工作包 R${state.serverVersion} 已锁定并形成放行基线` });
      }
    },
    // 回网后按机库最新版盖回：本地有离线改动的项暂缓覆盖，留给合并流程处理。
    applyServerSnapshot(state, action: PayloadAction<HangarSnapshot>) {
      const pending = new Set(state.offlineQueue.filter((item) => item.status !== '已合并').map((item) => `${item.kind}:${item.targetId}`));
      for (const update of action.payload.cardUpdates) {
        const card = state.cards.find((item) => item.id === update.id);
        if (!card) continue;
        if (pending.has(`card:${update.id}`)) {
          state.audit.unshift({ time: now(), actor: update.updatedBy, action: '版本暂缓', detail: `${update.id} 机库已更新，本地存在离线改动，保留现场草稿待并入` });
          continue;
        }
        for (const change of update.changes) {
          if (TRACKED_FIELDS.some(({ key }) => key === change.key)) (card as unknown as Record<string, string>)[change.key] = change.to;
        }
        state.audit.unshift({ time: now(), actor: update.updatedBy, action: '同步最新版', detail: `${update.id} 已按机库最新版盖回：${update.changes.map((change) => change.field).join('、')}` });
      }
      for (const update of action.payload.signatureUpdates) {
        const signature = state.signatures.find((item) => item.stage === update.stage);
        if (!signature) continue;
        if (pending.has(`signature:${update.stage}`)) {
          state.audit.unshift({ time: now(), actor: update.actor, action: '版本暂缓', detail: `${update.stage}阶段机库已签署，本地存在离线签字尝试，保留待确认` });
          continue;
        }
        signature.status = '已签署';
        signature.actor = update.actor;
        signature.time = update.time;
        state.audit.unshift({ time: now(), actor: update.actor, action: '同步最新版', detail: `${update.stage}阶段已由机库签署，本地同步更新` });
      }
      state.serverVersion = action.payload.revision;
      state.syncVersion = action.payload.revision;
      state.lastSaved = now();
    },
    // 单项导入结果落库：成功、冲突待确认、失败保留，全程写审计。
    mergeItemResult(state, action: PayloadAction<{ requestId: string; outcome: ImportOutcome }>) {
      const item = state.offlineQueue.find((entry) => entry.requestId === action.payload.requestId);
      if (!item) return;
      const outcome = action.payload.outcome;
      item.attempts += 1;
      item.time = now();
      if (!outcome.ok) {
        if ('error' in outcome) {
          item.status = '失败';
          item.lastError = outcome.error;
          state.audit.unshift({ time: item.time, actor: '系统', action: '导入失败', detail: `${item.requestId} ${item.title}：${outcome.error}，可按原请求编号重试` });
        } else {
          item.status = '待确认';
          item.conflict = outcome.conflict;
          state.audit.unshift({ time: item.time, actor: '系统', action: '冲突待确认', detail: `${item.requestId} ${item.title}：同一项两边都改过（机库 R${outcome.conflict.serverVersion} · ${outcome.conflict.updatedBy}），双方记录已保留，未覆盖已签记录或放行基线` });
        }
        return;
      }
      item.status = '已合并';
      item.lastError = '';
      item.conflict = undefined;
      state.serverVersion = outcome.revision;
      state.syncVersion = outcome.revision;
      if (outcome.dedup) {
        item.note = '重复请求已去重';
        state.audit.unshift({ time: item.time, actor: '系统', action: '请求去重', detail: `${item.requestId} 已在服务端处理，重复请求自动去重` });
        return;
      }
      if (item.kind === 'signature') {
        const signature = state.signatures.find((entry) => entry.stage === item.targetId);
        if (signature) {
          signature.status = '已签署';
          signature.actor = item.actor;
          signature.time = item.time;
        }
        item.note = '签字已生效';
        state.audit.unshift({ time: item.time, actor: item.actor, action: '阶段签署', detail: `${item.requestId} ${item.targetId}阶段签字已并入基线 R${outcome.revision}` });
        return;
      }
      item.note = outcome.forced ? '保留现场改动，已强制并入' : '已并入机库基线';
      applyMergeSideEffects(state, item);
      state.audit.unshift({ time: item.time, actor: item.actor, action: outcome.forced ? '冲突解决' : '并入成功', detail: `${item.requestId} ${item.targetId} ${item.changes.map((change) => change.field).join('、')}已并入 R${outcome.revision}${outcome.forced ? '（保留现场改动）' : ''}` });
    },
    // 冲突确认：以机库最新版为准。工卡回退到服务端值；签字保留已签记录，本地尝试作废。
    resolveConflictUseServer(state, action: PayloadAction<string>) {
      const item = state.offlineQueue.find((entry) => entry.requestId === action.payload);
      if (!item || item.status !== '待确认' || !item.conflict) return;
      const conflict = item.conflict;
      if (item.kind === 'card') {
        const card = state.cards.find((entry) => entry.id === item.targetId);
        if (card) {
          for (const field of conflict.fields) {
            if (TRACKED_FIELDS.some(({ key }) => key === field.key)) (card as unknown as Record<string, string>)[field.key] = field.server;
          }
        }
        item.note = '以机库最新版为准';
        state.audit.unshift({ time: now(), actor: '宋杰 · 机械', action: '冲突解决', detail: `${item.requestId} ${item.targetId} 以机库最新版 R${conflict.serverVersion} 为准，现场改动保留在审计记录` });
      } else {
        const signature = state.signatures.find((entry) => entry.stage === item.targetId);
        if (signature) {
          signature.status = '已签署';
          signature.actor = conflict.updatedBy;
          signature.time = now();
        }
        item.note = '保留机库已签记录';
        state.audit.unshift({ time: now(), actor: '宋杰 · 机械', action: '冲突解决', detail: `${item.requestId} ${item.targetId}阶段保留机库已签记录（${conflict.updatedBy}），本地签字尝试作废` });
      }
      item.status = '已合并';
      item.conflict = undefined;
      item.attempts += 1;
      item.time = now();
      state.serverVersion = Math.max(state.serverVersion, conflict.serverVersion);
      state.syncVersion = state.serverVersion;
    }
  }
});

export const {
  selectCard,
  updateCard,
  setConflict,
  refreshVersion,
  toggleOffline,
  authorizeOverride,
  signStage,
  releasePackage,
  applyServerSnapshot,
  mergeItemResult,
  resolveConflictUseServer
} = slice.actions;

export const store = configureStore({
  reducer: { maintenance: slice.reducer, [maintenanceApi.reducerPath]: maintenanceApi.reducer },
  middleware: (getDefault) => getDefault().concat(maintenanceApi.middleware)
});

store.subscribe(() => {
  if (typeof localStorage !== 'undefined') localStorage.setItem('yy61-work-package', JSON.stringify(store.getState().maintenance));
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
