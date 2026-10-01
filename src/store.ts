import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { maintenanceApi, type MergeOutcome, type OfflineChange } from './api';

export type StageSignature = { stage: string; status: '待签署' | '已签署'; actor: string; time: string };
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
  evidenceVersion: number;
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
  releaseRolledBack: boolean;
  audit: AuditEntry[];
  /** 断网期间积累的离线改动队列，回网后逐项并入 */
  outbox: OfflineChange[];
};

const initialCards: OfflineCard[] = [
  { id: 'CARD-01', title: '右主起落架收放检查', zone: '起落架舱 RH', estimated: 3.5, dependencies: [], tolerance: '间隙 1.2–2.0 mm', evidence: '近照 + 动作记录', witness: '检验员', status: '已完成', measurement: '1.62 mm', finding: '正常', stage: '机械签署', evidenceVersion: 0 },
  { id: 'CARD-02', title: '发动机 2 风扇叶片孔探', zone: '发动机 2', estimated: 4.2, dependencies: ['CARD-01'], tolerance: '凹坑 ≤ 0.3 mm', evidence: '孔探照片 + 视频', witness: '发动机工程师', status: '执行中', measurement: '', finding: '', stage: '发动机签署', evidenceVersion: 0 },
  { id: 'CARD-03', title: '液压系统压力保持测试', zone: '轮舱 / 系统 A', estimated: 2.0, dependencies: ['CARD-01'], tolerance: '≥ 2850 psi / 10 min', evidence: '压力仪记录', witness: '质量检验', status: '待授权', measurement: '2762 psi', finding: '低于容差，等待授权', stage: '系统签署', evidenceVersion: 0 },
  { id: 'CARD-04', title: '前起落架时寿件核对', zone: '前起落架', estimated: 1.5, dependencies: [], tolerance: '剩余循环 ≥ 500', evidence: '件号照片 + 履历页', witness: '检验员', status: '已完成', measurement: '剩余 836 循环', finding: '正常', stage: '适航签署', evidenceVersion: 0 },
  { id: 'CARD-05', title: 'AD 2024-15-03 执行确认', zone: '机身后段', estimated: 2.5, dependencies: ['CARD-04'], tolerance: '按 AD 标准施工', evidence: '施工记录 + 签署', witness: '放行人员', status: '未开始', measurement: '', finding: '', stage: '适航签署', evidenceVersion: 0 },
  { id: 'CARD-06', title: '客舱应急设备检查', zone: '客舱全舱', estimated: 2.8, dependencies: [], tolerance: '全部在有效期内', evidence: '清单复核', witness: '客舱检验', status: '未开始', measurement: '', finding: '', stage: '客舱签署', evidenceVersion: 0 },
  { id: 'CARD-07', title: 'APU 排故后试车', zone: 'APU 舱', estimated: 3.0, dependencies: ['CARD-03'], tolerance: '参数在 AMM 范围', evidence: '试车数据 + 油样', witness: '动力工程师', status: '未开始', measurement: '', finding: '', stage: '动力签署', evidenceVersion: 0 },
  { id: 'CARD-08', title: '重复缺陷趋势复核', zone: '全机', estimated: 1.0, dependencies: ['CARD-02', 'CARD-03'], tolerance: '无新增重复缺陷', evidence: '近 3 次记录', witness: '质量经理', status: '执行中', measurement: '发现 2 次压力偏低', finding: '移交可靠性分析', stage: '放行签署', evidenceVersion: 0 }
];

const defaultSignatures: StageSignature[] = [
  { stage: '机械', status: '已签署', actor: '赵明 · 机械师', time: '09:18' },
  { stage: '系统', status: '待签署', actor: '待指定', time: '-' },
  { stage: '动力', status: '待签署', actor: '待指定', time: '-' },
  { stage: '放行', status: '待签署', actor: '质量经理', time: '-' }
];

const defaultAudit: AuditEntry[] = [
  { time: '08:54', actor: '赵明', action: '完成工卡', detail: 'CARD-01 间隙测量 1.62 mm' },
  { time: '09:05', actor: '宋杰', action: '提交测量', detail: 'CARD-03 压力 2762 psi，低于容差' },
  { time: '09:20', actor: '系统', action: '阻断', detail: 'CARD-03 等待授权处理' }
];

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

let requestSeq = 0;
function genRequestId() {
  requestSeq += 1;
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `REQ-${stamp}-${String(requestSeq).padStart(4, '0')}`;
}

function mergeDefaults(saved: Partial<MaintenanceState> | null): MaintenanceState {
  return {
    cards: (saved?.cards ?? initialCards).map((card) => ({ ...card, evidenceVersion: card.evidenceVersion ?? 0 })),
    activeCardId: saved?.activeCardId ?? 'CARD-03',
    syncVersion: saved?.syncVersion ?? 7,
    serverVersion: saved?.serverVersion ?? 7,
    offline: saved?.offline ?? false,
    lastSaved: saved?.lastSaved ?? '09:46',
    conflictMessage: saved?.conflictMessage ?? '',
    signatures: saved?.signatures ?? defaultSignatures,
    released: saved?.released ?? false,
    releaseRolledBack: saved?.releaseRolledBack ?? false,
    audit: saved?.audit ?? defaultAudit,
    outbox: saved?.outbox ?? []
  };
}

