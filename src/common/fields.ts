import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { cleanName } from './format';
import { validation } from './errors';

/**
 * A validator and its OpenAPI description in one decorator, so the docs cannot drift from what is enforced.
 * `optional` lets a field be missing or null; PATCH bodies use null for "clear this field".
 */
type Common = { optional?: boolean };

/** The largest time a JavaScript Date can hold. Anything above it would become an invalid date. */
export const MAX_TIME_MS = 8.64e15;

const base = (type: unknown, o: Common, extra: Record<string, unknown> = {}) => [
  ...(o.optional ? [IsOptional()] : []),
  ApiProperty({ type: type as any, required: !o.optional, nullable: !!o.optional, ...extra }),
];

const trimmed = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export const Str = (o: Common & { min?: number; max?: number; matches?: RegExp; raw?: boolean } = {}) =>
  applyDecorators(
    ...base(String, o, { maxLength: o.max, minLength: o.min }),
    ...(o.raw ? [] : [trimmed()]),
    IsString(),
    ...(o.min !== undefined ? [MinLength(o.min)] : []),
    ...(o.max !== undefined ? [MaxLength(o.max)] : []),
    ...(o.matches ? [Matches(o.matches)] : []),
  );

/** A person's name: whitespace is cleaned before it is checked and stored. */
export const Name = (o: Common & { max?: number; allowEmpty?: boolean } = {}) =>
  applyDecorators(
    ...base(String, o, { minLength: o.allowEmpty ? 0 : 1, maxLength: o.max ?? 120 }),
    Transform(({ value }) => (typeof value === 'string' ? cleanName(value) : value)),
    IsString(),
    ...(o.allowEmpty ? [] : [MinLength(1)]),
    MaxLength(o.max ?? 120),
  );

export const Int = (o: Common & { min?: number; max?: number } = {}) =>
  applyDecorators(...base(Number, o, { minimum: o.min, maximum: o.max }), IsInt(), ...(o.min !== undefined ? [Min(o.min)] : []), ...(o.max !== undefined ? [Max(o.max)] : []));

export const Num = (o: Common & { min?: number; max?: number } = {}) =>
  applyDecorators(
    ...base(Number, o, { minimum: o.min, maximum: o.max }),
    IsNumber({ allowNaN: false, allowInfinity: false }),
    ...(o.min !== undefined ? [Min(o.min)] : []),
    ...(o.max !== undefined ? [Max(o.max)] : []),
  );

export const Bool = (o: Common = {}) => applyDecorators(...base(Boolean, o), IsBoolean());

export const OneOf = (values: readonly (string | number)[], o: Common = {}) =>
  applyDecorators(...base(typeof values[0] === 'number' ? Number : String, o, { enum: values }), IsIn(values as unknown[]));

export const Nested = (cls: new () => object, o: Common = {}) =>
  applyDecorators(
    ...base(cls, o),
    ValidateNested(),
    Type(() => cls),
  );

export const StrArray = (o: Common & { maxItems?: number; itemMax?: number } = {}) =>
  applyDecorators(...base(String, o, { isArray: true, maxItems: o.maxItems }), IsArray(), ArrayMaxSize(o.maxItems ?? 1000), IsString({ each: true }), MaxLength(o.itemMax ?? 64, { each: true }));

/** Keys that were actually sent, so a PATCH can tell "not sent" from "null". */
export const sentKeys = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined);

/** Fails with the names of required fields that are missing or null. */
export function assertRequired(o: Record<string, unknown>, keys: readonly string[]) {
  const missing = keys.filter((k) => o[k] === undefined || o[k] === null);
  if (missing.length) throw validation(missing);
}

/** Fails if any of these keys was sent as null. Used by PATCH for fields that cannot be cleared. */
export function assertNotNull(o: Record<string, unknown>, keys: readonly string[]) {
  const bad = keys.filter((k) => o[k] === null);
  if (bad.length) throw validation(bad);
}
