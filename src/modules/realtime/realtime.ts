import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { isOwner, isStudent, isSup, User, Viewer } from '../../common/auth';
import { DbService } from '../../common/db.service';

/** Bursts on one room within this window become one `changed` (a hall scanning at once should not reload a screen 300 times). */
const COALESCE_MS = 200;

export const rooms = {
  activities: 'activities',
  activity: (id: string) => `activity:${id}`,
  registrations: (id: string) => `registrations:${id}`,
  credits: (id: string) => `credits:${id}`,
  messages: (id: string) => `messages:${id}`,
  dmThreads: (id: string) => `dms:${id}`,
  dmThread: (id: string, studentId: string) => `dms:${id}:${studentId}`,
  /** Anything that changes the activity row: its page and the lists. */
  afterActivity: (id: string) => [rooms.activity(id), rooms.activities],
  /** Writing a credit can touch all of these. */
  afterCredit: (id: string) => [rooms.credits(id), rooms.registrations(id), rooms.activity(id), rooms.activities],
  afterRegistration: (id: string) => [rooms.registrations(id), rooms.activity(id), rooms.activities],
};

/** Sends only the signal; screens reload through REST. Call after the transaction committed, never inside it. */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private server: Server | null = null;
  private readonly pending = new Map<string, NodeJS.Timeout>();

  attach(server: Server) {
    this.server = server;
  }

  notify(names: string[]) {
    for (const room of names) {
      if (this.pending.has(room)) continue;
      const timer = setTimeout(() => {
        this.pending.delete(room);
        this.server?.to(room).emit('changed', { room });
      }, COALESCE_MS);
      this.pending.set(room, timer);
    }
  }

  onModuleDestroy() {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}

type Decision = 'ok' | 'FORBIDDEN' | 'UNAUTHENTICATED' | 'INVALID_ROOM';

@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly db: DbService,
    private readonly jwt: JwtService,
  ) {}

  afterInit(server: Server) {
    this.realtime.attach(server);
  }

  /** Connecting never fails: the public rooms need no token, and a bad one just means anonymous. */
  handleConnection(client: Socket) {
    client.data.token = client.handshake.auth?.token;
  }

  /** The token is read again on each join, so one that expired mid-connection opens nothing new. */
  private viewer(client: Socket): Viewer {
    const token = client.data.token;
    if (typeof token !== 'string') return null;
    try {
      return this.jwt.verify<User>(token);
    } catch {
      return null;
    }
  }

  private async decide(room: unknown, user: Viewer): Promise<Decision> {
    if (typeof room !== 'string') return 'INVALID_ROOM';
    if (room === rooms.activities) return 'ok';
    const [kind, id, studentId, extra] = room.split(':');
    if (!id || extra !== undefined) return 'INVALID_ROOM';
    if (kind === 'activity' && studentId === undefined) return 'ok';
    if (!['registrations', 'credits', 'messages', 'dms'].includes(kind)) return 'INVALID_ROOM';
    if (kind !== 'dms' && studentId !== undefined) return 'INVALID_ROOM';
    if (!user) return 'UNAUTHENTICATED';

    if (kind === 'messages') return 'ok';
    if (kind === 'credits' && isStudent(user)) return 'ok';
    if (kind === 'dms' && studentId !== undefined && isStudent(user) && user.sub === studentId) return 'ok';
    if (!isSup(user)) return 'FORBIDDEN';
    const activity = await this.db.one('SELECT org_code FROM activities WHERE id = $1', [id]);
    return activity && isOwner(user, activity) ? 'ok' : 'FORBIDDEN';
  }

  @SubscribeMessage('join')
  async join(@ConnectedSocket() client: Socket, @MessageBody() body: { room?: unknown }) {
    const room = body?.room;
    const decision = await this.decide(room, this.viewer(client));
    if (decision !== 'ok') {
      client.emit('error', { room, code: decision });
      return { ok: false, code: decision };
    }
    await client.join(room as string);
    return { ok: true };
  }

  @SubscribeMessage('leave')
  async leave(@ConnectedSocket() client: Socket, @MessageBody() body: { room?: unknown }) {
    if (typeof body?.room === 'string') await client.leave(body.room);
    return { ok: true };
  }
}

@Global()
@Module({ providers: [RealtimeService, RealtimeGateway], exports: [RealtimeService] })
export class RealtimeModule {}
