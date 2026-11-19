import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength, registerDecorator, ValidateNested } from 'class-validator';
import { validation } from './errors';
import { Bool, OneOf, Str } from './fields';

/** The registration form a supervisor sets on an activity or template (at most 10 questions), and the student's answers to it. */
export const MAX_QUESTIONS = 10;
export const MAX_ANSWER = 500;
const MAX_ANSWER_KEYS = 50;

export interface Question {
  id: string;
  label: string;
  type: 'text' | 'choice';
  options?: string[];
  required: boolean;
}

const trimEach = () => Transform(({ value }) => (Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : v)) : value));

export class QuestionDto {
  @Str({ min: 1, max: 40 }) id: string;
  @Str({ min: 1, max: 120 }) label: string;
  @OneOf(['text', 'choice']) type: 'text' | 'choice';
  @IsOptional()
  @ApiProperty({ type: [String], required: false, nullable: true, minItems: 2, maxItems: 10, description: 'choice เท่านั้น 2-10 ตัว ตัวละไม่เกิน 60' })
  @IsArray()
  @ArrayMaxSize(MAX_QUESTIONS)
  @trimEach()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(60, { each: true })
  options?: string[] | null;
  @Bool() required: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What a list of valid-looking questions still has to satisfy together: ids differ, and a choice has 2 to 10 options. */
function consistent(list: unknown[]) {
  const ids = new Set<string>();
  for (const q of list) {
    if (!isObject(q)) continue;
    if (typeof q.id === 'string') {
      if (ids.has(q.id)) return false;
      ids.add(q.id);
    }
    if (q.type === 'choice' && !(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= MAX_QUESTIONS)) return false;
  }
  return true;
}

const rule =
  (name: string, validate: (v: unknown) => boolean, message: string): PropertyDecorator =>
  (target, key) =>
    registerDecorator({ name, target: target.constructor, propertyName: key as string, validator: { validate, defaultMessage: () => message } });

/** `questions` on an activity or on template settings. */
export const QuestionList = (o: { optional?: boolean } = {}) =>
  applyDecorators(
    ...(o.optional ? [IsOptional()] : []),
    ApiProperty({ type: [QuestionDto], required: !o.optional, maxItems: MAX_QUESTIONS }),
    IsArray(),
    ArrayMaxSize(MAX_QUESTIONS),
    ValidateNested({ each: true }),
    Type(() => QuestionDto),
    rule('questionList', (v) => !Array.isArray(v) || consistent(v), 'questions must have different ids, and a choice needs 2 to 10 options'),
  );

/** The list as it is stored: only the known keys, and options only on a choice. */
export function cleanQuestions(list: QuestionDto[] | null | undefined): Question[] {
  return (list ?? []).map((q) => ({ id: q.id, label: q.label, type: q.type, ...(q.type === 'choice' ? { options: q.options ?? [] } : {}), required: q.required }));
}

/** `answers` on a registration: question id to text. Which ids exist is checked against the activity, not here. */
export const AnswerMap = () =>
  applyDecorators(
    IsOptional(),
    ApiProperty({ type: Object, additionalProperties: { type: 'string', maxLength: MAX_ANSWER }, required: false, nullable: true, description: '{ [questionId]: คำตอบ } ข้อที่ไม่มีในกิจกรรมถูกทิ้ง' }),
    rule(
      'answerMap',
      (v) => isObject(v) && Object.keys(v).length <= MAX_ANSWER_KEYS && Object.values(v).every((a) => typeof a === 'string' && a.trim().length <= MAX_ANSWER),
      `answers must map a question id to text of at most ${MAX_ANSWER} characters`,
    ),
  );

/**
 * The answers worth keeping for this activity's questions: trimmed, empty ones left out, ids it does not ask about
 * dropped. A required question must be answered and a choice must be one of its options.
 */
export function checkAnswers(questions: Question[], given: Record<string, string> | null | undefined): Record<string, string> {
  const kept: [string, string][] = [];
  const missing: string[] = [];
  const notAnOption: string[] = [];
  for (const q of questions) {
    const raw = given && Object.hasOwn(given, q.id) ? given[q.id] : '';
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) {
      if (q.required) missing.push(`answers.${q.id}`);
    } else if (q.type === 'choice' && !q.options?.includes(text)) notAnOption.push(`answers.${q.id}`);
    else kept.push([q.id, text]);
  }
  if (missing.length || notAnOption.length) {
    throw validation([...missing, ...notAnOption], missing.length ? 'ตอบคำถามที่จำเป็นให้ครบ' : 'คำตอบต้องเป็นหนึ่งในตัวเลือก');
  }
  // fromEntries defines each key as its own property, so an id such as "__proto__" cannot change the object.
  return Object.fromEntries(kept);
}
