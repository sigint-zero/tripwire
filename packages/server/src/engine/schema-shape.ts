// What a JSON Schema accepts, reduced to a comparable shape, so the rule
// mirror's schema (generated from Zod) and the engine's rule.schema.json
// (generated from Rust) can be compared for what they accept rather than
// how they are written. Kept: types, `null`,
// constants, enums, required and closed fields, numeric and length
// bounds, array item rules. Ignored: titles, descriptions, defaults and
// string patterns, whose regex dialects differ; refinements no schema
// states are left to the example documents.

type Json = Record<string, unknown>;

export type Shape =
  | { kind: "any" | "null" | "boolean"; nullable?: true }
  | { kind: "const"; value: unknown; nullable?: true }
  | { kind: "enum"; values: unknown[]; nullable?: true }
  | {
      kind: "string";
      minLength?: number;
      maxLength?: number;
      nullable?: true;
    }
  | {
      kind: "integer" | "number";
      minimum?: number;
      maximum?: number;
      nullable?: true;
    }
  | {
      kind: "array";
      items: Shape;
      minItems?: number;
      maxItems?: number;
      unique?: true;
      nullable?: true;
    }
  | {
      kind: "object";
      properties: Record<string, Shape>;
      required: string[];
      closed: boolean;
      nullable?: true;
    }
  | { kind: "union"; members: Record<string, Shape>; nullable?: true };

/** The shape of `schema`, resolving `$ref`s against `root`. */
export function shapeOf(schema: Json, root: Json = schema): Shape {
  return shape(schema, root, new Set());
}

/** Every place two shapes differ, as `path: what`. */
export function differences(a: Shape, b: Shape, path = "#"): string[] {
  if (Boolean(a.nullable) !== Boolean(b.nullable)) {
    return [
      `${path}: null ${a.nullable ? "accepted" : "refused"} vs ${b.nullable ? "accepted" : "refused"}`,
    ];
  }
  if (a.kind !== b.kind) return [`${path}: ${a.kind} vs ${b.kind}`];
  const out: string[] = [];
  if (a.kind === "object" && b.kind === "object") {
    const keys = new Set([
      ...Object.keys(a.properties),
      ...Object.keys(b.properties),
    ]);
    for (const key of [...keys].sort()) {
      const left = a.properties[key];
      const right = b.properties[key];
      if (!left || !right) {
        out.push(
          `${path}/${key}: ${left ? "only in the first" : "only in the second"}`,
        );
      } else {
        out.push(...differences(left, right, `${path}/${key}`));
      }
    }
    if (a.required.join() !== b.required.join()) {
      out.push(
        `${path}: required [${a.required.join(", ")}] vs [${b.required.join(", ")}]`,
      );
    }
    if (a.closed !== b.closed)
      out.push(`${path}: closed ${a.closed} vs ${b.closed}`);
    return out;
  }
  if (a.kind === "union" && b.kind === "union") {
    const keys = new Set([
      ...Object.keys(a.members),
      ...Object.keys(b.members),
    ]);
    for (const key of [...keys].sort()) {
      const left = a.members[key];
      const right = b.members[key];
      if (!left || !right) {
        out.push(
          `${path}|${key}: ${left ? "only in the first" : "only in the second"}`,
        );
      } else {
        out.push(...differences(left, right, `${path}|${key}`));
      }
    }
    return out;
  }
  if (a.kind === "array" && b.kind === "array") {
    out.push(...differences(a.items, b.items, `${path}[]`));
  }
  const restA = without(a, "items", "properties", "members");
  const restB = without(b, "items", "properties", "members");
  if (JSON.stringify(sortKeys(restA)) !== JSON.stringify(sortKeys(restB))) {
    out.push(
      `${path}: ${JSON.stringify(sortKeys(restA))} vs ${JSON.stringify(sortKeys(restB))}`,
    );
  }
  return out;
}

