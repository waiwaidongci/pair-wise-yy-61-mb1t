// 模拟机库服务端：保存权威基线、接收离线导入（按请求编号幂等）、检测双向冲突。
// 真实环境中这些逻辑在 MRO 系统服务端，这里用模块内状态模拟。

export type QueueChange = { key: string; field: string; from: string; to: string };

export type ConflictField = { key: string; field: string; local: string; server: string };

export type ImportRequest = {
  requestId: string;
  kind: 'card' | 'signature';
  targetId: string;
  changes: QueueChange[];
  baselineVersion: number;
  actor: string;
};

export type ImportOutcome =
  | { ok: true; dedup: boolean; forced: boolean; revision: number }
  | { ok: false; error: string }
  | { ok: false; conflict: { serverVersion: number; updatedBy: string; fields: ConflictField[] } };

export type HangarSnapshot = {
  revision: number;
  cardUpdates: { id: string; updatedBy: string; changes: QueueChange[] }[];
  signatureUpdates: { stage: string; actor: string; time: string }[];
};

type ServerCard = {
  measurement: string;
  finding: string;
  evidence: string;
  status: string;
  version: number;
  updatedBy: string;
  lastChanges: QueueChange[];
};

type ServerSignature = { status: '待签署' | '已签署'; actor: string; time: string };

const CARD_FIELDS = ['measurement', 'finding', 'evidence', 'status'] as const;
type CardFieldKey = (typeof CARD_FIELDS)[number];
const isCardField = (key: string): key is CardFieldKey => (CARD_FIELDS as readonly string[]).includes(key);

const now = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

const server = {
  revision: 7,
  cards: {
    'CARD-01': { measurement: '1.62 mm', finding: '正常', evidence: '近照 + 动作记录', status: '已完成', version: 7, updatedBy: '赵明 · 机械师', lastChanges: [] },
    'CARD-02': { measurement: '', finding: '', evidence: '孔探照片 + 视频', status: '执行中', version: 7, updatedBy: '宋杰', lastChanges: [] },
    'CARD-03': { measurement: '2762 psi', finding: '低于容差，等待授权', evidence: '压力仪记录', status: '待授权', version: 6, updatedBy: '宋杰', lastChanges: [] },
    'CARD-04': { measurement: '剩余 836 循环', finding: '正常', evidence: '件号照片 + 履历页', status: '已完成', version: 7, updatedBy: '检验员', lastChanges: [] },
    'CARD-05': { measurement: '', finding: '', evidence: '施工记录 + 签署', status: '未开始', version: 7, updatedBy: '放行人员', lastChanges: [] },
    'CARD-06': { measurement: '', finding: '', evidence: '清单复核', status: '未开始', version: 7, updatedBy: '客舱检验', lastChanges: [] },
    'CARD-07': { measurement: '', finding: '', evidence: '试车数据 + 油样', status: '未开始', version: 5, updatedBy: '动力工程师', lastChanges: [] },
    'CARD-08': { measurement: '发现 2 次压力偏低', finding: '移交可靠性分析', evidence: '近 3 次记录', status: '执行中', version: 7, updatedBy: '质量经理', lastChanges: [] }
  } as Record<string, ServerCard>,
  signatures: {
    机械: { status: '已签署', actor: '赵明 · 机械师', time: '09:18' },
    系统: { status: '待签署', actor: '待指定', time: '-' },
    动力: { status: '待签署', actor: '待指定', time: '-' },
    放行: { status: '待签署', actor: '质量经理', time: '-' }
  } as Record<string, ServerSignature>,
  processed: new Set<string>(),
  hangarUpdateApplied: false
};

