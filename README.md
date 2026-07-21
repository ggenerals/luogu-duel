# VJudge Duel

VJudge Duel 是一个基于 Lockout 赛制的在线编程竞技平台，支持用户组建单人或多人的小队，在随机生成的题目集上进行实时对抗。平台目前整合了 CodeForces、AtCoder 和 Luogu 三大主流在线评测系统（OJ），选手通过率先解决题目获取对应分值，率先达到总分阈值（通常为总分的一半或略低）的队伍即获得胜利。

本项目不仅是一个竞技平台，更是一次前沿的技术实验。我们在**无完整后端服务器**的架构下，实现了准实时的状态同步与远程判题功能，如此强劲，令人惊叹。

自去年 7 月进入测试阶段以来，Duel 获得了社区的广泛支持与积极参与。截至目前，平台已成功举办上千场对决，注册活跃用户逾百人。随着核心功能的全面上线，我们诚邀广大算法竞赛爱好者组建战队，切磋技艺，一较高下。

本项目采用 GNU GPLv3 开源

## 核心功能

- **多平台题目来源**：支持从洛谷、Codeforces 和 AtCoder 获取题目 
- **实时同步**：使用 WebSockets 和 Durable Objects 实现低延迟状态更新 
- **自动判题**：集成 VJudge API 轮询提交状态并自动更新比赛结果 

## 技术栈

| 层级 | 技术 | 作用 |
|------|------|------|
| **前端** | Preact + Vite | 轻量级 SPA，用于 UI 和状态管理   |
| **后端** | Cloudflare Workers | 无服务器执行环境   |
| **状态/存储** | Durable Objects + SQLite | 每房间分布式一致性，SQL 持久化 |
| **认证** | ECDSA + OAuth | 本地加密签名结合 VJudge 和 ~~CP OAuth~~ （已删除，因为其不支持 VJudge 的绑定 |

## 系统架构

系统采用事件溯源模型，比赛状态通过重放 `DuelEvent` 对象序列来计算，确保客户端和服务器在相同历史记录下到达完全相同的状态。 

### 实时房间模型

每个房间由唯一的 Cloudflare Durable Object 实例支持，管理包含该特定比赛事件日志的 SQLite 数据库。

1. 浏览器使用本地 ECDSA 密钥对事件进行签名
2. 浏览器通过 `/api/rooms/:roomId/ws?secret=...` 发送事件
3. 房间 Durable Object 在广播前将信封存储在 SQLite 中
4. 重连客户端在 WebSocket 握手中接收完整的有序快照
5. `/api/rooms/:roomId/snapshot` 和 `/event` 是 HTTP 回退路径

## 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

这将构建项目并在端口 7860 上启动 Wrangler 开发服务器。 

### 构建

```bash
npm run build
```

### 部署到 Cloudflare

```bash
wrangler deploy
``` 

## 项目结构

- `src/main.tsx` - 主要的前端应用逻辑和 UI 组件 
- `src/worker.ts` - Cloudflare Worker 后端和 Durable Object 实现
- `src/domain.ts` - 领域逻辑和状态管理 
- `src/problemPicker.ts` - 题目选择和平台处理 

## 主要特性

### 身份认证

用户拥有两层身份：存储在 `localStorage` 中的 `LocalIdentity`（私钥）对每个操作（聊天、认领、开始）进行签名，可选择通过挑战响应机制链接到 VJudge 账户。 

### 题目选择

`problemPicker` 处理难度标准化和从离线缓存的题库中进行平衡采样，支持自定义题目输入。 

### 比赛流程

比赛通过事件驱动模型进行管理，包括房间创建、玩家加入、比赛开始、提交记录同步和比赛结束等阶段。
