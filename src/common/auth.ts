import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ApiError, forbidden, rosterLocked } from './errors';
import type { Row } from './db.service';

export interface StudentUser {
  role: 'student';
  sub: string;
  name: string;
}

export interface SupUser {
  role: 'sup';
  sub: string;
  supName: string;
  orgCode: string;
  orgName: string;
  admin: boolean;
}

export type User = StudentUser | SupUser;
/** Who made a request that does not require signing in. */
export type Viewer = User | null;

/** The token is optional here; a valid one still identifies the caller. Endpoints without this require a token. */
export const Public = () => SetMetadata('public', true);
/** Who may call. 'admin' means a supervisor from an organisation with orgs.admin = true. */
export const Roles = (...roles: ('student' | 'sup' | 'admin')[]) => SetMetadata('roles', roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user ?? null);

/** Reads identity from the token only. Every route is closed unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>('public', targets);
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    let user: User | undefined;
    if (token) {
      try {
        user = this.jwt.verify<User>(token);
      } catch {
        // A stale token must not lock anyone out of the public pages.
        if (!isPublic) throw new ApiError(401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบใหม่');
      }
    }
    if (user) req.user = user;
    if (isPublic) return true;
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ');
    const roles = this.reflector.getAllAndOverride<string[] | undefined>('roles', targets);
    if (!roles) return true;
    if (user.role === 'student' && roles.includes('student')) return true;
    if (user.role === 'sup' && (roles.includes('sup') || (roles.includes('admin') && user.admin))) return true;
    throw forbidden();
  }
}

export const isSup = (u: Viewer): u is SupUser => u?.role === 'sup';
export const isStudent = (u: Viewer): u is StudentUser => u?.role === 'student';

/** The organisation that made the activity, or the centre admin. */
export const isOwner = (u: Viewer, activity: Row) => isSup(u) && (u.admin || u.orgCode === activity.org_code);

export function assertOwner(u: Viewer, activity: Row) {
  if (!isOwner(u, activity)) throw forbidden('กิจกรรมนี้ไม่ใช่ของหน่วยงานคุณ');
}

/** Owners can change an activity and its roster until it is sent, the centre admin until it is recorded. */
export function assertCanEdit(u: Viewer, activity: Row) {
  assertOwner(u, activity);
  if (activity.recorded_at || (!(u as SupUser).admin && activity.submitted_at)) throw rosterLocked();
}
