import type {
  ChatMessage,
  DuelEvent,
  DuelState,
  FeedRecord,
  JudgeStatus,
  ModerationRecord,
  Player,
  Problem,
  Seat,
  Team,
  Vote,
  VoteKind
} from "./types";

const statusRank: Record<JudgeStatus, number> = {
  OK: 0,
  WA: 1,
  TL: 2,
  RE: 3,
  CE: 4,
  MLE: 5,
  OLE: 6,
  UKE: 7,
  PD: 8
};
const adminNames = new Set(["General826", "Gcend", "GCSG01"]);

export const SYSTEM_CHAT_PREFIX = "@@luogu-duel-system:";

export type SystemChatCommand =
  | { kind: "room.configured"; problems: Problem[] }
  | { kind: "player.joined"; luoguName: string; team: Seat }
  | { kind: "player.teamChanged"; team: Seat }
  | { kind: "player.readyChanged"; ready: boolean }
  | { kind: "game.started" }
  | { kind: "vote.opened"; vote: Omit<Vote, "approvals" | "rejections" | "status" | "createdAt"> }
  | { kind: "vote.cast"; voteId: string; approve: boolean }
  | { kind: "vote.cancelled"; voteId: string }
  | { kind: "judge.recordSeen"; record: FeedRecord }
  | { kind: "player.muted"; targetId: string }
  | { kind: "player.unmuted"; targetId: string }
  | { kind: "player.kicked"; targetId: string; reason: string }
  | { kind: "player.unkicked"; targetName: string }
  | { kind: "room.closed"; reason: string; actorName?: string };

export const encodeSystemChatCommand = (command: SystemChatCommand): string =>
  `${SYSTEM_CHAT_PREFIX}${encodeURIComponent(JSON.stringify(command))}`;

export const createInitialState = (roomId: string): DuelState => ({
  roomId,
  phase: roomId === "global" ? "home" : "lobby",
  players: {},
  problems: [],
  chats: [],
  feed: [],
  votes: {},
  system: [],
  muted: {},
  kicked: {},
  banned: {},
  lamport: 0
});

export const normalizePid = (pid: string): string => {
  const trimmed = pid.trim().toUpperCase();
  return /^P\d{1,5}$/.test(trimmed) ? trimmed : "";
};

export const makeProblemSet = (count: number, seed: string, manualInput: string): Problem[] => {
  const manual = manualInput
    .split(/[\s,，]+/)
    .map(normalizePid)
    .filter(Boolean);

  if (manual.length > 0) {
    return manual.slice(0, count).map((pid, index) => ({ pid, score: scoreForIndex(index) }));
  }

  const used = new Set<string>();
  const problems: Problem[] = [];
  let rng = seeded(seed);
  while (problems.length < count) {
    const n = 1000 + Math.floor(rng() * 16001);
    const pid = `P${n}`;
    if (!used.has(pid)) {
      used.add(pid);
      problems.push({ pid, score: scoreForIndex(problems.length) });
    }
  }
  return problems;
};

export const applyEvents = (roomId: string, events: DuelEvent[]): DuelState =>
  events
    .filter((event) => event.roomId === roomId)
    .sort(compareEvents)
    .reduce(applyEvent, createInitialState(roomId));

