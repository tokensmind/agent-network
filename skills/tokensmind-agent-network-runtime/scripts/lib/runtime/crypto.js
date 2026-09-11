import { createHash, randomBytes, randomUUID } from 'node:crypto';

function randomCredential(prefix) {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createAuthorizationMaterial({ devicePrefix, tokenPrefix }) {
  const deviceCode = randomCredential(devicePrefix);
  const token = randomCredential(tokenPrefix);

  return {
    authorizationId: randomUUID(),
    createIdempotencyKey: randomUUID(),
    exchangeIdempotencyKey: randomUUID(),
    deviceCode,
    deviceCodeHash: sha256(deviceCode),
    token,
    tokenHash: sha256(token),
    tokenPrefix: token.slice(0, 20),
  };
}
