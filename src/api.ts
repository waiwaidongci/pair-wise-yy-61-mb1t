import { createApi } from '@reduxjs/toolkit/query/react';
import type { BaseQueryFn } from '@reduxjs/toolkit/query';

export type WorkCard = {
  id: string;
  title: string;
  zone: string;
  revision: string;
  estimated: number;
  dependencies: string[];
  tolerance: string;
  evidence: string;
  witness: string;
  status: '未开始' | '执行中' | '待授权' | '已完成';
  measurement: string;
  finding: string;
  stage: string;
};

/** 离线期间记录的一次改动（工卡改动 / 签字尝试 / 证据更新 / 放行锁定） */
export type OfflineChange = {
  requestId: string;
  type: 'card' | 'signature' | 'evidence' | 'release';
  targetId: string;
  label: string;
  payload: Record<string, unknown>;
  /** 改动所基于的基线版本 */
  baseVersion: number;
  createdAt: string;
  status: '待并入' | '已并入' | '待确认' | '失败';
  error?: string;
  attempts: number;
  /** 冲突时服务器侧的最新值与原因 */
  serverField?: string;
  serverValue?: string;
  serverReason?: string;
};

/** 合并导入的逐项结果 */
export type MergeOutcome = {
  requestId: string;
  status: '已并入' | '待确认' | '失败';
  reason?: string;
  /** 冲突字段与服务器最新值（干净值，可用于回退现场改动） */
  serverField?: string;
  serverValue?: string;
  /** 证据更新后需要重新待签的阶段 */
  revertSignatures?: string[];
  /** 证据更新后已放行包需要退回审阅 */
  releaseReverted?: boolean;
};

export type MergeResult = { outcomes: MergeOutcome[]; serverRevision: number };

const packageData = {
  id: 'WP-B7891-04',
  aircraft: 'B-7891',
  type: 'B737-800',
  check: '48A 定检',
  station: '上海浦东 · H3 机库',
  plannedStart: '2026-09-28 06:00',
  plannedEnd: '2026-09-30 18:00',
  revision: 'WP R7',
  serverRevision: 7,
  tasks: [
    { id: 'CARD-01', title: '右主起落架收放检查', zone: '起落架舱 RH', revision: 'R7', estimated: 3.5, dependencies: [], tolerance: '间隙 1.2–2.0 mm', evidence: '近照 + 动作记录', witness: '检验员', status: '已完成', measurement: '1.62 mm', finding: '正常', stage: '机械签署' },
    { id: 'CARD-02', title: '发动机 2 风扇叶片孔探', zone: '发动机 2', revision: 'R7', estimated: 4.2, dependencies: ['CARD-01'], tolerance: '凹坑 ≤ 0.3 mm', evidence: '孔探照片 + 视频', witness: '发动机工程师', status: '执行中', measurement: '', finding: '', stage: '发动机签署' },
    { id: 'CARD-03', title: '液压系统压力保持测试', zone: '轮舱 / 系统 A', revision: 'R6', estimated: 2.0, dependencies: ['CARD-01'], tolerance: '≥ 2850 psi / 10 min', evidence: '压力仪记录', witness: '质量检验', status: '待授权', measurement: '2762 psi', finding: '低于容差，等待授权', stage: '系统签署' },
    { id: 'CARD-04', title: '前起落架时寿件核对', zone: '前起落架', revision: 'R7', estimated: 1.5, dependencies: [], tolerance: '剩余循环 ≥ 500', evidence: '件号照片 + 履历页', witness: '检验员', status: '已完成', measurement: '剩余 836 循环', finding: '正常', stage: '适航签署' },
    { id: 'CARD-05', title: 'AD 2024-15-03 执行确认', zone: '机身后段', revision: 'R7', estimated: 2.5, dependencies: ['CARD-04'], tolerance: '按 AD 标准施工', evidence: '施工记录 + 签署', witness: '放行人员', status: '未开始', measurement: '', finding: '', stage: '适航签署' },
    { id: 'CARD-06', title: '客舱应急设备检查', zone: '客舱全舱', revision: 'R7', estimated: 2.8, dependencies: [], tolerance: '全部在有效期内', evidence: '清单复核', witness: '客舱检验', status: '未开始', measurement: '', finding: '', stage: '客舱签署' },
    { id: 'CARD-07', title: 'APU 排故后试车', zone: 'APU 舱', revision: 'R5', estimated: 3.0, dependencies: ['CARD-03'], tolerance: '参数在 AMM 范围', evidence: '试车数据 + 油样', witness: '动力工程师', status: '未开始', measurement: '', finding: '', stage: '动力签署' },
    { id: 'CARD-08', title: '重复缺陷趋势复核', zone: '全机', revision: 'R7', estimated: 1.0, dependencies: ['CARD-02', 'CARD-03'], tolerance: '无新增重复缺陷', evidence: '近 3 次记录', witness: '质量经理', status: '执行中', measurement: '发现 2 次压力偏低', finding: '移交可靠性分析', stage: '放行签署' }
  ] as WorkCard[]
};

const mockBaseQuery: BaseQueryFn = async (arg) => {
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (typeof arg === 'string' && arg === 'package') return { data: packageData };
  if (typeof arg === 'object' && arg !== null && 'url' in arg) {
    const request = arg as { url: string };
    if (request.url === 'package') return { data: packageData };
  }
  return { error: { status: 404, data: 'Not found' } };
};