const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('yy61-work-package') : null;
const saved = raw ? (JSON.parse(raw) as Partial<MaintenanceState>) : null;
const initialState: MaintenanceState = mergeDefaults(saved);

/** 离线时把改动记入队列；在线时改动直接走提交通路，不留队列 */
function enqueueOfflineChange(
  state: MaintenanceState,
  entry: Omit<OfflineChange, 'requestId' | 'createdAt' | 'status' | 'attempts'>
) {
  if (!state.offline) return;
  state.outbox.unshift({ ...entry, requestId: genRequestId(), createdAt: nowTime(), status: '待并入', attempts: 0 });
}

/** 证据更新后：受影响签字重新待签，已放行包退回审阅 */
function applyEvidenceRepercussions(state: MaintenanceState, card: OfflineCard) {
  const stage = card.stage.replace('签署', '');
  const signature = state.signatures.find((item) => item.stage === stage);
  if (signature && signature.status === '已签署') {
    signature.status = '待签署';
    signature.actor = '待指定';
    signature.time = '-';
    state.audit.unshift({ time: nowTime(), actor: '证据联动', action: '签字回退', detail: `证据更新，${stage}签字重新待签（${card.id}）` });
  }
  if (state.released) {
    state.released = false;
    state.releaseRolledBack = true;
    state.audit.unshift({ time: nowTime(), actor: '证据联动', action: '基线退回', detail: `证据更新，已放行包退回审阅（${card.id}）` });
  }
}

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
      const baseVersion = state.syncVersion;
      Object.assign(card, action.payload);
      state.syncVersion += 1;
      state.lastSaved = nowTime();
      state.audit.unshift({ time: state.lastSaved, actor: '当前用户', action: '离线暂存', detail: `${card.id} 已保存本地草稿` });
      const payload: OfflineChange['payload'] = {};
      for (const key of ['measurement', 'finding', 'status'] as const) {
        if (action.payload[key] !== undefined) payload[key] = action.payload[key];
      }
      enqueueOfflineChange(state, { type: 'card', targetId: card.id, label: `${card.id} ${card.title}`, payload, baseVersion });
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
      const baseVersion = state.syncVersion;
      card.status = '执行中';
      card.finding = '超差已由授权人员批准，按工程指令继续';
      state.syncVersion += 1;
      state.audit.unshift({ time: nowTime(), actor: '放行授权人', action: '授权继续', detail: `${card.id} 超差放行审批` });
      enqueueOfflineChange(state, {
        type: 'card',
        targetId: card.id,
        label: `${card.id} ${card.title}`,
        payload: { status: card.status, finding: card.finding },
        baseVersion
      });
    },
    signStage(state, action: PayloadAction<string>) {
      const signature = state.signatures.find((item) => item.stage === action.payload);
      if (!signature) return;
      const baseVersion = state.syncVersion;
      signature.status = '已签署';
      signature.actor = `${action.payload}负责人`;
      signature.time = nowTime();
      state.audit.unshift({ time: signature.time, actor: signature.actor, action: '阶段签署', detail: `${action.payload}阶段确认完成` });
      enqueueOfflineChange(state, {
        type: 'signature',
        targetId: action.payload,
        label: `${action.payload}签署尝试`,
        payload: { stage: action.payload },
        baseVersion
      });
    },
    releasePackage(state) {
      const hasBlockers = state.cards.some((card) => card.status === '待授权');
      const allSigned = state.signatures.every((item) => item.status === '已签署');
      if (!hasBlockers && allSigned) {
        const baseVersion = state.syncVersion;
        state.released = true;
        state.releaseRolledBack = false;
        state.audit.unshift({ time: nowTime(), actor: '质量经理', action: '锁定放行', detail: '工作包 R7 已锁定并形成放行基线' });
        enqueueOfflineChange(state, { type: 'release', targetId: 'package', label: '放行锁定', payload: { released: true }, baseVersion });
      }
    },
    updateEvidence(state, action: PayloadAction<string>) {
      const card = state.cards.find((item) => item.id === action.payload);
      if (!card) return;
      const baseVersion = state.syncVersion;
      card.evidenceVersion += 1;
      state.syncVersion += 1;
      state.lastSaved = nowTime();
      state.audit.unshift({ time: nowTime(), actor: '当前用户', action: '证据更新', detail: `${card.id} 证据已更新至第 ${card.evidenceVersion} 版` });
      applyEvidenceRepercussions(state, card);
      enqueueOfflineChange(state, {
        type: 'evidence',
        targetId: card.id,
        label: `${card.id} 证据更新`,
        payload: { evidenceVersion: card.evidenceVersion },
        baseVersion
      });
    },
    /** 合并导入成功：逐项并入；冲突项保留待确认；失败项保留待重试 */
    applyMergeResults(state, action: PayloadAction<{ outcomes: MergeOutcome[]; serverRevision: number }>) {
      for (const outcome of action.payload.outcomes) {
        const item = state.outbox.find((candidate) => candidate.requestId === outcome.requestId);
        if (!item) continue;
        item.attempts += 1;
        if (outcome.status === '已并入') {
          item.status = '已并入';
          item.error = undefined;
          if (item.type === 'card') {
            const card = state.cards.find((candidate) => candidate.id === item.targetId);
            if (card) Object.assign(card, item.payload);
          }
          if (outcome.revertSignatures?.length) {
            for (const stage of outcome.revertSignatures) {
              const signature = state.signatures.find((candidate) => candidate.stage === stage);
              if (signature && signature.status === '已签署') {
                signature.status = '待签署';
                signature.actor = '待指定';
                signature.time = '-';
                state.audit.unshift({ time: nowTime(), actor: '证据联动', action: '签字回退', detail: `证据更新，${stage}签字重新待签（${item.requestId}）` });
              }
            }
          }
          if (outcome.releaseReverted && state.released) {
            state.released = false;
            state.releaseRolledBack = true;
            state.audit.unshift({ time: nowTime(), actor: '证据联动', action: '基线退回', detail: `证据更新，已放行包退回审阅（${item.requestId}）` });
          }
          state.audit.unshift({
            time: nowTime(),
            actor: '合并服务',
            action: '离线并入',
            detail: `${item.label} 已并入基线（${item.requestId}）`
          });
        } else if (outcome.status === '待确认') {
          item.status = '待确认';
          item.serverField = outcome.serverField;
          item.serverValue = outcome.serverValue;
          item.serverReason = outcome.reason;
          state.audit.unshift({
            time: nowTime(),
            actor: '合并服务',
            action: '冲突待确认',
            detail: `${item.label} 现场改动与服务器版本不一致，保留待确认（${item.requestId}）`
          });
        } else {
          item.status = '失败';
          item.error = outcome.reason ?? '导入失败，请按原请求编号重试。';
        }
      }
      // 兜底：并入后若仍有阶段未签，放行基线不得保持锁定
      if (state.released && state.signatures.some((signature) => signature.status === '待签署')) {
        state.released = false;
        state.releaseRolledBack = true;
        state.audit.unshift({ time: nowTime(), actor: '合并服务', action: '基线退回', detail: '存在未重新签署的阶段，已放行包退回审阅' });
      }
      state.serverVersion = action.payload.serverRevision;
      state.syncVersion = action.payload.serverRevision;
      state.conflictMessage = '';
    },
    /** 导入整体失败：失败项保留，可按原请求编号重试 */
    markImportFailed(state, action: PayloadAction<{ requestIds: string[]; error: string }>) {
      for (const requestId of action.payload.requestIds) {
        const item = state.outbox.find((candidate) => candidate.requestId === requestId);
        if (item && item.status !== '已并入') {
          item.status = '失败';
          item.error = action.payload.error;
          item.attempts += 1;
        }
      }
      state.audit.unshift({
        time: nowTime(),
        actor: '合并服务',
        action: '导入失败',
        detail: `离线导入失败：${action.payload.error}；现场改动与失败项已保留，可按原请求编号重试`
      });
    },
    /** 冲突待确认项：保留现场改动 / 采用服务器版本，两种选择都留痕 */
    resolveConflict(state, action: PayloadAction<{ requestId: string; keepLocal: boolean }>) {
      const item = state.outbox.find((candidate) => candidate.requestId === action.payload.requestId);
      if (!item || item.status !== '待确认') return;
      if (action.payload.keepLocal) {
        if (item.type === 'card') {
          const card = state.cards.find((candidate) => candidate.id === item.targetId);
          if (card) Object.assign(card, item.payload);
        }
        state.audit.unshift({ time: nowTime(), actor: '当前用户', action: '冲突确认', detail: `保留现场改动：${item.label}（${item.requestId}）` });
      } else {
        if (item.type === 'card' && item.serverField && item.serverValue !== undefined) {
          const card = state.cards.find((candidate) => candidate.id === item.targetId);
          if (card) (card as Record<string, unknown>)[item.serverField] = item.serverValue;
        }
        state.audit.unshift({ time: nowTime(), actor: '当前用户', action: '冲突确认', detail: `采用服务器版本，放弃现场改动：${item.label}（${item.requestId}）` });
      }
      item.status = '已并入';
      item.error = undefined;
      state.syncVersion += 1;
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
  updateEvidence,
  applyMergeResults,
  markImportFailed,
  resolveConflict
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
