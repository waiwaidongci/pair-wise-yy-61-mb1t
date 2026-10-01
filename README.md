# pair-wise-yy-61 航空器定检工作包执行与放行审阅平台

支持工卡依赖、测量值容差校验、离线暂存、冲突提交提示、分阶段签字、版本差异和放行锁定。超差项目必须由授权人员处理后才能继续。

离线合并：断网期间的工卡改动与签字尝试带请求编号和基线版本进入离线队列；回网后先按机库最新版盖回未冲突项，再逐项并入。同一项两边都改过则保留双方记录待人工确认，不覆盖已签记录与放行基线；证据更新会使受影响签字退回待签，已放行包退回审阅；导入失败保留现场改动，可按原请求编号幂等重试。

## 技术栈

React、Fluent UI、Redux Toolkit、React Router、RTK Query、Vite、TypeScript。

## 运行

```bash
npm install
npm run dev
```

访问 `http://localhost:62061`。工卡草稿和审计操作保存在 `localStorage`。

```bash
npm run build
```
