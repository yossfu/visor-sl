// Punto de entrada del mini-LSL: compilar codigo y poco mas.
//
// `compile(source)` devuelve un `Interpreter` listo para crear instancias. Las
// constantes y la biblioteca estandar se construyen una sola vez y se comparten
// entre todos los scripts (son inmutables).

import { parse } from "./parser.js";
import { buildConstants } from "./constants.js";
import { buildBuiltins } from "./builtins.js";
import { Interpreter } from "./interp.js";
import { LslSyntaxError, LslRuntimeError, LslBudgetError, LslError } from "./errors.js";

let shared = null;
function sharedParts() {
  if (!shared) shared = { constants: buildConstants(), builtins: buildBuiltins() };
  return shared;
}

export function compile(source, opts = {}) {
  const ast = parse(String(source === null || source === undefined ? "" : source));
  const s = sharedParts();
  return new Interpreter(ast, {
    constants: s.constants,
    builtins: s.builtins,
    budgetSteps: opts.budgetSteps,
    budgetMs: opts.budgetMs,
    maxCallDepth: opts.maxCallDepth,
  });
}

// Utilidad para los tests y para el panel: compila y dice si hay error, sin
// lanzar. Tambien acepta un `host` falso para poder ejecutar eventos sin visor.
export function tryCompile(source) {
  try {
    return { ok: true, interp: compile(source), error: null };
  } catch (e) {
    return { ok: false, interp: null, error: describeError(e) };
  }
}

export function describeError(e) {
  if (e instanceof LslBudgetError) return { message: e.raw || e.message, line: 0, kind: "budget" };
  if (e instanceof LslSyntaxError) return { message: e.raw || e.message, line: e.line, kind: "syntax" };
  if (e instanceof LslRuntimeError) return { message: e.raw || e.message, line: e.line, kind: "runtime", event: e.event };
  if (e instanceof LslError) return { message: e.raw || e.message, line: e.line, kind: "lsl" };
  return { message: e && e.message ? e.message : String(e), line: 0, kind: "js" };
}

export { LslError, LslSyntaxError, LslRuntimeError, LslBudgetError };
export { Vec, Rot } from "./values.js";
export { defaultScript, EXAMPLE_SCRIPTS } from "./examples.js";
