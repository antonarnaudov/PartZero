/**
 * The `.partzero` manifest (`manifest.json`, FULL-MODELING-PLAN §2.9): format version, generator, the IR schema, the
 * SHA-256 of every other entry, and the view state that is not IR (the rollback marker, hidden items, the camera).
 *
 * Format versions: {@link PARTZERO_FORMAT_VERSION} is what this build writes. A reader accepts every version up to it
 * (older ones pass through {@link MIGRATIONS}) and refuses newer ones with `PZ_FORMAT_TOO_NEW`, so an old app never
 * half-reads a file it does not understand. Additive, optional fields do not bump the version.
 */
import { z } from "zod";

export const PARTZERO_FORMAT = "partzero";
export const PARTZERO_FORMAT_VERSION = 1;
export const PARTZERO_EXTENSION = "partzero";
export const PARTZERO_MEDIA_TYPE = "application/vnd.partzero+zip";

/** The fixed entry names. */
export const ENTRY = {
  manifest: "manifest.json",
  document: "document.json",
  code: "cadscript/main.cad.ts",
  thumbnail: "thumbnail.png",
} as const;

/** Directories whose entries the manifest lists by name. */
export const DIRS = { annotations: "annotations/", blobs: "blobs/", cache: "cache/", checkpoints: "checkpoints/" } as const;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "a lowercase hex SHA-256");

export const EntryInfoSchema = z.strictObject({
  size: z.number().int().min(0),
  sha256: Sha256,
});

/** A reference mesh (an imported STL/3MF/OBJ): displayed and measured, never edited, never part of the IR. */
export const ReferenceSchema = z.strictObject({
  /** Stable id within the document, e.g. `ref1`. */
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  /** Display name (the imported file's name without extension, editable). */
  name: z.string().min(1).max(200),
  /** The blob entry holding the original file, `blobs/<sha256>.<ext>`. */
  blob: z.string().regex(/^blobs\/[0-9a-f]{64}\.(stl|3mf|obj)$/),
  format: z.enum(["stl", "3mf", "obj"]),
  /** Units of the mesh coordinates after import (always mm: 3MF units are converted; STL and OBJ are taken as mm). */
  units: z.literal("mm"),
  /** Scale applied to the file's coordinates to get mm (3MF inch → 25.4). */
  scale: z.number().positive().finite(),
  visible: z.boolean(),
  /** The original file name, for the record. */
  sourceName: z.string().max(500),
});

export const ViewStateSchema = z.strictObject({
  /** The timeline's rollback marker (a feature id), view state per SPEC §0.6: evaluation never reads it. */
  rollbackMarker: z.string().nullable(),
  /** Ids of hidden bodies, sketches and references. */
  hidden: z.array(z.string()),
  /** The camera, as the viewport reports it (opaque here; the viewport validates it). */
  camera: z.unknown().nullable(),
});

export const ManifestSchema = z.looseObject({
  format: z.literal(PARTZERO_FORMAT),
  formatVersion: z.number().int().min(1),
  generator: z.strictObject({
    app: z.string().max(100),
    version: z.string().max(100),
    /** The Forge build that evaluated the cached results (null: no cache, or unknown). */
    forgeBuild: z.string().max(200).nullable(),
  }),
  document: z.strictObject({
    path: z.literal(ENTRY.document),
    /** e.g. `aicad.ir/0`. */
    irSchema: z.string().min(1).max(100),
    units: z.literal("mm"),
  }),
  /** The code view. `matchesDocument`: it compiled to `document.json` when it was saved. */
  code: z
    .strictObject({
      path: z.literal(ENTRY.code),
      language: z.literal("cadscript"),
      matchesDocument: z.boolean(),
    })
    .nullable(),
  thumbnail: z
    .strictObject({
      path: z.literal(ENTRY.thumbnail),
      width: z.number().int().min(1).max(4096),
      height: z.number().int().min(1).max(4096),
    })
    .nullable(),
  /** Every entry except `manifest.json`, with its size and SHA-256. */
  entries: z.record(z.string(), EntryInfoSchema),
  view: ViewStateSchema,
  references: z.array(ReferenceSchema),
});

export type EntryInfo = z.infer<typeof EntryInfoSchema>;
export type ReferenceEntry = z.infer<typeof ReferenceSchema>;
export type ViewState = z.infer<typeof ViewStateSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export const EMPTY_VIEW_STATE: ViewState = { rollbackMarker: null, hidden: [], camera: null };

/**
 * Migrations of older manifests: `MIGRATIONS[v]` turns a version-`v` manifest (as parsed JSON) into a version-`v+1`
 * one. Version 1 is the first, so there are none yet; the next format change adds `MIGRATIONS[1]`.
 */
export const MIGRATIONS: Readonly<Record<number, (manifest: Record<string, unknown>) => Record<string, unknown>>> = {};
