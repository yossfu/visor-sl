// Errores del mini-LSL. Se separan en dos familias porque el editor los pinta
// distinto: los de sintaxis los detecta el parser (y traen linea/columna para
// subrayar), y los de ejecucion solo existen mientras corre un evento.

export class LslError extends Error {
  constructor(message, line, col) {
    super(line ? message + " (línea " + line + ")" : message);
    this.name = "LslError";
    this.raw = message;
    this.line = line || 0;
    this.col = col || 0;
  }
}

// Un error de sintaxis: se lanza al compilar, con posicion.
export class LslSyntaxError extends LslError {
  constructor(message, line, col) {
    super(message, line, col);
    this.name = "LslSyntaxError";
  }
}

// Un error de ejecucion: division por cero, indice fuera de rango, presupuesto
// agotado... Lleva el nombre del evento en el que ocurrio.
export class LslRuntimeError extends LslError {
  constructor(message, line, col, event) {
    super(message, line, col);
    this.name = "LslRuntimeError";
    this.event = event || null;
  }
}

// El presupuesto de instrucciones es la defensa contra `while (1) {}`: corta el
// evento en vez de colgar la pestaña. Se distingue del resto porque el editor lo
// explica de otra forma (no es un error del script, es el sandbox).
export class LslBudgetError extends LslRuntimeError {
  constructor(steps) {
    super("presupuesto de instrucciones agotado (" + steps + " pasos): ¿bucle infinito?");
    this.name = "LslBudgetError";
  }
}
