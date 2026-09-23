/** Worker: the CadScript compiler, type-checker, printer and edit splicer. */
import { applyIrEdit, print } from "@aicad/cadscript";
import { serveRpc } from "../worker-rpc";
import { compileAndCheck } from "./inline-service";
import type { CadScriptRequest } from "./worker-service";

serveRpc<CadScriptRequest>((req) => {
  switch (req.type) {
    case "compile":
      return Promise.resolve({ result: compileAndCheck(req.source, req.base) });
    case "print":
      return Promise.resolve({ result: print(req.ir) });
    case "applyIrEdit":
      return Promise.resolve({ result: applyIrEdit(req.source, req.oldIr, req.newIr) });
  }
});
