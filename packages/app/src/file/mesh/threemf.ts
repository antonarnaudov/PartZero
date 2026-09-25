/**
 * 3MF reader (the core spec's mesh objects, components and build items, plus the production extension's `p:path`,
 * which slicers such as Bambu Studio use to keep each object in its own model file). Everything in the build is
 * flattened into one mesh in millimetres (the model's `unit` is converted), with every item and component transform
 * applied. Materials, colours, slicer settings and thumbnails are ignored.
 */
import { readZip, ZipError } from "../partzero/zip";
import { DEFAULT_MESH_LIMITS, MeshError, checkMesh, type MeshLimits, type TriangleMesh } from "./mesh";

const UNIT_SCALE: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

/** A 3×4 affine transform in 3MF's row order: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32. */
type Mat = readonly number[];
const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseMatrix(s: string | undefined): Mat {
  if (s === undefined || s.trim() === "") return IDENTITY;
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) throw new MeshError("MESH_MALFORMED", `invalid 3MF transform: ${s.slice(0, 80)}`);
  return v;
}

/** `a` then `b` (row vectors: p × A × B). */
function compose(a: Mat, b: Mat): Mat {
  const r = new Array<number>(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  }
  for (let j = 0; j < 3; j++) r[9 + j] = a[9]! * b[j]! + a[10]! * b[3 + j]! + a[11]! * b[6 + j]! + b[9 + j]!;
  return r;
}

interface Tag {
  name: string;
  attrs: Record<string, string>;
  close: boolean;
  selfClose: boolean;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

/** A minimal XML tag scanner: element names without namespace prefixes, attributes with them (`p:path`). */
function* tags(xml: string): Generator<Tag> {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) return;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) return;
      i = end + 1;
      continue;
    }
    // Find the tag end, skipping `>` inside quoted attribute values.
    let j = lt + 1;
    let quote = "";
    for (; j < n; j++) {
      const ch = xml[j]!;
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
    }
    if (j >= n) return;
    const body = xml.slice(lt + 1, j);
    i = j + 1;
    const close = body.startsWith("/");
    const selfClose = body.endsWith("/");
    const inner = body.slice(close ? 1 : 0, selfClose ? -1 : undefined).trim();
    const sp = inner.search(/\s/);
    const qname = sp < 0 ? inner : inner.slice(0, sp);
    const name = qname.includes(":") ? qname.slice(qname.indexOf(":") + 1) : qname;
    const attrs: Record<string, string> = {};
    if (sp >= 0) {
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      const rest = inner.slice(sp);
      let m: RegExpExecArray | null;
      while ((m = re.exec(rest)) !== null) attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? "");
    }
    yield { name, attrs, close, selfClose };
  }
}

interface MeshObject {
  kind: "mesh";
  positions: number[];
  indices: number[];
}
interface ComponentsObject {
  kind: "components";
  components: Array<{ path: string; id: string; transform: Mat }>;
}
type ModelObject = MeshObject | ComponentsObject;

interface ParsedModel {
  scale: number;
  objects: Map<string, ModelObject>;
  build: Array<{ path: string; id: string; transform: Mat }>;
}

function attr(t: Tag, name: string): string | undefined {
  if (t.attrs[name] !== undefined) return t.attrs[name];
  for (const [k, v] of Object.entries(t.attrs)) if (k.endsWith(`:${name}`)) return v;
  return undefined;
}

function normPath(p: string): string {
  return p.replace(/^\/+/, "");
}

