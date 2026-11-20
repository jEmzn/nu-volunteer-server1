import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Faculties and colleges of Naresuan University, spelled as on the university's site, the same list as the web's
 * src/lib/faculties.ts. The web suggests these while typing but takes any other name too, so the server checks the
 * text's shape (FACULTY_TEXT), not the list. Change both lists together.
 */
export const FACULTIES = [
  'คณะเกษตรศาสตร์ ทรัพยากรธรรมชาติและสิ่งแวดล้อม',
  'คณะทันตแพทยศาสตร์',
  'คณะนิติศาสตร์',
  'คณะบริหารธุรกิจ เศรษฐศาสตร์และการสื่อสาร',
  'คณะพยาบาลศาสตร์',
  'คณะแพทยศาสตร์',
  'คณะมนุษยศาสตร์',
  'คณะเภสัชศาสตร์',
  'คณะวิทยาศาสตร์',
  'คณะวิทยาศาสตร์การแพทย์',
  'คณะวิศวกรรมศาสตร์',
  'คณะศึกษาศาสตร์',
  'คณะสถาปัตยกรรมศาสตร์ ศิลปะและการออกแบบ',
  'คณะสหเวชศาสตร์',
  'คณะสังคมศาสตร์',
  'คณะสาธารณสุขศาสตร์',
  'คณะโลจิสติกส์และดิจิทัลซัพพลายเชน',
  'วิทยาลัยนานาชาติ',
  'วิทยาลัยพลังงานทดแทนและสมาร์ตกริดเทคโนโลยี',
] as const;

/** A Thai phone number once dashes, spaces and brackets are gone: 0 then 8 or 9 digits. Empty means none was given. */
const PHONE = /^(0\d{8,9})?$/;

/** Blank stays blank; anything else loses its separators, and separators alone ("---") are kept so they fail. */
const digitsOf = (s: string) => (s.trim() ? s.replace(/[\s\-()]/g, '') || s : '');

/** The phone on the registration form, stored as digits only. */
export const Phone = () =>
  applyDecorators(
    IsOptional(),
    ApiProperty({ type: String, required: false, nullable: true, pattern: PHONE.source, description: 'ตัดขีด เว้นวรรค วงเล็บออกก่อน แล้วต้องเป็นตัวเลข 9-10 หลักขึ้นต้นด้วย 0 เก็บเป็นตัวเลขล้วน' }),
    Transform(({ value }) => (typeof value === 'string' ? digitsOf(value) : value)),
    IsString(),
    Matches(PHONE),
  );

/**
 * A faculty after trimming: 2 to 80 characters with no angle brackets or control characters, or empty for none. A list
 * name or one typed by hand (บัณฑิตวิทยาลัย, an office). Lengths count UTF-16 units, as the web's maxLength does.
 */
const FACULTY_TEXT = /^(?:[^<>\x00-\x1f\x7f]{2,80})?$/;

/** The faculty on the registration form, trimmed. The Excel files stop a formula in it, as in every cell. */
export const Faculty = () =>
  applyDecorators(
    IsOptional(),
    ApiProperty({ type: String, required: false, nullable: true, pattern: FACULTY_TEXT.source, description: 'ชื่อในรายการคณะหรือพิมพ์เอง ตัดเว้นวรรคหัวท้ายแล้ว 2-80 ตัวอักษร ไม่มี < > และอักขระควบคุม' }),
    Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)),
    IsString(),
    Matches(FACULTY_TEXT),
  );