export const applyEvent = (state: DuelState, event: DuelEvent): DuelState => {
  const next = cloneState(state);
  next.lamport = Math.max(next.lamport, event.lamport);

  switch (event.type) {
    case "room.configured":
      if (next.problems.length === 0 && event.problems.length > 0) {
        next.problems = event.problems.map((p) => ({ ...p }));
        next.system.push(`[系统] 房间题目已生成，共 ${event.problems.length} 题。`);
      }
      break;

    case "player.joined":
      {
        const banned = next.banned[normalizeName(event.luoguName)];
        const team = banned || next.phase !== "lobby" ? "spectator" : event.team;
        next.players[event.actorId] = {
          id: event.actorId,
          luoguName: event.luoguName.trim() || shortId(event.actorId),
          team,
          ready: team === "spectator" ? false : (next.players[event.actorId]?.ready ?? false),
          online: !banned
        };
        if (banned) {
          next.kicked[event.actorId] = banned;
          next.system.push(`[系统] 已阻止被封禁用户 ${event.luoguName} 加入：${banned.reason}`);
        } else {
          next.system.push(`[系统] ${event.luoguName} 加入 ${teamName(team)}。`);
        }
      }
      break;

    case "player.teamChanged":
      if (next.players[event.actorId] && next.phase === "lobby" && !isRestricted(next, event.actorId)) {
        next.players[event.actorId].team = event.team;
        next.players[event.actorId].ready = false;
        next.system.push(`[系统] ${nameOf(next, event.actorId)} 切换到 ${teamName(event.team)}。`);
      }
      break;

    case "player.readyChanged":
      if (next.players[event.actorId] && next.phase === "lobby" && isTeam(next.players[event.actorId].team) && !isRestricted(next, event.actorId)) {
        next.players[event.actorId].ready = event.ready;
      }
      break;

    case "game.started":
      if (canStart(next)) {
        next.phase = "arena";
        next.startedAt = event.issuedAt;
        next.system.push(`[系统] ${matchTitle(next)} 对决开始。`);
      }
      break;

    case "chat.sent":
      if (applySystemChatCommand(next, event)) break;
      pushChat(next, event);
      break;

    case "vote.opened":
      openVote(next, event.vote, event.issuedAt, event.actorId);
      break;

    case "vote.cast":
      castVote(next, event.voteId, event.actorId, event.approve);
      break;

    case "vote.cancelled":
      cancelVote(next, event.voteId, event.actorId);
      break;

    case "judge.recordSeen":
      pushFeed(next, event.record);
      claimIfAccepted(next, event.record, event.id);
      break;
  }

  updateWinner(next);
  return next;
};

export const scoreOf = (state: DuelState, team: Team): number =>
  state.problems.reduce((sum, problem) => sum + (problem.solvedBy?.team === team ? problem.score : 0), 0);

export const winThreshold = (state: DuelState): number =>
  Math.ceil(state.problems.reduce((sum, problem) => sum + problem.score, 0) / 2);

export const canStart = (state: DuelState): boolean => {
  const players = participants(state);
  return (
    state.phase === "lobby" &&
    state.problems.length > 0 &&
    players.length >= 2 &&
    players.every((p) => p.ready) &&
    players.some((p) => p.team === "red") &&
    players.some((p) => p.team === "blue")
  );
};

export const visibleChats = (state: DuelState, viewerId: string): ChatMessage[] => {
  const viewer = state.players[viewerId];
  return state.chats.filter((chat) => chat.visibility === "all" || (isTeam(viewer?.team) && chat.team === viewer.team));
};

export const participants = (state: DuelState): Player[] =>
  Object.values(state.players).filter((player) => isTeam(player.team) && !isRestricted(state, player.id));

export const participantIds = (state: DuelState): string[] =>
  participants(state)
    .map((player) => player.id)
    .sort();

export const requiredVoters = (state: DuelState, vote: Vote): string[] => {
  if (vote.kind === "surrender" && vote.team) {
    return participantIds(state).filter((id) => state.players[id]?.team === vote.team);
  }
  return participantIds(state);
};

export const createReplacementProblem = (state: DuelState, seed: string, targetPid: string): Problem => {
  const used = new Set(state.problems.map((p) => p.pid));
  let rng = seeded(`${seed}:${targetPid}:${state.problems.length}`);
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const pid = `P${1000 + Math.floor(rng() * 16001)}`;
    if (!used.has(pid)) {
      const old = state.problems.find((p) => p.pid === targetPid);
      return { pid, score: old?.score ?? scoreForIndex(state.problems.length) };
    }
  }
  return { pid: `P${17000 + state.problems.length + 1}`, score: scoreForIndex(state.problems.length) };
};

export const buildVote = (
  kind: VoteKind,
  proposer: Player,
  targetPid?: string,
  replacement?: Problem
): Omit<Vote, "approvals" | "rejections" | "status" | "createdAt"> => ({
  id: crypto.randomUUID(),
  kind,
  proposerId: proposer.id,
  team: kind === "surrender" && isTeam(proposer.team) ? proposer.team : undefined,
  targetPid,
  replacement
});

const compareEvents = (a: DuelEvent, b: DuelEvent): number =>
  a.lamport - b.lamport || a.issuedAt - b.issuedAt || a.id.localeCompare(b.id);