function parseModel(xml: string, path: string, limits: MeshLimits, counter: { tris: number }): ParsedModel {
  const model: ParsedModel = { scale: 1, objects: new Map(), build: [] };
  let obj: { id: string; value: ModelObject } | null = null;
  let inBuild = false;
  for (const t of tags(xml)) {
    if (t.close) {
      if (t.name === "object" && obj) {
        model.objects.set(obj.id, obj.value);
        obj = null;
      } else if (t.name === "build") inBuild = false;
      continue;
    }
    switch (t.name) {
      case "model": {
        const unit = t.attrs["unit"] ?? "millimeter";
        const s = UNIT_SCALE[unit];
        if (s === undefined) throw new MeshError("MESH_UNSUPPORTED", `unknown 3MF unit: ${unit}`);
        model.scale = s;
        break;
      }
      case "object": {
        const id = t.attrs["id"];
        if (!id) throw new MeshError("MESH_MALFORMED", "a 3MF object has no id");
        obj = { id, value: { kind: "mesh", positions: [], indices: [] } };
        if (t.selfClose) {
          model.objects.set(id, obj.value);
          obj = null;
        }
        break;
      }
      case "components":
        if (obj) obj.value = { kind: "components", components: [] };
        break;
      case "component": {
        if (!obj || obj.value.kind !== "components") break;
        const id = t.attrs["objectid"];
        if (!id) throw new MeshError("MESH_MALFORMED", "a 3MF component has no objectid");
        const p = attr(t, "path");
        obj.value.components.push({ path: p ? normPath(p) : path, id, transform: parseMatrix(t.attrs["transform"]) });
        break;
      }
      case "vertex": {
        if (!obj || obj.value.kind !== "mesh") break;
        const x = Number(t.attrs["x"]);
        const y = Number(t.attrs["y"]);
        const z = Number(t.attrs["z"]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new MeshError("MESH_NOT_FINITE", "a 3MF vertex has a coordinate that is not a number");
        obj.value.positions.push(x, y, z);
        break;
      }
      case "triangle": {
        if (!obj || obj.value.kind !== "mesh") break;
        const a = Number(t.attrs["v1"]);
        const b = Number(t.attrs["v2"]);
        const c = Number(t.attrs["v3"]);
        if (![a, b, c].every((v) => Number.isInteger(v) && v >= 0)) throw new MeshError("MESH_MALFORMED", "a 3MF triangle has an invalid vertex index");
        obj.value.indices.push(a, b, c);
        if (++counter.tris > limits.maxTriangles) throw new MeshError("MESH_TOO_LARGE", `the 3MF has more than ${limits.maxTriangles.toLocaleString("en-US")} triangles`);
        break;
      }
      case "build":
        inBuild = !t.selfClose;
        break;
      case "item": {
        if (!inBuild) break;
        const id = t.attrs["objectid"];
        if (!id) throw new MeshError("MESH_MALFORMED", "a 3MF build item has no objectid");
        const p = attr(t, "path");
        model.build.push({ path: p ? normPath(p) : path, id, transform: parseMatrix(t.attrs["transform"]) });
        break;
      }
      default:
        break;
    }
  }
  return model;
}

/** The root model part: from `_rels/.rels` (the 3D model relationship), else `3D/3dmodel.model`. */
function rootModelPath(files: Map<string, Uint8Array>): string {
  const rels = files.get("_rels/.rels");
  if (rels) {
    const xml = new TextDecoder().decode(rels);
    for (const t of tags(xml)) {
      if (t.name === "Relationship" && /3dmodel$/i.test(t.attrs["Type"] ?? "") && t.attrs["Target"]) return normPath(t.attrs["Target"]);
    }
  }
  return "3D/3dmodel.model";
}

export function readThreeMf(bytes: Uint8Array, limits: MeshLimits = DEFAULT_MESH_LIMITS): TriangleMesh {
  let entries;
  try {
    entries = readZip(bytes, { maxTotalBytes: 2 * 1024 ** 3 });
  } catch (e) {
    if (e instanceof ZipError) throw new MeshError("MESH_MALFORMED", `not a readable 3MF file: ${e.message}`);
    throw e;
  }
  const files = new Map(entries.map((e) => [e.name, e.data]));
  const root = rootModelPath(files);
  const counter = { tris: 0 };
  const models = new Map<string, ParsedModel>();
  const model = (path: string): ParsedModel => {
    let m = models.get(path);
    if (!m) {
      const data = files.get(path);
      if (!data) throw new MeshError("MESH_MALFORMED", `the 3MF refers to ${path}, which it does not contain`);
      m = parseModel(new TextDecoder().decode(data), path, limits, counter);
      models.set(path, m);
    }
    return m;
  };
  const rootModel = model(root);
  const out: number[] = [];
  const idx: number[] = [];
  const emit = (path: string, id: string, transform: Mat, depth: number, stack: Set<string>): void => {
    const key = `${path}#${id}`;
    if (depth > 32 || stack.has(key)) throw new MeshError("MESH_MALFORMED", "the 3MF's components refer to each other in a cycle");
    const m = model(path);
    const o = m.objects.get(id);
    if (!o) throw new MeshError("MESH_MALFORMED", `the 3MF refers to object ${id} in ${path}, which does not exist`);
    // Every model file declares its own unit; coordinates are converted to mm before the transform (3MF transforms
    // are in the units of the model that holds them, and slicers write one unit per package).
    const s = m.scale;
    if (o.kind === "mesh") {
      const base = out.length / 3;
      const nv = o.positions.length / 3;
      for (let v = 0; v < nv; v++) {
        const x = o.positions[v * 3]! * s;
        const y = o.positions[v * 3 + 1]! * s;
        const z = o.positions[v * 3 + 2]! * s;
        out.push(
          x * transform[0]! + y * transform[3]! + z * transform[6]! + transform[9]! * s,
          x * transform[1]! + y * transform[4]! + z * transform[7]! + transform[10]! * s,
          x * transform[2]! + y * transform[5]! + z * transform[8]! + transform[11]! * s,
        );
      }
      for (const i of o.indices) {
        if (i >= nv) throw new MeshError("MESH_MALFORMED", `a triangle of object ${id} refers to a vertex that does not exist`);
        idx.push(base + i);
      }
      return;
    }
    stack.add(key);
    for (const c of o.components) emit(c.path, c.id, compose(c.transform, transform), depth + 1, stack);
    stack.delete(key);
  };
  if (rootModel.build.length === 0) throw new MeshError("MESH_EMPTY", "the 3MF's build has no items");
  for (const item of rootModel.build) emit(item.path, item.id, item.transform, 0, new Set());
  const mesh = { positions: new Float32Array(out), indices: new Uint32Array(idx) };
  checkMesh(mesh, limits);
  return mesh;
}
