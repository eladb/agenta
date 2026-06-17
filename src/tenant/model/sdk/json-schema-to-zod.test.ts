import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { TOOLS } from '../tools';
import { jsonSchemaToZodShape } from './json-schema-to-zod';

// Helper: build the shape from a tool's real params, then validate via z.object.
function shapeFor(name: string): Record<string, z.ZodTypeAny> {
  const t = TOOLS[name];
  if (!t) throw new Error(`no tool ${name}`);
  return jsonSchemaToZodShape(t.params);
}

describe('jsonSchemaToZodShape — real tool schemas', () => {
  test('bash {command} — required string', () => {
    const shape = shapeFor('bash');
    expect(Object.keys(shape)).toEqual(['command']);
    const obj = z.object(shape);
    expect(obj.parse({ command: 'ls' })).toEqual({ command: 'ls' });
    // missing required field fails
    expect(() => obj.parse({})).toThrow();
    // wrong type fails
    expect(() => obj.parse({ command: 123 })).toThrow();
  });

  test('read_file {path, offset?, limit?} — required + optional integers', () => {
    const shape = shapeFor('read_file');
    expect(new Set(Object.keys(shape))).toEqual(new Set(['path', 'offset', 'limit']));
    const obj = z.object(shape);
    // path only is valid (offset/limit optional)
    expect(obj.parse({ path: 'a.txt' })).toEqual({ path: 'a.txt' });
    // integers accepted
    expect(obj.parse({ path: 'a.txt', offset: 2, limit: 5 })).toEqual({
      path: 'a.txt',
      offset: 2,
      limit: 5,
    });
    // integer constraint: float rejected
    expect(() => obj.parse({ path: 'a.txt', offset: 1.5 })).toThrow();
    // missing required path fails
    expect(() => obj.parse({ offset: 1 })).toThrow();
  });

  test('write_file {path, content} — both required', () => {
    const shape = shapeFor('write_file');
    expect(new Set(Object.keys(shape))).toEqual(new Set(['path', 'content']));
    const obj = z.object(shape);
    expect(obj.parse({ path: 'a', content: 'b' })).toEqual({ path: 'a', content: 'b' });
    expect(() => obj.parse({ path: 'a' })).toThrow();
  });

  test('edit_file {path, old_string, new_string} — all required', () => {
    const shape = shapeFor('edit_file');
    expect(new Set(Object.keys(shape))).toEqual(new Set(['path', 'old_string', 'new_string']));
    const obj = z.object(shape);
    expect(obj.parse({ path: 'a', old_string: 'x', new_string: 'y' })).toEqual({
      path: 'a',
      old_string: 'x',
      new_string: 'y',
    });
    expect(() => obj.parse({ path: 'a', old_string: 'x' })).toThrow();
  });

  test('fetch_url {url} — required string', () => {
    const shape = shapeFor('fetch_url');
    expect(Object.keys(shape)).toEqual(['url']);
    const obj = z.object(shape);
    expect(obj.parse({ url: 'http://x' })).toEqual({ url: 'http://x' });
    expect(() => obj.parse({})).toThrow();
  });

  test('get_current_time {} — empty shape', () => {
    const shape = shapeFor('get_current_time');
    expect(Object.keys(shape)).toEqual([]);
    // an empty object schema parses {}
    expect(z.object(shape).parse({})).toEqual({});
  });
});

describe('jsonSchemaToZodShape — keyword coverage', () => {
  test('enum → z.enum', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b'] } },
      required: ['mode'],
    });
    const obj = z.object(shape);
    expect(obj.parse({ mode: 'a' })).toEqual({ mode: 'a' });
    expect(() => obj.parse({ mode: 'c' })).toThrow();
  });

  test('boolean + number + array(items)', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        flag: { type: 'boolean' },
        count: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['flag', 'count', 'tags'],
    });
    const obj = z.object(shape);
    expect(obj.parse({ flag: true, count: 3.5, tags: ['x', 'y'] })).toEqual({
      flag: true,
      count: 3.5,
      tags: ['x', 'y'],
    });
    expect(() => obj.parse({ flag: true, count: 1, tags: [1] })).toThrow();
  });

  test('nested object', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'string' } },
          required: ['inner'],
        },
      },
      required: ['outer'],
    });
    const obj = z.object(shape);
    expect(obj.parse({ outer: { inner: 'v' } })).toEqual({ outer: { inner: 'v' } });
    expect(() => obj.parse({ outer: {} })).toThrow();
  });

  test('description is attached', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: { x: { type: 'string', description: 'the x value' } },
      required: ['x'],
    });
    expect(shape.x?.description).toBe('the x value');
  });

  test('unknown/missing type falls back to z.any', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: { weird: { type: 'mystery' }, none: {} },
      required: ['weird'],
    });
    const obj = z.object(shape);
    // z.any accepts anything; `none` is optional so may be omitted
    expect(obj.parse({ weird: { whatever: 1 } })).toEqual({ weird: { whatever: 1 } });
  });

  test('non-object / empty schema → empty shape', () => {
    expect(jsonSchemaToZodShape(undefined)).toEqual({});
    expect(jsonSchemaToZodShape({})).toEqual({});
    expect(jsonSchemaToZodShape({ type: 'object' })).toEqual({});
  });
});