const cloneState = (state: DuelState): DuelState => ({
  ...state,
  players: Object.fromEntries(Object.entries(state.players).map(([id, p]) => [id, { ...p }])),
  problems: state.problems.map((problem) => ({
    ...problem,
    solvedBy: problem.solvedBy ? { ...problem.solvedBy } : undefined
  })),
  chats: [...state.chats],
  feed: [...state.feed],
  votes: Object.fromEntries(
    Object.entries(state.votes).map(([id, vote]) => [
      id,
      {
        ...vote,
        replacement: vote.replacement ? { ...vote.replacement } : undefined,
        approvals: { ...vote.approvals },
        rejections: { ...vote.rejections }
      }
    ])
  ),
  system: [...state.system],
  muted: { ...state.muted },
  kicked: cloneModerationMap(state.kicked),
  banned: cloneModerationMap(state.banned),
  closed: state.closed ? { ...state.closed } : undefined
});

const pushChat = (state: DuelState, event: Extract<DuelEvent, { type: "chat.sent" }>) => {
  const player = state.players[event.actorId];
  if (state.muted[event.actorId] || isRestricted(state, event.actorId)) return;
  if (!player || event.text.trim().length === 0) return;
  state.chats.push({
    id: event.id,
    actorId: event.actorId,
    luoguName: player.luoguName,
    team: player.team,
    visibility: event.visibility,
    text: event.text.trim().slice(0, 500),
    at: event.issuedAt
  });
};

const applySystemChatCommand = (state: DuelState, event: Extract<DuelEvent, { type: "chat.sent" }>): boolean => {
  const command = decodeSystemChatCommand(event.text);
  if (!command) return false;

  switch (command.kind) {
    case "room.configured":
      if (state.problems.length === 0 && command.problems.length > 0) {
        state.problems = command.problems.map((p) => ({ ...p }));
        state.system.push(`[系统] 房间题目已生成，共 ${command.problems.length} 题。`);
      }
      return true;
    case "player.joined":
      {
        const banned = state.banned[normalizeName(command.luoguName)];
        const team = banned || state.phase !== "lobby" ? "spectator" : command.team;
        state.players[event.actorId] = {
          id: event.actorId,
          luoguName: command.luoguName.trim() || shortId(event.actorId),
          team,
          ready: team === "spectator" ? false : (state.players[event.actorId]?.ready ?? false),
          online: !banned
        };
        if (banned) {
          state.kicked[event.actorId] = banned;
          state.system.push(`[系统] 已阻止被封禁用户 ${command.luoguName} 加入：${banned.reason}`);
        } else {
          state.system.push(`[系统] ${command.luoguName} 加入 ${teamName(team)}。`);
        }
      }
      return true;
    case "player.teamChanged":
      if (state.players[event.actorId] && state.phase === "lobby" && !isRestricted(state, event.actorId)) {
        state.players[event.actorId].team = command.team;
        state.players[event.actorId].ready = false;
        state.system.push(`[系统] ${nameOf(state, event.actorId)} 切换到 ${teamName(command.team)}。`);
      }
      return true;
    case "player.readyChanged":
      if (state.players[event.actorId] && state.phase === "lobby" && isTeam(state.players[event.actorId].team) && !isRestricted(state, event.actorId)) {
        state.players[event.actorId].ready = command.ready;
      }
      return true;
    case "game.started":
      if (canStart(state)) {
        state.phase = "arena";
        state.startedAt = event.issuedAt;
        state.system.push(`[系统] ${matchTitle(state)} 对决开始。`);
      }
      return true;
    case "vote.opened":
      openVote(state, command.vote, event.issuedAt, event.actorId);
      return true;
    case "vote.cast":
      castVote(state, command.voteId, event.actorId, command.approve);
      return true;
    case "vote.cancelled":
      cancelVote(state, command.voteId, event.actorId);
      return true;
    case "judge.recordSeen":
      pushFeed(state, command.record);
      claimIfAccepted(state, command.record, event.id);
      return true;
    case "player.muted":
      if (isAdminName(nameOf(state, event.actorId)) && state.players[command.targetId] && !isAdminName(nameOf(state, command.targetId))) {
        state.muted[command.targetId] = true;
        state.system.push(`[系统] 管理员已禁言 ${nameOf(state, command.targetId)}。`);
      }
      return true;
    case "player.unmuted":
      if (isAdminName(nameOf(state, event.actorId)) && state.players[command.targetId]) {
        delete state.muted[command.targetId];
        state.system.push(`[系统] 管理员已解除 ${nameOf(state, command.targetId)} 的禁言。`);
      }
      return true;
    case "player.kicked":
      if (isAdminName(nameOf(state, event.actorId))) {
        const target = state.players[command.targetId];
        if (target && !isAdminName(target.luoguName)) {
          const record: ModerationRecord = {
            reason: command.reason.trim() || "管理员移出房间",
            by: nameOf(state, event.actorId),
            at: event.issuedAt
          };
          state.kicked[target.id] = record;
          state.banned[normalizeName(target.luoguName)] = record;
          target.team = "spectator";
          target.ready = false;
          target.online = false;
          delete state.muted[target.id];
          state.system.push(`[系统] 管理员已踢出并封禁 ${target.luoguName}：${record.reason}`);
        }
      }
      return true;
    case "player.unkicked":
      if (isAdminName(nameOf(state, event.actorId))) {
        const normalizedTarget = normalizeName(command.targetName);
        delete state.banned[normalizedTarget];
        for (const player of Object.values(state.players)) {
          if (normalizeName(player.luoguName) === normalizedTarget) {
            delete state.kicked[player.id];
            player.online = true;
          }
        }
        state.system.push(`[系统] 管理员已取消封禁 ${command.targetName}。`);
      }
      return true;
    case "room.closed":
      if (isAdminName(command.actorName ?? nameOf(state, event.actorId)) || state.phase === "lobby") {
        state.phase = "finished";
        state.closed = { reason: command.reason || "管理员关闭房间", at: event.issuedAt };
        state.system.push(`[系统] 房间已关闭：${state.closed.reason}`);
      }
      return true;
  }
};