function shape(node: Json, root: Json, seen: Set<string>): Shape {
  const ref = node.$ref as string | undefined;
  if (ref) {
    // Recursive definitions (boolean nodes nest) compare by name once seen.
    if (seen.has(ref)) return { kind: "const", value: "recursion" };
    return shape(resolve(root, ref), root, new Set([...seen, ref]));
  }
  const alternatives = (node.anyOf ?? node.oneOf) as Json[] | undefined;
  if (alternatives) return union(alternatives, root, seen);
  // `allOf: [{ $ref }]` is how a described reference is written; `if`
  // conditions only narrow an object stated beside them.
  const plain = ((node.allOf as Json[] | undefined) ?? []).filter(
    (e) => !("if" in e),
  );
  if (plain.length === 1 && !node.type && !node.properties) {
    return shape(plain[0]!, root, seen);
  }

  const types = Array.isArray(node.type)
    ? (node.type as string[])
    : node.type
      ? [node.type as string]
      : [];
  const nullable = types.includes("null");
  const type = types.find((t) => t !== "null");
  if (
    nullable &&
    !type &&
    !("const" in node) &&
    !node.enum &&
    !node.properties
  ) {
    return { kind: "null" };
  }
  const tag = <S extends Shape>(s: S): S =>
    nullable ? { ...s, nullable: true } : s;

  if ("const" in node) return tag({ kind: "const", value: node.const });
  if (Array.isArray(node.enum)) {
    const values = (node.enum as unknown[]).filter((v) => v !== null);
    const withNull = values.length !== node.enum.length;
    const s: Shape = { kind: "enum", values: [...values].sort() };
    return withNull || nullable ? { ...s, nullable: true } : s;
  }
  switch (type) {
    case "object":
      return tag({
        kind: "object",
        properties: Object.fromEntries(
          Object.entries(
            (node.properties as Record<string, Json> | undefined) ?? {},
          ).map(([key, value]) => [key, shape(value, root, seen)]),
        ),
        required: [...((node.required as string[] | undefined) ?? [])].sort(),
        closed: node.additionalProperties === false,
      });
    case "array":
      return tag({
        kind: "array",
        items: node.items
          ? shape(node.items as Json, root, seen)
          : { kind: "any" },
        ...bound("minItems", node.minItems),
        ...bound("maxItems", node.maxItems),
        ...(node.uniqueItems === true ? { unique: true as const } : {}),
      });
    case "string":
      return tag({
        kind: "string",
        ...bound("minLength", node.minLength),
        ...bound("maxLength", node.maxLength),
      });
    case "integer":
    case "number":
      return tag({
        kind: type,
        // Zod states its safe-integer range on every integer; JSON numbers
        // past it are not integers JavaScript can hold either way.
        ...bound("minimum", unsafeEdge(node.minimum ?? node.exclusiveMinimum)),
        ...bound("maximum", unsafeEdge(node.maximum ?? node.exclusiveMaximum)),
      });
    case "boolean":
      return tag({ kind: "boolean" });
    case "null":
      return { kind: "null" };
    default:
      if (node.properties)
        return shape({ ...node, type: "object" }, root, seen);
      return tag({ kind: "any" });
  }
}

/**
 * Alternatives: `null` becomes nullability; one remaining alternative is
 * itself; several become members keyed by what tells them apart. A set of
 * objects told apart by a constant `action` is the engine's one object
 * with an `action` enum, so it is merged into that object.
 */
function union(alternatives: Json[], root: Json, seen: Set<string>): Shape {
  const flat = alternatives.flatMap((a) => {
    const s = shape(a, root, seen);
    return s.kind === "union"
      ? Object.values(s.members).map((m) => ({
          ...m,
          ...(s.nullable ? { nullable: true as const } : {}),
        }))
      : [s];
  });
  const nullable = flat.some((s) => s.kind === "null" || s.nullable);
  const rest = flat
    .filter((s) => s.kind !== "null")
    .map((s) => without(s, "nullable") as Shape);
  let result: Shape;
  if (rest.length === 1) {
    result = rest[0]!;
  } else if (
    rest.length > 1 &&
    rest.every(
      (s) => s.kind === "object" && constOf(s.properties.action) !== undefined,
    )
  ) {
    result = mergeActions(rest as Extract<Shape, { kind: "object" }>[]);
  } else {
    result = {
      kind: "union",
      members: Object.fromEntries(rest.map((s) => [memberKey(s), s])),
    };
  }
  return nullable ? { ...result, nullable: true } : result;
}

function mergeActions(members: Extract<Shape, { kind: "object" }>[]): Shape {
  const keys = new Set(members.flatMap((m) => Object.keys(m.properties)));
  const properties: Record<string, Shape> = {};
  for (const key of keys) {
    if (key === "action") {
      properties.action = {
        kind: "enum",
        values: members.map((m) => constOf(m.properties.action)).sort(),
      };
      continue;
    }
    const seen = members.map((m) => m.properties[key]);
    const real = seen.filter((s): s is Shape => !!s && s.kind !== "null");
    const nullable = seen.some((s) => !s || s.kind === "null" || s.nullable);
    const bare = real.map((s) =>
      JSON.stringify(sortKeys(without(s, "nullable"))),
    );
    const one =
      real[0] && new Set(bare).size === 1 ? real[0] : { kind: "any" as const };
    const b = without(one, "nullable") as Shape;
    properties[key] = nullable ? { ...b, nullable: true } : b;
  }
  const required = [...keys]
    .filter((k) => members.every((m) => m.required.includes(k)))
    .sort();
  return {
    kind: "object",
    properties,
    required,
    closed: members.every((m) => m.closed),
  };
}

function memberKey(s: Shape): string {
  if (s.kind === "const") return `const:${JSON.stringify(s.value)}`;
  if (s.kind === "object") {
    const node = constOf(s.properties.node);
    if (node !== undefined) {
      const yields = constOf(s.properties.yields);
      return yields === undefined
        ? `node:${JSON.stringify(node)}`
        : `node:${JSON.stringify(node)}:${JSON.stringify(yields)}`;
    }
    return `object:${Object.keys(s.properties).sort().join(",")}`;
  }
  return s.kind;
}

function constOf(s: Shape | undefined): unknown {
  return s?.kind === "const" ? s.value : undefined;
}

function unsafeEdge(value: unknown): unknown {
  return value === Number.MAX_SAFE_INTEGER || value === Number.MIN_SAFE_INTEGER
    ? undefined
    : value;
}

function bound(key: string, value: unknown): Record<string, number> {
  return typeof value === "number" ? { [key]: value } : {};
}

function resolve(root: Json, ref: string): Json {
  let node: unknown = root;
  for (const part of ref.replace(/^#\//, "").split("/")) {
    node = (node as Json)[part];
  }
  return node as Json;
}

function without(value: object, ...keys: string[]): Json {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}

function sortKeys(value: Json): Json {
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
  );
}
