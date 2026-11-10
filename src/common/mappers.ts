import type { Row } from './db.service';
import type { Viewer } from './auth';

/** Database rows (snake_case, Date) to JSON (camelCase, ms). Follows the old site's src/data/rows.ts field by field. */

const ms = (v: Date | string | null | undefined) => (v ? new Date(v).getTime() : undefined);
const opt = <T>(v: T | null | undefined) => v ?? undefined;
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const toStudent = (r: Row) => ({
  id: r.id,
  name: r.name,
  createdAt: ms(r.created_at) ?? 0,
  reminders: r.reminders ?? [],
  notify: r.notify ?? {},
});

/** A supervisor looks a student up to fill in the name, and has no business with their settings. */
export const toStudentBrief = (r: Row) => ({ id: r.id, name: r.name, createdAt: ms(r.created_at) ?? 0 });

/**
 * The organisation code is the only credential a supervisor has, so it goes only to the centre admin and the
 * organisation's own supervisors. Everyone else gets the activity without the key.
 */
const mayViewOrgCode = (viewer: Viewer, orgCode: string) => viewer?.role === 'sup' && (viewer.admin || viewer.orgCode === orgCode);

export const toActivity = (r: Row, viewer: Viewer) =>
  defined({
    id: r.id,
    title: r.title,
    categoryKey: r.category_key,
    templateId: opt(r.template_id),
    org: r.org,
    orgCode: mayViewOrgCode(viewer, r.org_code) ? (r.org_code as string) : undefined,
    poster: r.poster,
    description: r.description,
    place: r.place,
    lat: opt(r.lat),
    lng: opt(r.lng),
    start: ms(r.start_at) ?? 0,
    end: ms(r.end_at) ?? 0,
    hours: Number(r.hours),
    itemsPerHour: opt(r.items_per_hour),
    capLimit: r.cap_limit,
    capacity: r.capacity,
    walkIn: r.walk_in,
    qrMode: r.qr_mode,
    locMode: r.loc_mode,
    radius: r.radius,
    qrInterval: r.qr_interval,
    supervisor: { name: r.supervisor_name, phone: r.supervisor_phone },
    chatEnabled: r.chat_enabled,
    openChatUrl: opt(r.open_chat_url),
    opensAt: ms(r.opens_at),
    cancelDays: opt(r.cancel_days),
    closedAt: ms(r.closed_at),
    submittedAt: ms(r.submitted_at),
    recordedAt: ms(r.recorded_at),
    hidden: opt(r.hidden),
    hideUntilOpen: opt(r.hide_until_open),
    createdAt: ms(r.created_at) ?? 0,
    regCount: r.reg_count,
    creditCount: r.credit_count,
  });

export const toRegistration = (r: Row) =>
  defined({
    studentId: r.student_id,
    name: r.name,
    at: ms(r.at) ?? 0,
    walkIn: r.walk_in || undefined,
    cancelledAt: ms(r.cancelled_at),
    late: r.late || undefined,
    waived: r.waived || undefined,
  });

export const toMyRegistration = (r: Row) => ({ ...toRegistration(r), activityId: r.activity_id });

export const toCredit = (r: Row) =>
  defined({
    studentId: r.student_id,
    name: r.name,
    hours: Number(r.hours),
    fullHours: Number(r.full_hours),
    items: opt(r.items),
    at: ms(r.at) ?? 0,
    method: r.method,
    distance: opt(r.distance),
    accuracy: opt(r.accuracy),
    flags: r.flags ?? [],
    deviceId: opt(r.device_id),
    ref: opt(r.ref),
    editedBy: opt(r.edited_by),
    editedAt: ms(r.edited_at),
    reason: opt(r.reason),
  });

export const toMyCredit = (r: Row) => ({ ...toCredit(r), activityId: r.activity_id });

/** Another student's row, as a student sees it on the sign-in sheet: who and when only, no flags, reasons or device. */
export const toCreditForPeer = (r: Row) => ({
  studentId: r.student_id,
  name: r.name,
  hours: Number(r.hours),
  fullHours: Number(r.full_hours),
  at: ms(r.at) ?? 0,
  method: r.method,
});

export const toNotice = (r: Row) =>
  defined({
    id: r.id,
    studentId: r.student_id,
    kind: r.kind,
    title: r.title,
    body: r.body ?? '',
    activityId: opt(r.activity_id),
    to: opt(r.to),
    at: ms(r.at) ?? 0,
    read: !!r.read,
  });

export const toAnnouncement = (r: Row) => ({
  id: r.id,
  activityId: r.activity_id,
  text: r.text,
  images: r.images ?? [],
  at: ms(r.at) ?? 0,
});

export const toChatMsg = (r: Row) => ({
  id: r.id,
  activityId: r.activity_id,
  authorId: r.author_id,
  authorName: r.author_name,
  text: r.text,
  at: ms(r.at) ?? 0,
  sup: !!r.sup,
});

export const toDirectMsg = (r: Row) => ({
  id: r.id,
  activityId: r.activity_id,
  studentId: r.student_id,
  fromSup: !!r.from_sup,
  authorName: r.author_name,
  text: r.text,
  at: ms(r.at) ?? 0,
  read: !!r.read,
});

/** Settings are jsonb and may lack keys, so every key has a fallback. */
export const toTemplateSettings = (s: Row | null | undefined) => ({
  capLimit: !!s?.capLimit,
  capacity: Number(s?.capacity) > 0 ? Number(s?.capacity) : 30,
  walkIn: !!s?.walkIn,
  qrMode: s?.qrMode === 'static' ? 'static' : 'dynamic',
  qrInterval: Number(s?.qrInterval) > 0 ? Number(s?.qrInterval) : 10,
  locMode: s?.locMode === 'off' ? 'off' : 'on',
  radius: Number(s?.radius) > 0 ? Number(s?.radius) : 150,
});

export const toTemplate = (r: Row) => ({
  id: r.id,
  orgCode: r.org_code,
  title: r.title,
  poster: r.poster ?? '',
  description: r.description ?? '',
  hours: Number(r.hours),
  settings: toTemplateSettings(r.settings),
  createdBy: r.created_by ?? '',
  createdAt: ms(r.created_at) ?? 0,
});
