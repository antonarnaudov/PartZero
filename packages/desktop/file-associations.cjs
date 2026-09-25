/**
 * The `.partzero` document type for electron-builder (FULL-MODELING-PLAN DOC-4 "file association and open-file"):
 * double-clicking a `.partzero` file in the Finder (or Explorer, or a Linux file manager) opens it in the app, which
 * receives it through `open-file` (macOS) or its command line (Windows, Linux); see src/main.ts.
 *
 * - `fileAssociations` becomes `CFBundleDocumentTypes` (macOS), registry entries (NSIS) and a MIME type (Linux).
 * - macOS also needs the type itself declared (`UTExportedTypeDeclarations`, `extendInfo` of the `mac` config), or the
 *   Finder does not know that `.partzero` is ours. It conforms to `public.data` and `public.content` only, not to
 *   `public.zip-archive`: otherwise Archive Utility would offer to unpack it on double-click.
 * @param {{ productName: string; appId: string }} edition
 */
function documentTypes(edition) {
  const uti = `${edition.appId}.document`;
  return {
    fileAssociations: [
      {
        ext: "partzero",
        name: `${edition.productName} Document`,
        description: `${edition.productName} Document`,
        mimeType: "application/vnd.partzero+zip",
        role: "Editor",
        rank: "Owner",
        isPackage: false,
      },
    ],
    extendInfo: {
      UTExportedTypeDeclarations: [
        {
          UTTypeIdentifier: uti,
          UTTypeDescription: `${edition.productName} Document`,
          UTTypeConformsTo: ["public.data", "public.content"],
          UTTypeTagSpecification: {
            "public.filename-extension": ["partzero"],
            "public.mime-type": ["application/vnd.partzero+zip"],
          },
        },
      ],
    },
  };
}

module.exports = { documentTypes };
