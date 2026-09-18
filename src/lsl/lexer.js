// Lexer del mini-LSL. Devuelve una lista plana de tokens con linea y columna,
// que es lo que necesita el editor para subrayar el error.
//
// particularidades de LSL que hay que respetar:
//  - `0x1F` es un entero hexadecimal; los enteros se guardan como number.
//  - los comentarios son `//` y `/* */` (anidables, como en LSL).
//  - no hay caracteres de escape en las strings salvo `\n`, `\t`, `\"`, `\\`.

import { LslSyntaxError } from "./errors.js";

const KEYWORDS = new Set([
  "integer", "float", "string", "key", "vector", "rotation", "list",
  "if", "else", "for", "while", "do", "return", "state", "default",
  "break", "continue", "jump",
]);

const TYPES = new Set(["integer", "float", "string", "key", "vector", "rotation", "list"]);

// Los operadores van de mas largo a mas corto para que el scanner no parta
// `+=` en `+` y `=`.
const OPERATORS = [
  "++", "--", "+=", "-=", "*=", "/=", "%=", "==", "!=", "<=", ">=", "&&", "||",
  "<<", ">>",
  "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~",
  "(", ")", "{", "}", "[", "]", ",", ";", ".", "?", ":",
];

export function isTypeName(tok) {
  return tok && tok.type === "kw" && TYPES.has(tok.value);
}

export function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let col = 1;

  const push = (type, value, l, c) => toks.push({ type, value, line: l, col: c });
  const advance = (k) => { i += k; col += k; };

  while (i < n) {
    const ch = src[i];

    if (ch === "\n") { i++; line++; col = 1; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { advance(1); continue; }

    // comentarios
    if (ch === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      let depth = 1;
      const sl = line, sc = col;
      i += 2; col += 2;
      while (i < n && depth > 0) {
        if (src[i] === "\n") { i++; line++; col = 1; continue; }
        if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; col += 2; continue; }
        if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; col += 2; continue; }
        i++; col++;
      }
      if (depth > 0) throw new LslSyntaxError("comentario /* sin cerrar", sl, sc);
      continue;
    }

    // strings
    if (ch === '"') {
      const sl = line, sc = col;
      let out = "";
      advance(1);
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === "\\") {
          const e = src[i + 1];
          if (e === "n") out += "\n";
          else if (e === "t") out += "\t";
          else if (e === "\\") out += "\\";
          else if (e === '"') out += '"';
          else if (e === "\n") { /* continuacion de linea: LSL la ignora */ }
          else out += e === undefined ? "" : e;
          i += 2; col += 2;
          continue;
        }
        if (c === '"') { advance(1); closed = true; break; }
        if (c === "\n") break;
        out += c; advance(1);
      }
      if (!closed) throw new LslSyntaxError("falta cerrar la comilla", sl, sc);
      push("str", out, sl, sc);
      continue;
    }

    // numeros (entero, hexadecimal, float con exponente)
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] || ""))) {
      const sl = line, sc = col;
      let text = "";
      let isFloat = false;
      if (ch === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        text = "0x";
        advance(2);
        while (i < n && /[0-9a-fA-F]/.test(src[i])) { text += src[i]; advance(1); }
        push("num", parseInt(text, 16) | 0, sl, sc);
        continue;
      }
      while (i < n && /[0-9]/.test(src[i])) { text += src[i]; advance(1); }
      if (src[i] === ".") { isFloat = true; text += "."; advance(1); while (i < n && /[0-9]/.test(src[i])) { text += src[i]; advance(1); } }
      if (src[i] === "e" || src[i] === "E") {
        isFloat = true; text += src[i]; advance(1);
        if (src[i] === "+" || src[i] === "-") { text += src[i]; advance(1); }
        while (i < n && /[0-9]/.test(src[i])) { text += src[i]; advance(1); }
      }
      push("num", isFloat ? parseFloat(text) : parseInt(text, 10), sl, sc);
      continue;
    }

    // identificadores y palabras clave
    if (/[A-Za-z_]/.test(ch)) {
      const sl = line, sc = col;
      let text = "";
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) { text += src[i]; advance(1); }
      push(KEYWORDS.has(text) ? "kw" : "ident", text, sl, sc);
      continue;
    }

    // operadores
    let matched = null;
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) {
      push("op", matched, line, col);
      advance(matched.length);
      continue;
    }

    throw new LslSyntaxError("carácter inesperado '" + ch + "'", line, col);
  }

  push("eof", null, line, col);
  return toks;
}
