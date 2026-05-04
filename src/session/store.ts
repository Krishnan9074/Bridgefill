import { randomUUID } from "node:crypto";

import { config } from "../../config/index.js";
import { auditSession } from "../auth/audit.js";
import { getStores } from "../persistence/index.js";
import type { OrgClaims, Participant, Role, SessionRecord } from "../types.js";

const expiryTimers = new Map<string, NodeJS.Timeout>();

export class SessionError extends Error {
  code: number;
  machineCode: string;
  statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = "SessionError";
    this.code = -32002;
    this.machineCode = "SESSION_ERROR";
    this.statusCode = 404;
  }
}

function buildParticipant(joinerClaims: Pick<OrgClaims, "orgId" | "orgName">): Participant {
  return {
    orgId: joinerClaims.orgId,
    orgName: joinerClaims.orgName ?? joinerClaims.orgId,
    joinedAt: new Date().toISOString(),
  };
}

function expirePendingSession(serviceId: string, sessionId: string): void {
  const session = getStores().sessions.get(sessionId);
  if (!session || session.status !== "pending") {
    return;
  }

  session.status = "expired";
  session._expiryTimer = null;
  expiryTimers.delete(sessionId);
  void getStores().sessions.set(sessionId, session);
  void getStores().sessions.indexByServiceId(serviceId, null);
  auditSession.expired(sessionId, "handshake_timeout");
}

function createExpiryTimer(serviceId: string, sessionId: string): NodeJS.Timeout {
  const timer = setTimeout(() => expirePendingSession(serviceId, sessionId), config.session.handshakeTimeoutMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

export async function joinSession(serviceId: string, joinerClaims: OrgClaims): Promise<SessionRecord> {
  const role: Role = joinerClaims.role;
  if (!role || !["provider", "consumer"].includes(role)) {
    throw new SessionError("joinerClaims.role must be provider or consumer");
  }

  const existingSession = getStores().sessions.getByServiceId(serviceId);

  if (!existingSession || existingSession.status === "expired" || existingSession.status === "complete") {
    const sessionId = randomUUID();
    const session: SessionRecord = {
      id: sessionId,
      serviceId,
      status: "pending",
      createdAt: new Date().toISOString(),
      activatedAt: null,
      participants: {
        [role]: buildParticipant(joinerClaims),
      },
      schema: null,
      schemaHistory: [],
      generatedCode: null,
      messages: [],
      _expiryTimer: createExpiryTimer(serviceId, sessionId),
    };

    expiryTimers.set(sessionId, session._expiryTimer!);
    await getStores().sessions.set(sessionId, session);
    await getStores().sessions.indexByServiceId(serviceId, sessionId);
    return session;
  }

  const currentParticipant = existingSession.participants[role];
  if (currentParticipant && currentParticipant.orgId !== joinerClaims.orgId) {
    throw new SessionError(`Session already has a ${role} participant`);
  }

  existingSession.participants[role] = buildParticipant(joinerClaims);

  if (existingSession.participants.provider && existingSession.participants.consumer) {
    existingSession.status = "active";
    existingSession.activatedAt = new Date().toISOString();
    const expiryTimer = expiryTimers.get(existingSession.id) ?? existingSession._expiryTimer;
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimers.delete(existingSession.id);
      existingSession._expiryTimer = null;
    }
  }
  await getStores().sessions.set(existingSession.id, existingSession);

  return existingSession;
}

export function getSession(sessionId: string, callerOrgId?: string): SessionRecord {
  const session = getStores().sessions.get(sessionId);
  if (!session) {
    throw new SessionError("Session not found");
  }

  const participants = Object.values(session.participants).filter((participant): participant is Participant => !!participant);
  if (callerOrgId && !participants.some((participant) => participant.orgId === callerOrgId)) {
    throw new SessionError("Session access denied");
  }

  return session;
}

export function getSessionInternal(sessionId: string): SessionRecord | null {
  return getStores().sessions.get(sessionId);
}

export function getSessionByServiceId(serviceId: string): SessionRecord | null {
  return getStores().sessions.getByServiceId(serviceId);
}

export async function attachSchema(sessionId: string, schemaId: string, schema: Omit<NonNullable<SessionRecord["schema"]>, "id">): Promise<NonNullable<SessionRecord["schema"]>> {
  const session = getSessionInternal(sessionId);
  if (!session) {
    throw new SessionError("Session not found");
  }

  session.schema = {
    id: schemaId,
    ...schema,
  };
  await getStores().sessions.set(session.id, session);
  return session.schema;
}

export async function attachGeneratedCode(sessionId: string, code: NonNullable<SessionRecord["generatedCode"]>): Promise<NonNullable<SessionRecord["generatedCode"]>> {
  const session = getSessionInternal(sessionId);
  if (!session) {
    throw new SessionError("Session not found");
  }

  session.generatedCode = code;
  session.status = "complete";
  await getStores().sessions.set(session.id, session);
  await getStores().sessions.indexByServiceId(session.serviceId, null);
  return session.generatedCode;
}

export async function appendMessage(sessionId: string, message: SessionRecord["messages"][number]): Promise<SessionRecord["messages"][number]> {
  const session = getSessionInternal(sessionId);
  if (!session) {
    throw new SessionError("Session not found");
  }

  session.messages.push(message);
  await getStores().sessions.set(session.id, session);
  return message;
}

export async function closeSession(sessionId: string): Promise<SessionRecord> {
  const session = getSessionInternal(sessionId);
  if (!session) {
    throw new SessionError("Session not found");
  }

  const expiryTimer = expiryTimers.get(session.id) ?? session._expiryTimer;
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimers.delete(session.id);
    session._expiryTimer = null;
  }
  session.status = "complete";
  await getStores().sessions.set(session.id, session);
  await getStores().sessions.indexByServiceId(session.serviceId, null);
  return session;
}
