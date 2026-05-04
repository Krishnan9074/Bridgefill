import { randomUUID } from "node:crypto";

import { config } from "../../config/index.js";
import { auditSession } from "../auth/audit.js";
import type { OrgClaims, Participant, Role, SessionRecord } from "../types.js";

const sessions = new Map<string, string>();
const sessionById = new Map<string, SessionRecord>();

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
  const session = sessionById.get(sessionId);
  if (!session || session.status !== "pending") {
    return;
  }

  session.status = "expired";
  session._expiryTimer = null;
  sessions.delete(serviceId);
  auditSession.expired(sessionId, "handshake_timeout");
}

function createExpiryTimer(serviceId: string, sessionId: string): NodeJS.Timeout {
  const timer = setTimeout(() => expirePendingSession(serviceId, sessionId), config.session.handshakeTimeoutMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

export function joinSession(serviceId: string, joinerClaims: OrgClaims): SessionRecord {
  const role: Role = joinerClaims.role;
  if (!role || !["provider", "consumer"].includes(role)) {
    throw new SessionError("joinerClaims.role must be provider or consumer");
  }

  const existingSessionId = sessions.get(serviceId);
  const existingSession = existingSessionId ? sessionById.get(existingSessionId) ?? null : null;

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

    sessions.set(serviceId, sessionId);
    sessionById.set(sessionId, session);
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
    if (existingSession._expiryTimer) {
      clearTimeout(existingSession._expiryTimer);
      existingSession._expiryTimer = null;
    }
  }

  return existingSession;
}

export function getSession(sessionId: string, callerOrgId?: string): SessionRecord {
  const session = sessionById.get(sessionId);
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
  return sessionById.get(sessionId) ?? null;
}

export function getSessionByServiceId(serviceId: string): SessionRecord | null {
  const sessionId = sessions.get(serviceId);
  if (!sessionId) {
    return null;
  }
  return sessionById.get(sessionId) ?? null;
}

export function attachSchema(sessionId: string, schemaId: string, schema: Omit<NonNullable<SessionRecord["schema"]>, "id">): NonNullable<SessionRecord["schema"]> {
  const session = getSessionInternal(sessionId);
  if (!session) {
    throw new SessionError("Session not found");
  }

  session.schema = {
    id: schemaId,
    ...schema,
  };
  return session.schema;
}

export function attachGeneratedCode(sessionId: string, code: NonNullable<SessionRecord["generatedCode"]>): NonNullable<SessionRecord["generatedCode"]> {
  const session = getSessionInternal(sessionId);
  if (!session) {
    throw new SessionError("Session not found");
  }

  session.generatedCode = code;
  session.status = "complete";
  return session.generatedCode;
}

export function appendMessage(sessionId: string, message: SessionRecord["messages"][number]): SessionRecord["messages"][number] {
  const session = getSessionInternal(sessionId);
  if (!session) {
    throw new SessionError("Session not found");
  }

  session.messages.push(message);
  return message;
}

export function closeSession(sessionId: string): SessionRecord {
  const session = getSessionInternal(sessionId);
  if (!session) {
    throw new SessionError("Session not found");
  }

  if (session._expiryTimer) {
    clearTimeout(session._expiryTimer);
    session._expiryTimer = null;
  }
  session.status = "complete";
  sessions.delete(session.serviceId);
  return session;
}
