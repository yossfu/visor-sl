// Parser del mini-LSL: descenso recursivo con precedencia por escalada.
//
// Produce un AST sencillo (objetos planos con `type`), que es lo que consume el
// interprete. No hay bytecode ni optimizacion: los scripts son pequenos y el
// presupuesto de ejecucion es lo que protege al visor, no la velocidad.
//
// Cobertura: los seis tipos, variables globales y locales, funciones con
// parametros, estados (`default`, `state otro { }` y el cambio `state otro;`),
// if/else, for, while, do-while, break/continue, return, comentarios, literales
// de vector/rotacion/lista, casts, ternario, operadores compuestos y postfix
// ++/--.

import { tokenize, isTypeName } from "./lexer.js";
import { LslSyntaxError } from "./errors.js";

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%="]);
const BINARY_LEVELS = [
  ["||"],
  ["&&"],
  ["|"],
  ["^"],
  ["&"],
  ["==", "!="],
  ["<", ">", "<=", ">="],
  ["<<", ">>"],
  ["+", "-"],
  ["*", "/", "%"],
];

export function parse(src) {
  const toks = tokenize(src);
  let p = 0;

  const peek = (k = 0) => toks[Math.min(p + k, toks.length - 1)];
  const at = (type, value) => {
    const t = peek();
    return t.type === type && (value === undefined || t.value === value);
  };
  const atOp = (v) => at("op", v);
  const atKw = (v) => at("kw", v);
  const next = () => toks[p++];
  const line = () => peek().line;

  function expectOp(v) {
    if (!atOp(v)) throw new LslSyntaxError("se esperaba '" + v + "' y hay '" + describe(peek()) + "'", peek().line, peek().col);
    return next();
  }
  function expectKw(v) {
    if (!atKw(v)) throw new LslSyntaxError("se esperaba '" + v + "'", peek().line, peek().col);
    return next();
  }
  function expectIdent(what) {
    if (peek().type !== "ident") throw new LslSyntaxError("se esperaba " + (what || "un nombre") + " y hay '" + describe(peek()) + "'", peek().line, peek().col);
    return next().value;
  }
  function describe(t) {
    if (t.type === "eof") return "el final";
    if (t.type === "str") return '"' + t.value + '"';
    return String(t.value === null ? t.type : t.value);
  }

  // --- tipos -----------------------------------------------------------------
  function parseType() {
    const t = peek();
    if (!isTypeName(t)) throw new LslSyntaxError("se esperaba un tipo (integer, float, string, key, vector, rotation, list)", t.line, t.col);
    next();
    return t.value;
  }

  // --- declaraciones ---------------------------------------------------------
  function parseVarDecl() {
    const declType = parseType();
    const names = [];
    for (;;) {
      const name = expectIdent("un nombre de variable");
      let init = null;
      if (atOp("=")) { next(); init = parseExpr(); }
      names.push({ name, init });
      if (atOp(",")) { next(); continue; }
      break;
    }
    expectOp(";");
    return { type: "VarDecl", declType, names, line: line() };
  }

  function parseParams() {
    expectOp("(");
    const params = [];
    if (!atOp(")")) {
      for (;;) {
        const ptype = parseType();
        const name = expectIdent("un nombre de parámetro");
        params.push({ ptype, name });
        if (atOp(",")) { next(); continue; }
        break;
      }
    }
    expectOp(")");
    return params;
  }

  // Cuerpo de un evento o de una funcion: bloque normal, pero las sentencias
  // "de nivel de estado" (declarar una funcion) no existen dentro.
  function parseHandlerDef() {
    const name = expectIdent("el nombre del evento");
    const ln = line();
    const params = parseParams();
    const body = parseBlock();
    return { type: "Handler", name, params, body, line: ln };
  }

  function parseState(name) {
    const ln = line();
    expectOp("{");
    const handlers = [];
    while (!atOp("}")) {
      if (at("eof")) throw new LslSyntaxError("falta cerrar el estado '" + name + "'", peek().line, peek().col);
      if (isTypeName(peek())) {
        throw new LslSyntaxError("dentro de un estado solo van eventos; usa variables globales fuera", peek().line, peek().col);
      }
      handlers.push(parseHandlerDef());
    }
    expectOp("}");
    return { type: "State", name, handlers, line: ln };
  }

  // --- sentencias ------------------------------------------------------------
  function parseBlock() {
    expectOp("{");
    const body = [];
    while (!atOp("}")) {
      if (at("eof")) throw new LslSyntaxError("falta cerrar la llave '{'", peek().line, peek().col);
      body.push(parseStmt());
    }
    expectOp("}");
    return { type: "Block", body, line: line() };
  }

  function parseStmt() {
    if (atOp("{")) return parseBlock();
    if (atOp(";")) { next(); return { type: "Empty", line: line() }; }
    if (isTypeName(peek())) return parseVarDecl();

    if (atKw("if")) {
      const ln = line(); next();
      expectOp("(");
      const test = parseExpr();
      expectOp(")");
      const cons = parseStmt();
      let alt = null;
      if (atKw("else")) { next(); alt = parseStmt(); }
      return { type: "If", test, cons, alt, line: ln };
    }
    if (atKw("for")) {
      const ln = line(); next();
      expectOp("(");
      let init = null;
      if (!atOp(";")) init = isTypeName(peek()) ? parseVarDecl() : parseExprStmt();
      else expectOp(";");
      let test = null;
      if (!atOp(";")) test = parseExpr();
      expectOp(";");
      let update = null;
      if (!atOp(")")) update = parseExpr();
      expectOp(")");
      return { type: "For", init, test, update, body: parseStmt(), line: ln };
    }
    if (atKw("while")) {
      const ln = line(); next();
      expectOp("(");
      const test = parseExpr();
      expectOp(")");
      return { type: "While", test, body: parseStmt(), line: ln };
    }
    if (atKw("do")) {
      const ln = line(); next();
      const body = parseStmt();
      expectKw("while");
      expectOp("(");
      const test = parseExpr();
      expectOp(")");
      expectOp(";");
      return { type: "DoWhile", body, test, line: ln };
    }
    if (atKw("return")) {
      const ln = line(); next();
      let arg = null;
      if (!atOp(";")) arg = parseExpr();
      expectOp(";");
      return { type: "Return", arg, line: ln };
    }
    if (atKw("break")) { const ln = line(); next(); expectOp(";"); return { type: "Break", line: ln }; }
    if (atKw("continue")) { const ln = line(); next(); expectOp(";"); return { type: "Continue", line: ln }; }
    if (atKw("jump")) {
      throw new LslSyntaxError("'jump' no está soportado en este sandbox (usa for/while o estados)", peek().line, peek().col);
    }
    if (atKw("state")) {
      const ln = line(); next();
      const name = atKw("default") ? next().value : expectIdent("el nombre del estado");
      expectOp(";");
      return { type: "StateChange", name, line: ln };
    }
    return parseExprStmt();
  }

  function parseExprStmt() {
    const ln = line();
    const expr = parseExpr();
    expectOp(";");
    return { type: "ExprStmt", expr, line: ln };
  }

  // --- expresiones -----------------------------------------------------------
  function parseExpr() { return parseAssign(); }

  function parseAssign() {
    const left = parseTernary();
    if (ASSIGN_OPS.has(peek().value) && peek().type === "op") {
      const op = next().value;
      if (left.type !== "Ident" && left.type !== "Index" && left.type !== "Member") {
        throw new LslSyntaxError("no se puede asignar a esa expresión", peek().line, peek().col);
      }
      const value = parseAssign();
      return { type: "Assign", op, target: left, value, line: left.line };
    }
    return left;
  }

  function parseTernary() {
    const test = parseBinary(0);
    if (atOp("?")) {
      next();
      const cons = parseAssign();
      expectOp(":");
      const alt = parseAssign();
      return { type: "Ternary", test, cons, alt, line: test.line };
    }
    return test;
  }

  function parseBinary(level) {
    if (level >= BINARY_LEVELS.length) return parseUnary();
    let left = parseBinary(level + 1);
    for (;;) {
      const t = peek();
      if (t.type !== "op" || BINARY_LEVELS[level].indexOf(t.value) < 0) return left;
      next();
      const right = parseBinary(level + 1);
      const kind = (t.value === "&&" || t.value === "||") ? "Logical" : "Binary";
      left = { type: kind, op: t.value, left, right, line: t.line };
    }
  }

  // Los componentes de un literal de vector se leen con la escalada empezando en
  // el nivel de los desplazamientos: asi `>` y `<` quedan libres para cerrar y
  // abrir el literal (una comparacion dentro de un vector se puede poner entre
  // parentesis, que es lo que hace falta en la practica).
  function parseComponent() {
    const e = parseBinary(7);
    if (atOp("?")) {
      next();
      const cons = parseComponent();
      expectOp(":");
      const alt = parseComponent();
      return { type: "Ternary", test: e, cons, alt, line: e.line };
    }
    return e;
  }

  function parseUnary() {
    const t = peek();
    if (t.type === "op" && (t.value === "!" || t.value === "-" || t.value === "+" || t.value === "~")) {
      next();
      return { type: "Unary", op: t.value, arg: parseUnary(), line: t.line };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let expr = parsePrimary();
    for (;;) {
      if (atOp("++") || atOp("--")) {
        const op = next().value;
        expr = { type: "Postfix", op, arg: expr, line: expr.line };
        continue;
      }
      if (atOp("[")) {
        next();
        const index = parseExpr();
        expectOp("]");
        expr = { type: "Index", object: expr, index, line: expr.line };
        continue;
      }
      if (atOp(".")) {
        // Acceso a componente de vector (.x/.y/.z) o a miembro de rotacion.
        next();
        const name = expectIdent("la componente");
        expr = { type: "Member", object: expr, name, line: expr.line };
        continue;
      }
      return expr;
    }
  }

  function parsePrimary() {
    const t = peek();

    if (t.type === "num") { next(); return { type: "Literal", value: t.value, kind: Number.isInteger(t.value) ? "int" : "float", line: t.line }; }
    if (t.type === "str") { next(); return { type: "Str", value: t.value, line: t.line }; }

    if (t.type === "eof") throw new LslSyntaxError("la expresión está incompleta", t.line, t.col);

    // vector/rotacion: <a, b, c> o <x, y, z, s>
    // Ojo: los componentes se leen SIN los operadores relacionales, porque si no
    // el `>` de cierre se lo come el parser como un "mayor que" y se lía.
    if (atOp("<")) {
      next();
      const items = [parseComponent()];
      while (atOp(",")) { next(); items.push(parseComponent()); }
      expectOp(">");
      if (items.length !== 3 && items.length !== 4) {
        throw new LslSyntaxError("un vector tiene 3 componentes y una rotación 4", t.line, t.col);
      }
      return { type: items.length === 3 ? "VectorLit" : "RotLit", items, line: t.line };
    }

    // lista: [a, b, c]
    if (atOp("[")) {
      next();
      const items = [];
      if (!atOp("]")) {
        items.push(parseExpr());
        while (atOp(",")) { next(); if (atOp("]")) break; items.push(parseExpr()); }
      }
      expectOp("]");
      return { type: "ListLit", items, line: t.line };
    }

    // cast: (integer)expr -- se distingue de (expr) mirando dentro del parentesis
    if (atOp("(") && isTypeName(peek(1)) && peek(2) && peek(2).type === "op" && peek(2).value === ")") {
      next(); const to = next().value; next();
      return { type: "Cast", to, arg: parseUnary(), line: t.line };
    }

    if (atOp("(")) {
      next();
      const e = parseExpr();
      expectOp(")");
      return e;
    }

    if (t.type === "ident") {
      next();
      if (atOp("(")) {
        next();
        const args = [];
        if (!atOp(")")) {
          args.push(parseExpr());
          while (atOp(",")) { next(); args.push(parseExpr()); }
        }
        expectOp(")");
        return { type: "Call", name: t.value, args, line: t.line };
      }
      return { type: "Ident", name: t.value, line: t.line };
    }

    throw new LslSyntaxError("no se entiende '" + describe(t) + "'", t.line, t.col);
  }

  // --- programa --------------------------------------------------------------
  const globals = [];
  const funcs = [];
  const states = [];
  let sawDefault = false;

  while (!at("eof")) {
    if (atKw("default")) {
      next();
      states.push(parseState("default"));
      sawDefault = true;
      continue;
    }
    if (atKw("state")) {
      next();
      const name = expectIdent("el nombre del estado");
      states.push(parseState(name));
      continue;
    }
    if (isTypeName(peek())) {
      // Puede ser una variable global o una funcion con tipo de retorno.
      const declType = parseType();
      const ln = line();
      const name = expectIdent("un nombre");
      if (atOp("(")) {
        const params = parseParams();
        const body = parseBlock();
        funcs.push({ type: "Func", ret: declType, name, params, body, line: ln });
      } else {
        const names = [{ name, init: atOp("=") ? (next(), parseExpr()) : null }];
        while (atOp(",")) { next(); const nm = expectIdent("un nombre de variable"); names.push({ name: nm, init: atOp("=") ? (next(), parseExpr()) : null }); }
        expectOp(";");
        globals.push({ type: "VarDecl", declType, names, line: ln });
      }
      continue;
    }
    throw new LslSyntaxError("fuera de un estado solo van variables globales, funciones y estados", peek().line, peek().col);
  }

  if (!sawDefault) throw new LslSyntaxError("todo script necesita un estado 'default'", 1, 1);

  return { type: "Program", globals, funcs, states };
}

export function compileToAst(src) { return parse(src); }
