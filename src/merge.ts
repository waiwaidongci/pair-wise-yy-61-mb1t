import { importOfflineItem, simulateHangarUpdate, type ImportRequest } from './server';
import { applyServerSnapshot, mergeItemResult, resolveConflictUseServer, store, type OfflineQueueItem } from './store';

// 回网：先拉取机库最新版盖回本地（本地有离线改动的项暂缓，留给合并流程）。
export function syncHangarVersion() {
  store.dispatch(applyServerSnapshot(simulateHangarUpdate()));
}

const toImportRequest = (item: OfflineQueueItem): ImportRequest => ({
  requestId: item.requestId,
  kind: item.kind,
  targetId: item.targetId,
  changes: item.changes,
  baselineVersion: item.baselineVersion,
  actor: item.actor
});

// 单项并入；失败项按原请求编号重试也走这里（请求编号不变，服务端幂等）。
export function mergeQueueItem(requestId: string) {
  const item = store.getState().maintenance.offlineQueue.find((entry) => entry.requestId === requestId);
  if (!item || (item.status !== '待合并' && item.status !== '失败')) return;
  const outcome = importOfflineItem(toImportRequest(item), item.attempts + 1);
  store.dispatch(mergeItemResult({ requestId: item.requestId, outcome }));
}

// 回网后逐项并入全部待合并项（按入队先后，先入先并）。
export function mergePendingItems() {
  const pending = store.getState().maintenance.offlineQueue.filter((entry) => entry.status === '待合并');
  for (const item of [...pending].reverse()) mergeQueueItem(item.requestId);
}

// 冲突确认：保留现场改动（强制并入）或以机库最新版为准。
export function resolveConflict(requestId: string, choice: 'local' | 'server') {
  const item = store.getState().maintenance.offlineQueue.find((entry) => entry.requestId === requestId);
  if (!item || item.status !== '待确认') return;
  if (choice === 'server') {
    store.dispatch(resolveConflictUseServer(requestId));
    return;
  }
  const outcome = importOfflineItem(toImportRequest(item), item.attempts + 1, { force: true });
  store.dispatch(mergeItemResult({ requestId: item.requestId, outcome }));
}
