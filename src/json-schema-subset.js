const DEFAULT_MAX_NODES = 100_000;
const DEFAULT_MAX_DEPTH = 64;

export function validateJsonSchemaSubset(value, schema, options = {}) {
  const state = {
    nodes: 0,
    maxNodes: boundedInteger(options.maxNodes, 1, 1_000_000, DEFAULT_MAX_NODES),
    maxDepth: boundedInteger(options.maxDepth, 1, 256, DEFAULT_MAX_DEPTH),
    rootSchema: schema,
    referenceDepth: 0,
    externalSchemas: options.externalSchemas && typeof options.externalSchemas === 'object' ? options.externalSchemas : {}
  };
  const failure = validateNode(value, schema, '$', 0, state);
  return failure ? { ok: false, error: failure } : { ok: true };
}

function validateNode(value, schema, path, depth, state) {
  state.nodes += 1;
  if (state.nodes > state.maxNodes) return diagnostic(path, 'maxNodes', 'The JSON value is too complex.');
  if (depth > state.maxDepth) return diagnostic(path, 'maxDepth', 'The JSON value is nested too deeply.');
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return diagnostic(path, 'schema', 'The JSON schema is invalid.');
  }
  if (typeof schema.$ref === 'string') {
    const referenced = resolveReference(state, schema.$ref);
    if (!referenced || state.referenceDepth > state.maxDepth) return diagnostic(path, '$ref', 'The JSON schema reference is invalid.');
    return validateNode(value, referenced.schema, path, depth + 1, {
      ...state,
      rootSchema: referenced.root,
      referenceDepth: state.referenceDepth + 1
    });
  }
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) {
      const failure = validateNode(value, child, path, depth + 1, state);
      if (failure) return failure;
    }
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((child) => !validateNode(value, child, path, depth + 1, { ...state }))) {
      return diagnostic(path, 'anyOf', 'The JSON value does not match any allowed shape.');
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((child) => !validateNode(value, child, path, depth + 1, { ...state })).length;
    if (matches !== 1) return diagnostic(path, 'oneOf', 'The JSON value does not match exactly one allowed shape.');
  }
  if (Object.hasOwn(schema, 'const') && !deepEqual(value, schema.const)) {
    return diagnostic(path, 'const', 'The JSON value does not match the required constant.');
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(value, item))) {
    return diagnostic(path, 'enum', 'The JSON value is not in the allowed set.');
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return diagnostic(path, 'type', 'The JSON value has the wrong type.');
  }
  if (typeof value === 'string') return validateString(value, schema, path);
  if (typeof value === 'number') return validateNumber(value, schema, path);
  if (Array.isArray(value)) return validateArray(value, schema, path, depth, state);
  if (value && typeof value === 'object') return validateObject(value, schema, path, depth, state);
  return null;
}

function validateString(value, schema, path) {
  if (Number.isSafeInteger(schema.minLength) && value.length < schema.minLength) return diagnostic(path, 'minLength', 'The string is too short.');
  if (Number.isSafeInteger(schema.maxLength) && value.length > schema.maxLength) return diagnostic(path, 'maxLength', 'The string is too long.');
  if (typeof schema.pattern === 'string') {
    try {
      if (!new RegExp(schema.pattern, 'u').test(value)) return diagnostic(path, 'pattern', 'The string does not match the required pattern.');
    } catch {
      return diagnostic(path, 'schema', 'The JSON schema pattern is invalid.');
    }
  }
  if (schema.format === 'date-time' && !validDateTime(value)) return diagnostic(path, 'format', 'The string is not a valid date-time.');
  return null;
}

function validateNumber(value, schema, path) {
  if (!Number.isFinite(value)) return diagnostic(path, 'type', 'The number must be finite.');
  if (typeof schema.minimum === 'number' && value < schema.minimum) return diagnostic(path, 'minimum', 'The number is too small.');
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return diagnostic(path, 'exclusiveMinimum', 'The number is not above the exclusive minimum.');
  if (typeof schema.maximum === 'number' && value > schema.maximum) return diagnostic(path, 'maximum', 'The number is too large.');
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return diagnostic(path, 'exclusiveMaximum', 'The number is not below the exclusive maximum.');
  return null;
}

function validateArray(value, schema, path, depth, state) {
  if (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems) return diagnostic(path, 'minItems', 'The array has too few items.');
  if (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems) return diagnostic(path, 'maxItems', 'The array has too many items.');
  if (schema.uniqueItems === true) {
    const identities = new Set(value.map((item) => JSON.stringify(item)));
    if (identities.size !== value.length) return diagnostic(path, 'uniqueItems', 'The array contains duplicate items.');
  }
  if (schema.items && typeof schema.items === 'object') {
    for (let index = 0; index < value.length; index += 1) {
      const failure = validateNode(value[index], schema.items, `${path}[${index}]`, depth + 1, state);
      if (failure) return failure;
    }
  }
  return null;
}

function validateObject(value, schema, path, depth, state) {
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (!Object.hasOwn(value, key)) return diagnostic(`${path}.${key}`, 'required', 'A required field is missing.');
  }
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
    if (unknown) return diagnostic(`${path}.${unknown}`, 'additionalProperties', 'An unknown field is present.');
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) continue;
    const failure = validateNode(value[key], childSchema, `${path}.${key}`, depth + 1, state);
    if (failure) return failure;
  }
  return null;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left !== 'object') return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function diagnostic(path, keyword, message) {
  return { path, keyword, message };
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

function resolveLocalReference(root, reference) {
  if (reference === '#') return root;
  if (!reference.startsWith('#/')) return null;
  let current = root;
  for (const encoded of reference.slice(2).split('/')) {
    const key = encoded.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return null;
    current = current[key];
  }
  return current;
}

function resolveReference(state, reference) {
  if (reference.startsWith('#')) {
    const schema = resolveLocalReference(state.rootSchema, reference);
    return schema ? { root: state.rootSchema, schema } : null;
  }
  const [resource, fragment = ''] = reference.split('#', 2);
  const root = state.externalSchemas[resource]
    ?? Object.values(state.externalSchemas).find((candidate) => candidate?.$id === resource || candidate?.$id?.endsWith(`/${resource}`));
  if (!root) return null;
  const schema = fragment ? resolveLocalReference(root, `#${fragment}`) : root;
  return schema ? { root, schema } : null;
}

function validDateTime(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}
