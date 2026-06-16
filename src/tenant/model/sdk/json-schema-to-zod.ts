import { z } from 'zod';

// A minimal JSON-Schema node shape — only the keywords our tool defs actually
// use. Everything is optional and untyped-friendly so we can be defensive on
// malformed/partial input rather than throwing.
type JsonSchemaNode = {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  additionalProperties?: boolean | JsonSchemaNode;
};

// Convert a single JSON-Schema node into a zod type. Unknown/missing types fall
// back to z.any() so a tool with an exotic schema still registers rather than
// crashing boot.
function nodeToZod(node: JsonSchemaNode | undefined): z.ZodTypeAny {
  if (!node || typeof node !== 'object') return z.any();

  let zt: z.ZodTypeAny;

  // enum wins over type — an enum is the tightest constraint we can express.
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const values = node.enum.filter((v): v is string => typeof v === 'string');
    if (values.length === node.enum.length && values.length > 0) {
      zt = z.enum(values as [string, ...string[]]);
    } else {
      // Mixed / non-string enum — accept the listed literals loosely.
      zt = z.any();
    }
  } else {
    switch (node.type) {
      case 'string':
        zt = z.string();
        break;
      case 'number':
        zt = z.number();
        break;
      case 'integer':
        zt = z.number().int();
        break;
      case 'boolean':
        zt = z.boolean();
        break;
      case 'array':
        zt = z.array(nodeToZod(node.items));
        break;
      case 'object':
        zt = z.object(jsonSchemaToZodShape(node));
        break;
      default:
        zt = z.any();
        break;
    }
  }

  if (typeof node.description === 'string' && node.description.length > 0) {
    zt = zt.describe(node.description);
  }
  return zt;
}

// Convert a JSON-Schema object (`{type:'object', properties, required?}`) into a
// zod RAW SHAPE — a plain `Record<string, ZodTypeAny>` mapping each property to
// its zod type. This is the 3rd argument the SDK's `tool(name, desc, shape,
// handler)` expects (it wraps the shape in z.object() internally).
//
// A property NOT listed in `required` is marked `.optional()`.
export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
  const node = (schema ?? {}) as JsonSchemaNode;
  const properties = node.properties;
  if (!properties || typeof properties !== 'object') return {};
  const required = new Set(Array.isArray(node.required) ? node.required : []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    let zt = nodeToZod(propSchema);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}