const decodeSystemChatCommand = (text: string): SystemChatCommand | null => {
  if (!text.startsWith(SYSTEM_CHAT_PREFIX)) return null;
  try {
    return JSON.parse(decodeURIComponent(text.slice(SYSTEM_CHAT_PREFIX.length))) as SystemChatCommand;
  } catch {
    return null;
  }
};

const openVote = (
  state: DuelState,
  voteInput: Omit<Vote, "approvals" | "rejections" | "status" | "createdAt">,
  createdAt: number,
  actorId: string
) => {
  if (!isTeam(state.players[actorId]?.team) || isRestricted(state, actorId) || state.votes[voteInput.id]) return;
  const vote: Vote = {
    ...voteInput,
    approvals: { [actorId]: true },
    rejections: {},
    status: "open",
    createdAt
  };
  state.votes[vote.id] = vote;
  state.system.push(`[系统] ${nameOf(state, actorId)} 发起${voteLabel(vote)}。`);
  settleVote(state, vote);
};

const castVote = (state: DuelState, voteId: string, actorId: string, approve: boolean) => {
  const vote = state.votes[voteId];
  if (!vote || vote.status !== "open" || !requiredVoters(state, vote).includes(actorId)) return;
  if (approve) {
    vote.approvals[actorId] = true;
    delete vote.rejections[actorId];
  } else {
    vote.rejections[actorId] = true;
    vote.status = "rejected";
    state.system.push(`[系统] ${nameOf(state, actorId)} 拒绝${voteLabel(vote)}。`);
  }
  settleVote(state, vote);
};

const cancelVote = (state: DuelState, voteId: string, actorId: string) => {
  const vote = state.votes[voteId];
  if (!vote || vote.status !== "open" || vote.proposerId !== actorId) return;
  vote.status = "cancelled";
  state.system.push(`[系统] ${nameOf(state, actorId)} 取消${voteLabel(vote)}。`);
};

