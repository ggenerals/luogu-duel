export type Team = "red" | "blue";
export type Seat = Team | "spectator";
export type Phase = "home" | "lobby" | "arena" | "finished";
export type JudgeStatus = "OK" | "WA" | "TL" | "RE" | "CE" | "MLE" | "OLE" | "UKE" | "PD";
export type VoteKind = "replace-problem" | "delete-problem" | "draw" | "surrender";
export type VoteStatus = "open" | "passed" | "rejected" | "cancelled";

export type Player = {
  id: string;
  luoguName: string;
  team: Seat;
  ready: boolean;
  online: boolean;
};

export type Problem = {
  pid: string;
  score: number;
  solvedBy?: {
    team: Team;
    playerId: string;
    luoguName: string;
    recordId: string;
    at: number;
  };
};

export type ChatMessage = {
  id: string;
  actorId: string;
  luoguName: string;
  team: Seat;
  visibility: "all" | "team";
  text: string;
  at: number;
};

export type FeedRecord = {
  id: string;
  luoguName: string;
  pid: string;
  at: number;
  status: JudgeStatus;
  recordId: string;
};

export type Vote = {
  id: string;
  kind: VoteKind;
  proposerId: string;
  team?: Team;
  targetPid?: string;
  replacement?: Problem;
  approvals: Record<string, true>;
  rejections: Record<string, true>;
  status: VoteStatus;
  createdAt: number;
};

export type DuelState = {
  roomId: string;
  phase: Phase;
  startedAt?: number;
  closed?: {
    reason: string;
    at: number;
  };
  muted: Record<string, true>;
  players: Record<string, Player>;
  problems: Problem[];
  chats: ChatMessage[];
  feed: FeedRecord[];
  votes: Record<string, Vote>;
  system: string[];
  winner?: Team | "draw";
  lamport: number;
};

export type DuelEvent =
  | {
      type: "room.configured";
      roomId: string;
      actorId: string;
      id: string;
      lamport: number;
      issuedAt: number;
      problems: Problem[];
    }
  | {
      type: "player.joined";
      roomId: string;
      actorId: string;
      id: string;
      lamport: number;
      issuedAt: number;
      luoguName: string;
      team: Seat;
    }
  | {
      type: "player.teamChanged";
      roomId: string;
      actorId: string;
      id: string;
      lamport: number;
      issuedAt: number;
      team: Seat;
    }
  | {
      type: "player.readyChanged";
      roomId: string;
      actorId: string;
      id: string;
      lamport: number;
      issuedAt: number;
      ready: boolean;
    }
  | {
      type: "game.started";
      roomId: string;
      actorId: string;
      id: string;
      lamport: number;
      issuedAt: number;
    }
  | {
      type: "chat.sent";
      roomId: string;
      actorId: string;
      id: string;
      lamport: number;
      issuedAt: number;
      text: string;
      visibility: "all" | "team";
    }
  | {
      type: "vote.opened";
      roomId: string;
      actorId: string;
      id: string;
      lamport: number;
      issuedAt: number;
      vote: Omit<Vote, "approvals" | "rejections" | "status" | "createdAt">;
    }
  | {
      type: "vote.cast";
      roomId: string;
      actorId: string;
      id: string;
      lamport: number;
      issuedAt: number;
      voteId: string;
      approve: boolean;
    }
  | {
      type: "vote.cancelled";
      roomId: string;
      actorId: string;
      id: string;
      lamport: number;
      issuedAt: number;
      voteId: string;
    }
  | {
      type: "judge.recordSeen";
      roomId: string;
      actorId: string;
      id: string;
      lamport: number;
      issuedAt: number;
      record: FeedRecord;
    };

export type SignedEnvelope = {
  publicKey: JsonWebKey;
  event: DuelEvent;
  signature: string;
};
