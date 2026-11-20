import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

/**
 * Faculties and colleges of Naresuan University, the same list and spelling as the web's src/lib/faculties.ts.
 * The web offers no free text: "อื่น ๆ" is an entry of its own. Change both lists together.
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
  'วิทยาลัยพลังงานทดแทนและสมาร์ทกริดเทคโนโลยี',
  'อื่น ๆ',
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

/** The faculty on the registration form: one entry of FACULTIES, or empty for none. */
export const Faculty = () =>
  applyDecorators(
    IsOptional(),
    ApiProperty({ type: String, required: false, nullable: true, enum: FACULTIES }),
    Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)),
    IsIn([...FACULTIES, '']),
  );