// 飞机回机库后，服务端已按最新版 R8 推进：部分工卡被机库班组更新、系统阶段已签署。
export function simulateHangarUpdate(): HangarSnapshot {
  if (server.hangarUpdateApplied) return { revision: server.revision, cardUpdates: [], signatureUpdates: [] };
  server.hangarUpdateApplied = true;
  server.revision = 8;
  const card02 = server.cards['CARD-02'];
  card02.measurement = '0.18 mm（2 处凹坑）';
  card02.finding = '机库复核：容差内，继续监控';
  card02.version = 8;
  card02.updatedBy = '机库二班组 · 王工';
  card02.lastChanges = [
    { key: 'measurement', field: '测量值', from: '', to: card02.measurement },
    { key: 'finding', field: '发现与处置', from: '', to: card02.finding }
  ];
  const card05 = server.cards['CARD-05'];
  card05.evidence = '施工记录 + 签署 + 现场照片';
  card05.status = '执行中';
  card05.version = 8;
  card05.updatedBy = '机库资料员 · 陈晨';
  card05.lastChanges = [
    { key: 'evidence', field: '证据要求', from: '施工记录 + 签署', to: card05.evidence },
    { key: 'status', field: '状态', from: '未开始', to: '执行中' }
  ];
  const system = server.signatures['系统'];
  system.status = '已签署';
  system.actor = '王倩 · 系统工程师';
  system.time = '10:42';
  return {
    revision: server.revision,
    cardUpdates: [
      { id: 'CARD-02', updatedBy: card02.updatedBy, changes: card02.lastChanges },
      { id: 'CARD-05', updatedBy: card05.updatedBy, changes: card05.lastChanges }
    ],
    signatureUpdates: [{ stage: '系统', actor: system.actor, time: system.time }]
  };
}

const requestHash = (requestId: string) => [...requestId].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);

// 离线导入：同一请求编号幂等；双向改动返回冲突；已签记录不可覆盖。
export function importOfflineItem(item: ImportRequest, attempt: number, options?: { force?: boolean }): ImportOutcome {
  if (server.processed.has(item.requestId)) {
    return { ok: true, dedup: true, forced: false, revision: server.revision };
  }
  // 模拟不稳定网络：部分请求首次导入失败（服务端未写入），按原请求编号重试即可成功。
  if (attempt === 1 && requestHash(item.requestId) % 2 === 0) {
    return { ok: false, error: '证据服务 503：上传超时，服务端未写入，现场改动已保留' };
  }
  if (item.kind === 'signature') {
    const signature = server.signatures[item.targetId];
    if (signature && signature.status === '已签署') {
      return {
        ok: false,
        conflict: {
          serverVersion: server.revision,
          updatedBy: signature.actor,
          fields: [{ key: 'signature', field: '阶段签字', local: `已签署（${item.actor}）`, server: `已签署（${signature.actor} · ${signature.time}）` }]
        }
      };
    }
    if (signature) {
      signature.status = '已签署';
      signature.actor = item.actor;
      signature.time = now();
    }
    server.revision += 1;
    server.processed.add(item.requestId);
    return { ok: true, dedup: false, forced: false, revision: server.revision };
  }
  const card = server.cards[item.targetId];
  if (!card) return { ok: false, error: `服务端未找到 ${item.targetId}` };
  if (!options?.force && card.version > item.baselineVersion) {
    const keys = new Set([...item.changes.map((change) => change.key), ...card.lastChanges.map((change) => change.key)]);
    const fields: ConflictField[] = [...keys].map((key) => {
      const local = item.changes.find((change) => change.key === key);
      const remote = card.lastChanges.find((change) => change.key === key);
      return {
        key,
        field: local?.field ?? remote?.field ?? key,
        local: local ? local.to : '（未改动）',
        server: remote ? remote.to : isCardField(key) ? card[key] : ''
      };
    });
    return { ok: false, conflict: { serverVersion: card.version, updatedBy: card.updatedBy, fields } };
  }
  for (const change of item.changes) {
    if (isCardField(change.key)) card[change.key] = change.to;
  }
  server.revision += 1;
  card.version = server.revision;
  card.updatedBy = item.actor;
  card.lastChanges = item.changes;
  server.processed.add(item.requestId);
  return { ok: true, dedup: false, forced: Boolean(options?.force), revision: server.revision };
}
