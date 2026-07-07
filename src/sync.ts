import { joinRoom, selfId, type JsonValue, type Room } from "@trystero-p2p/nostr";
import type { SignedEnvelope } from "./types";

type Snapshot = { envelopes: SignedEnvelope[] };
type WireValue = JsonValue;

export type RoomSync = {
  selfPeerId: string;
  broadcast: (envelope: SignedEnvelope) => Promise<void>;
  leave: () => Promise<void>;
};

const appId = "dev.luogu-duel.static.v1";

export const createRoomSync = (
  roomId: string,
  secret: string,
  getLog: () => SignedEnvelope[],
  onEnvelope: (envelope: SignedEnvelope) => void,
  onPeerChange: (peers: string[]) => void
): RoomSync => {
  const room: Room = joinRoom(
    {
      appId,
      password: secret,
      rtcConfig: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun.cloudflare.com:3478" }
        ]
      }
    },
    roomId
  );

  const eventAction = room.makeAction<WireValue>("duel-event");
  const snapshotAction = room.makeAction<WireValue>("duel-snapshot");

  eventAction.onMessage = (envelope) => onEnvelope(envelope as unknown as SignedEnvelope);
  snapshotAction.onMessage = (snapshot) => (snapshot as unknown as Snapshot).envelopes.forEach(onEnvelope);

  const publishPeers = () => onPeerChange(Object.keys(room.getPeers()));
  room.onPeerJoin = async (peerId) => {
    publishPeers();
    await snapshotAction.send({ envelopes: getLog() } as unknown as WireValue, { target: peerId });
  };
  room.onPeerLeave = publishPeers;

  return {
    selfPeerId: selfId,
    broadcast: (envelope) => eventAction.send(envelope as unknown as WireValue),
    leave: () => room.leave()
  };
};