/** 阶段签署 -> 绑定的工卡（证据更新联动签字用） */
const stageToCard: Record<string, string> = { '机械': 'CARD-01', '系统': 'CARD-03', '动力': 'CARD-07', '放行': 'CARD-08' };

/** 服务器在最新版 R8 上已变更的字段（本地草稿基于 R7，回网合并时逐项比对） */
const serverFieldChanges: Record<string, string[]> = {
  'CARD-03': ['tolerance', 'status'],
  'CARD-07': ['dependencies'],
  'CARD-08': ['evidence']
};

const serverFieldLabels: Record<string, string> = {
  tolerance: '容差',
  status: '状态',
  dependencies: '依赖',
  evidence: '证据',
  measurement: '测量值',
  finding: '发现与处置'
};

const serverFieldValues: Record<string, Record<string, string>> = {
  'CARD-03': {
    tolerance: '≥ 2850 psi / 10 min（AMM 临时修订 TR-114）',
    status: '执行中（服务器已记录授权继续）'
  },
  'CARD-07': { dependencies: 'CARD-03（试车前置条件调整）' },
  'CARD-08': { evidence: '近 3 次记录（可靠性复核要求）' }
};

/** 服务器最新基线版本（比本地缓存 R7 新一版） */
let serverRevision = 8;
/** 导入调用计数：首次导入模拟一次瞬时失败，验证失败项保留与原编号重试 */
let importAttempts = 0;

export const maintenanceApi = createApi({
  reducerPath: 'maintenanceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Package'],
  endpoints: (builder) => ({
    getWorkPackage: builder.query<typeof packageData, void>({
      query: () => 'package',
      providesTags: ['Package']
    }),
    submitCard: builder.mutation<{ accepted: boolean; revision: number }, { cardId: string; expectedRevision: number; measurement: string; finding: string }>({
      queryFn: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 240));
        if (payload.expectedRevision !== packageData.serverRevision) {
          return { error: { status: 409, data: { message: '版本冲突：服务器已有更新，请刷新后重试。' } } };
        }
        return { data: { accepted: true, revision: packageData.serverRevision + 1 } };
      },
      invalidatesTags: ['Package']
    }),
    importOfflineChanges: builder.mutation<MergeResult, OfflineChange[]>({
      queryFn: async (changes) => {
        await new Promise((resolve) => setTimeout(resolve, 380));
        importAttempts += 1;
        if (importAttempts === 1) {
          return {
            error: {
              status: 503,
              data: { message: '导入服务暂时不可用，请稍后重试；现场改动已保留，重试仍使用原请求编号。' }
            }
          };
        }
        const evidenceInBatch = changes.some((change) => change.type === 'evidence');
        const outcomes: MergeOutcome[] = changes.map((change) => {
          if (change.type === 'card') {
            const fields = Object.keys(change.payload).filter((field) => ['measurement', 'finding', 'status'].includes(field));
            const hit = fields.find((field) => serverFieldChanges[change.targetId]?.includes(field));
            if (change.baseVersion < serverRevision && hit) {
              return {
                requestId: change.requestId,
                status: '待确认',
                reason: `服务器已将${serverFieldLabels[hit] ?? hit}更新至最新版 R${serverRevision}，现场改动与服务器版本不一致，请确认保留现场改动或采用服务器版本。`,
                serverField: hit,
                serverValue: hit === 'status' ? '执行中' : serverFieldValues[change.targetId]?.[hit]
              };
            }
            serverRevision += 1;
            return { requestId: change.requestId, status: '已并入' };
          }
          if (change.type === 'signature') {
            const cardId = stageToCard[change.targetId];
            const evidenceChanged =
              change.baseVersion < serverRevision && Boolean(cardId) && (serverFieldChanges[cardId]?.includes('evidence') ?? false);
            return { requestId: change.requestId, status: '已并入', revertSignatures: evidenceChanged ? [change.targetId] : [] };
          }
          if (change.type === 'evidence') {
            serverRevision += 1;
            const affected = Object.entries(stageToCard)
              .filter(([, cardId]) => serverFieldChanges[cardId]?.includes('evidence'))
              .map(([stage]) => stage);
            return { requestId: change.requestId, status: '已并入', revertSignatures: affected, releaseReverted: true };
          }
          if (change.type === 'release') {
            return { requestId: change.requestId, status: '已并入', releaseReverted: false };
          }
          return { requestId: change.requestId, status: '已并入' };
        });
        // 证据更新会连带回退同一批次里的签字尝试与放行锁定
        const revertedStages = new Set(outcomes.flatMap((outcome) => outcome.revertSignatures ?? []));
        for (const outcome of outcomes) {
          if (outcome.status === '已并入' && changes.find((change) => change.requestId === outcome.requestId)?.type === 'release') {
            outcome.releaseReverted = evidenceInBatch || revertedStages.size > 0;
          }
        }
        return { data: { outcomes, serverRevision } };
      }
    })
  })
});

export const { useGetWorkPackageQuery, useSubmitCardMutation, useImportOfflineChangesMutation } = maintenanceApi;
