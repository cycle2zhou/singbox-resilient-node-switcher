function assertFiniteTimestamp(value, field) {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
}

function stableIdentity(tag) {
  if (typeof tag !== 'string') return tag;
  const match = tag.match(/^(.*?)\s*\|\s*\d+(?:\.\d+)?ms\b/);
  return match ? match[1].trim() : tag;
}

function topologyFingerprint(members, memberTypes) {
  const identities = members
    .map((tag) => [stableIdentity(tag), memberTypes[tag] ?? null])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  return JSON.stringify(identities);
}

export function createTopologySnapshot(members, memberTypes, now, checkedAt) {
  if (!Array.isArray(members)) throw new TypeError('members must be an array');
  if (!memberTypes || typeof memberTypes !== 'object') throw new TypeError('memberTypes must be an object');
  assertFiniteTimestamp(checkedAt, 'checkedAt');
  return {
    members: [...members],
    memberTypes: { ...memberTypes },
    now,
    checkedAt,
    topologyFingerprint: topologyFingerprint(members, memberTypes),
  };
}

function cloneCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new TypeError('candidate must be an object');
  if (typeof candidate.tag !== 'string' || typeof candidate.stableKey !== 'string') {
    throw new TypeError('candidate tag and stableKey are required');
  }
  if (!Number.isFinite(candidate.delay) || candidate.delay < 0) throw new TypeError('candidate delay must be finite and non-negative');
  assertFiniteTimestamp(candidate.checkedAt, 'candidate.checkedAt');
  return {
    tag: candidate.tag,
    stableKey: candidate.stableKey,
    delay: candidate.delay,
    checkedAt: candidate.checkedAt,
  };
}

export function createCandidateSnapshot({ generation, createdAt, expiresAt, topologyFingerprint: fingerprint, candidates }) {
  if (!Number.isInteger(generation) || generation < 0) throw new TypeError('generation must be a non-negative integer');
  assertFiniteTimestamp(createdAt, 'createdAt');
  assertFiniteTimestamp(expiresAt, 'expiresAt');
  if (expiresAt <= createdAt) throw new RangeError('expiresAt must be greater than createdAt');
  if (typeof fingerprint !== 'string' || !fingerprint) throw new TypeError('topologyFingerprint is required');
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  return {
    generation,
    createdAt,
    expiresAt,
    topologyFingerprint: fingerprint,
    candidates: candidates.map(cloneCandidate),
  };
}

export function isCandidateSnapshotFresh(snapshot, now) {
  return Boolean(
    snapshot && Number.isFinite(now) && Number.isFinite(snapshot.createdAt) && Number.isFinite(snapshot.expiresAt)
      && now >= snapshot.createdAt && now < snapshot.expiresAt,
  );
}

export function isTopologyMatch(snapshot, fingerprint) {
  return Boolean(snapshot && typeof fingerprint === 'string' && snapshot.topologyFingerprint === fingerprint);
}

export function createCorrelationId(prefix, counter) {
  if (typeof prefix !== 'string' || !prefix) throw new TypeError('prefix is required');
  if (!Number.isInteger(counter) || counter < 0) throw new TypeError('counter must be a non-negative integer');
  return `${prefix}-${counter}`;
}
