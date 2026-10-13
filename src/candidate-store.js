import { isCandidateSnapshotFresh, isTopologyMatch } from './runtime-model.js';

export function createCandidateStore({ clock = Date } = {}) {
  const time = clock && typeof clock.now === 'function' ? clock : Date;
  let topologyFingerprint = null;
  let snapshot = null;

  return {
    setTopology(fingerprint) {
      topologyFingerprint = fingerprint;
    },

    getSnapshot() {
      return snapshot;
    },

    publish(next) {
      if (!next || !isTopologyMatch(next, topologyFingerprint)) return false;
      if (snapshot && next.generation <= snapshot.generation) return false;
      snapshot = next;
      return true;
    },

    getUsableCandidates({ now = time.now(), topologyFingerprint: expected, allowExpired = false } = {}) {
      if (!snapshot || !isTopologyMatch(snapshot, expected) || !isTopologyMatch(snapshot, topologyFingerprint)) {
        return { candidates: [], requiresRecheck: false };
      }
      const fresh = isCandidateSnapshotFresh(snapshot, now);
      if (!fresh && !allowExpired) return { candidates: [], requiresRecheck: false };
      return {
        candidates: snapshot.candidates.map((candidate) => ({ ...candidate })),
        requiresRecheck: !fresh,
        generation: snapshot.generation,
        snapshot,
      };
    },
  };
}