const settleVote = (state: DuelState, vote: Vote) => {
  if (vote.status !== "open") return;
  const voters = requiredVoters(state, vote);
  if (voters.length === 0 || !voters.every((id) => vote.approvals[id])) return;

  vote.status = "passed";
  if (vote.kind === "replace-problem" && vote.targetPid && vote.replacement) {
    const replacement: Problem = { ...vote.replacement };
    state.problems = state.problems.map((p) => (p.pid === vote.targetPid ? replacement : p));
    state.system.push(`[系统] ${vote.targetPid} 已更换为 ${replacement.pid}。`);
  }
  if (vote.kind === "delete-problem" && vote.targetPid) {
    state.problems = state.problems.filter((p) => p.pid !== vote.targetPid);
    state.system.push(`[系统] ${vote.targetPid} 已删除。`);
  }
  if (vote.kind === "draw") {
    state.phase = "finished";
    state.winner = "draw";
    state.system.push("[系统] 双方同意平局。");
  }
  if (vote.kind === "surrender" && vote.team) {
    state.phase = "finished";
    state.winner = vote.team === "red" ? "blue" : "red";
    state.system.push(`[系统] ${teamName(vote.team)} 投降。`);
  }
};

const pushFeed = (state: DuelState, record: FeedRecord) => {
  if (state.feed.some((item) => item.recordId === record.recordId && item.pid === record.pid)) return;
  state.feed.push(record);
  state.feed.sort(
    (a, b) =>
      b.at - a.at ||
      statusRank[a.status] - statusRank[b.status] ||
      a.luoguName.localeCompare(b.luoguName) ||
      a.pid.localeCompare(b.pid)
  );
  state.feed = state.feed.slice(0, 120);
};

const claimIfAccepted = (state: DuelState, record: FeedRecord, eventId: string) => {
  if (record.status !== "OK") return;
  const player = Object.values(state.players).find((p) => p.luoguName === record.luoguName);
  const problem = state.problems.find((p) => p.pid === record.pid);
  if (!player || !problem || !isTeam(player.team)) return;

  const candidate = {
    team: player.team,
    playerId: player.id,
    luoguName: player.luoguName,
    recordId: record.recordId || eventId,
    at: record.at
  };

  const current = problem.solvedBy;
  if (!current || candidate.at < current.at || (candidate.at === current.at && candidate.recordId < current.recordId)) {
    problem.solvedBy = candidate;
    state.system.push(`[系统] ${teamName(player.team)} ${player.luoguName} 抢占 ${record.pid}。`);
  }
};

const updateWinner = (state: DuelState) => {
  if (state.phase === "finished" || state.problems.length === 0) return;
  const threshold = winThreshold(state);
  if (scoreOf(state, "red") >= threshold) {
    state.phase = "finished";
    state.winner = "red";
  }
  if (scoreOf(state, "blue") >= threshold) {
    state.phase = "finished";
    state.winner = "blue";
  }
};

const scoreForIndex = (index: number): number => 100 + Math.floor(index / 3) * 50;

const seeded = (seed: string): (() => number) => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const matchTitle = (state: DuelState): string => {
  const red = participants(state)
    .filter((p) => p.team === "red")
    .map((p) => p.luoguName)
    .join(" / ");
  const blue = participants(state)
    .filter((p) => p.team === "blue")
    .map((p) => p.luoguName)
    .join(" / ");
  return `${red || "红方"} vs ${blue || "蓝方"}`;
};

const voteLabel = (vote: Pick<Vote, "kind" | "targetPid">): string => {
  if (vote.kind === "replace-problem") return `更换 ${vote.targetPid}`;
  if (vote.kind === "delete-problem") return `删除 ${vote.targetPid}`;
  if (vote.kind === "draw") return "平局";
  return "投降";
};

const isTeam = (team: Seat | undefined): team is Team => team === "red" || team === "blue";
const isAdminName = (name: string): boolean => adminNames.has(name);
const teamName = (team: Seat): string => (team === "red" ? "红方" : team === "blue" ? "蓝方" : "观赛席");
const nameOf = (state: DuelState, id: string): string => state.players[id]?.luoguName ?? shortId(id);
const normalizeName = (name: string): string => name.trim().toLowerCase();
const isRestricted = (state: DuelState, id: string): boolean => {
  const player = state.players[id];
  return Boolean(state.kicked[id] || (player && state.banned[normalizeName(player.luoguName)]));
};
const cloneModerationMap = (map: Record<string, ModerationRecord>): Record<string, ModerationRecord> =>
  Object.fromEntries(Object.entries(map).map(([key, value]) => [key, { ...value }]));
const shortId = (id: string): string => id.slice(0, 6);
