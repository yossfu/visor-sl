// Scripts de ejemplo que trae el editor. Estan escritos en el subconjunto que
// entiende este visor, pero se pueden pegar scripts de SL casi tal cual: lo que
// no esta soportado avisa por la consola en vez de romper.

export const EXAMPLE_SCRIPTS = [
  {
    key: "hola",
    label: "Hola, mundo",
    note: "state_entry, touch_start y el contador de toques clásico de SL.",
    source: `// El primer script de todo el mundo en SL.
integer toques = 0;

default
{
    state_entry()
    {
        llSetText("Tócame", <1, 1, 1>, 1.0);
        llSay(0, "Hola desde el mini-LSL del visor.");
    }

    touch_start(integer num_detected)
    {
        toques = toques + 1;
        llSay(0, "Me has tocado " + (string)toques + " veces.");
        llSetText("Toques: " + (string)toques, <0.6, 1.0, 0.7>, 1.0);
        if (toques >= 5)
        {
            state celebracion;
        }
    }
}

state celebracion
{
    state_entry()
    {
        llSay(0, "¡Cinco toques! Me paso a fiesta.");
        llSetText("¡FIESTA!", <1, 0.4, 0.9>, 1.0);
        llSetTimerEvent(0.4);
    }

    timer()
    {
        rotation giro = llGetRot();
        llSetRot(giro * llEuler2Rot(<0, 0, 20> * DEG_TO_RAD));
    }

    touch_start(integer num_detected)
    {
        state default;
    }
}`,
  },
  {
    key: "semaforo",
    label: "Semáforo",
    note: "Estados + timer: cambia el color de las caras por turnos.",
    source: `// Un semáforo: tres estados y un timer. Se pueden cambiar los colores
// con llSetLinkPrimitiveParamsFast, igual que en SL.
float duracion = 3.0;

default
{
    state_entry()
    {
        state rojo;
    }
}

state rojo
{
    state_entry()
    {
        llSetLinkPrimitiveParamsFast(LINK_THIS, [PRIM_COLOR, ALL_SIDES, <1, 0.06, 0.06>, 1.0]);
        llSetText("ROJO", <1, 0.3, 0.3>, 1.0);
        llSetTimerEvent(duracion);
    }
    timer() { state verde; }
}

state verde
{
    state_entry()
    {
        llSetLinkPrimitiveParamsFast(LINK_THIS, [PRIM_COLOR, ALL_SIDES, <0.1, 1, 0.35>, 1.0]);
        llSetText("VERDE", <0.4, 1, 0.5>, 1.0);
        llSetTimerEvent(duracion);
    }
    timer() { state ambar; }
}

state ambar
{
    state_entry()
    {
        llSetLinkPrimitiveParamsFast(LINK_THIS, [PRIM_COLOR, ALL_SIDES, <1, 0.75, 0.1>, 1.0]);
        llSetText("ÁMBAR", <1, 0.85, 0.4>, 1.0);
        llSetTimerEvent(duracion * 0.6);
    }
    timer() { state rojo; }
}`,
  },
  {
    key: "omega",
    label: "Giro continuo",
    note: "llTargetOmega: gira sin timer, como el \"spin\" de SL.",
    source: `// llTargetOmega no usa timer: el visor aplica el giro frame a frame (igual
// que el visor de SL, que no manda nada al servidor). Toca el prim para
// invertir el sentido, o escribe "para" en el chat para pararlo.
float velocidad = 1.5;

default
{
    state_entry()
    {
        llSetText("Giro continuo", <0.7, 1, 0.8>, 1.0);
        llTargetOmega(<0, 0, 1>, velocidad, 1.0);
        llListen(0, "", NULL_KEY, "");
    }

    touch_start(integer num_detected)
    {
        velocidad = -velocidad;
        llTargetOmega(<0, 0, 1>, velocidad, 1.0);
        llSay(0, "Sentido invertido.");
    }

    listen(integer channel, string name, key id, string message)
    {
        if (id == llGetKey()) return;
        string m = llToLower(message);
        if (m == "para" || m == "stop")
        {
            llTargetOmega(<0, 0, 1>, 0.0, 0.0);
            llSay(0, "Giro parado.");
        }
        else if (m == "gira" || m == "spin")
        {
            llTargetOmega(<0, 0, 1>, velocidad, 1.0);
            llSay(0, "Girando a " + (string)velocidad + " rad/s.");
        }
    }
}`,
  },
  {
    key: "girar",
    label: "Girar y flotar",
    note: "Timer rápido, llGetPos/llSetPos y rotación continua.",
    source: `// Gira sobre sí mismo y flota arriba y abajo. Sirve para ver el coste de
// mover un prim desde un script (60 veces por segundo como mucho).
float alto = 0.0;
integer subiendo = 1;
float base = 0.0;

default
{
    state_entry()
    {
        vector p = llGetPos();
        base = p.z;
        llSetTimerEvent(0.05);
    }

    timer()
    {
        llSetRot(llGetRot() * llEuler2Rot(<0, 0, 2> * DEG_TO_RAD));
        if (subiendo) alto = alto + 0.02;
        else alto = alto - 0.02;
        if (alto > 0.6) subiendo = 0;
        if (alto < 0.0) subiendo = 1;
        llSetPos(<llGetPos().x, llGetPos().y, base + alto>);
    }

    touch_start(integer num_detected)
    {
        llSetTimerEvent(0.0);
        llSay(0, "Me paro. Tócame otra vez para seguir.");
    }

    touch_end(integer num_detected)
    {
        llSetTimerEvent(0.05);
    }
}`,
  },
  {
    key: "chat",
    label: "Escucha y responde",
    note: "llListen + chat local: escribe en el chat y el prim contesta.",
    source: `// Escucha el canal 0 y responde a unas cuantas palabras. Escribe en el
// chat del visor (abajo a la izquierda) para probarlo.
default
{
    state_entry()
    {
        llListen(0, "", NULL_KEY, "");
        llSetText("Háblame por el chat", <0.8, 0.9, 1>, 1.0);
        llSay(0, "Dime 'hola', 'salta', 'color' o 'hora'.");
    }

    listen(integer channel, string name, key id, string message)
    {
        string m = llToLower(message);
        if (llSubStringIndex(m, "hola") >= 0)
        {
            llSay(0, "¡Hola, " + name + "!");
        }
        else if (llSubStringIndex(m, "salta") >= 0)
        {
            vector p = llGetPos();
            llSetPos(<p.x, p.y, p.z + 2>);
            llSay(0, "¡Boing!");
        }
        else if (llSubStringIndex(m, "color") >= 0)
        {
            vector c = <llFrand(1), llFrand(1), llFrand(1)>;
            llSetLinkPrimitiveParamsFast(LINK_THIS, [PRIM_COLOR, ALL_SIDES, c, 1.0]);
            llSay(0, "Color nuevo: " + (string)c);
        }
        else if (llSubStringIndex(m, "hora") >= 0)
        {
            float h = llGetWallclock() / 3600.0;
            llSay(0, "Son las " + (string)llFloor(h) + " horas del servidor.");
        }
    }
}`,
  },
  {
    key: "puerta",
    label: "Puerta corredera",
    note: "Con estados y timer: se abre al tocarla y se cierra sola.",
    source: `// Puerta: sube al tocarla, espera cinco segundos y baja.
vector cerrada;
vector abierta;

default
{
    state_entry()
    {
        cerrada = llGetPos();
        abierta = <cerrada.x, cerrada.y, cerrada.z + 3>;
        llSetText("Puerta (tócame)", <0.7, 1, 0.8>, 1.0);
    }

    touch_start(integer num_detected)
    {
        state abierta;
    }
}

state abierta
{
    state_entry()
    {
        llSetPos(abierta);
        llSetText("Abierta", <1, 0.9, 0.5>, 1.0);
        llSetTimerEvent(5.0);
    }

    timer()
    {
        state default;
    }

    touch_start(integer num_detected)
    {
        llSetTimerEvent(5.0);   // se queda abierta cinco segundos más
    }
}`,
  },
  {
    key: "sensor",
    label: "Sensor de cercanía",
    note: "llSensor + llDetectedKey: saluda cuando te acercas (¡anda con WASD!).",
    source: `// Sensor: cada segundo mira si hay alguien cerca y saluda.
// El sensor necesita el radio y las banderas de tipo, como en SL.
default
{
    state_entry()
    {
        llSetText("Vigilo la zona", <1, 0.8, 0.4>, 1.0);
        llSetTimerEvent(1.0);
    }

    timer()
    {
        llSensor("", NULL_KEY, AGENT, 8.0, PI);
    }

    sensor(integer num_detected)
    {
        integer i = 0;
        while (i < num_detected)
        {
            if (llDetectedType(i) == AGENT)
            {
                vector p = llDetectedPos(i);
                float d = llVecDist(p, llGetPos());
                llSay(0, "Hola, " + llDetectedName(i) + ". Estás a " + (string)llRound(d) + " metros.");
            }
            i = i + 1;
        }
    }

    no_sensor()
    {
        // Sólo se dispara si no hay nadie: se deja sin usar a propósito.
    }
}`,
  },
  {
    key: "ondas",
    label: "Ondas de color",
    note: "Listas, bucles y llSetLinkPrimitiveParamsFast: colores por turnos.",
    source: `// Recorre una lista de colores pintando todas las caras. Un clásico para
// ver cómo se combinan listas, bucles y el cambio de parámetros.
list paleta = [
    <1.0, 0.25, 0.25>,
    <1.0, 0.65, 0.15>,
    <0.95, 0.95, 0.2>,
    <0.3, 0.9, 0.4>,
    <0.25, 0.6, 1.0>,
    <0.7, 0.35, 1.0>
];
integer i = 0;

default
{
    state_entry()
    {
        llSetText("Ondas de color", <1, 1, 1>, 1.0);
        llSetTimerEvent(0.35);
    }

    timer()
    {
        vector c = llList2Vector(paleta, i);
        llSetLinkPrimitiveParamsFast(LINK_THIS, [PRIM_COLOR, ALL_SIDES, c, 1.0, PRIM_GLOW, ALL_SIDES, 0.35]);
        i = i + 1;
        if (i >= llGetListLength(paleta))
        {
            i = 0;
        }
    }

    touch_start(integer num_detected)
    {
        llSay(0, "La paleta tiene " + (string)llGetListLength(paleta) + " colores.");
    }
}`,
  },
];

export function defaultScript() {
  return EXAMPLE_SCRIPTS[0].source;
}
