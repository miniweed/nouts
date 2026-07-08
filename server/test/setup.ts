import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// La app lee DATA_DIR y NODE_ENV al importarse: hay que fijarlos antes de que
// el test importe `../dist/index.js`. Usamos un directorio temporal único para
// que cada ejecución arranque con una base de datos limpia y no abra el puerto.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nouts-test-"));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = "test";
