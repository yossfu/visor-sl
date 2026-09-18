// Constantes de LSL que ve un script. Los valores numericos son los de SL
// (donde se conocen) porque son opacos para el script, pero asi el codigo se
// puede comparar con la wiki sin sorpresas.

import { Vec, Rot } from "./values.js";

export function buildConstants() {
  const c = Object.create(null);
  const def = (name, value) => { c[name] = value; };

  def("TRUE", 1);
  def("FALSE", 0);
  def("NULL_KEY", "00000000-0000-0000-0000-000000000000");
  def("PI", Math.PI);
  def("TWO_PI", Math.PI * 2);
  def("PI_BY_TWO", Math.PI / 2);
  def("DEG_TO_RAD", Math.PI / 180);
  def("RAD_TO_DEG", 180 / Math.PI);
  def("ZERO_VECTOR", new Vec(0, 0, 0));
  def("ZERO_ROTATION", new Rot(0, 0, 0, 1));

  // Canales y destinos de link
  def("PUBLIC_CHANNEL", 0);
  def("DEBUG_CHANNEL", 2147483647);
  def("LINK_ROOT", 1);
  def("LINK_SET", -1);
  def("LINK_THIS", -4);
  def("LINK_ALL_OTHERS", -2);
  def("LINK_ALL_CHILDREN", -3);

  // Tipos (llGetListEntryType / llGetType)
  def("TYPE_INTEGER", 1);
  def("TYPE_FLOAT", 2);
  def("TYPE_STRING", 3);
  def("TYPE_KEY", 4);
  def("TYPE_VECTOR", 5);
  def("TYPE_ROTATION", 6);
  def("TYPE_INVALID", 0);

  // Reglas de llSetPrimitiveParams (las que soporta este visor)
  def("PRIM_POSITION", 6);
  def("PRIM_SIZE", 7);
  def("PRIM_ROTATION", 8);
  def("PRIM_POS_LOCAL", 33);
  def("PRIM_ROT_LOCAL", 29);
  def("PRIM_TEXTURE", 17);
  def("PRIM_COLOR", 18);
  def("PRIM_FULLBRIGHT", 20);
  def("PRIM_GLOW", 25);
  def("PRIM_TEXT", 26);
  def("PRIM_NAME", 27);
  def("PRIM_DESC", 28);
  def("PRIM_MATERIAL", 2);
  def("PRIM_PHANTOM", 5);
  def("PRIM_PHYSICS", 3);
  def("PRIM_LINK_TARGET", 34);
  def("PRIM_ALPHA_MODE", 38);
  def("ALL_SIDES", -1);

  // Materiales de SL (el visor los usa para la rugosidad/metalicidad)
  def("PRIM_MATERIAL_STONE", 0);
  def("PRIM_MATERIAL_METAL", 1);
  def("PRIM_MATERIAL_GLASS", 2);
  def("PRIM_MATERIAL_WOOD", 3);
  def("PRIM_MATERIAL_FLESH", 4);
  def("PRIM_MATERIAL_PLASTIC", 5);
  def("PRIM_MATERIAL_RUBBER", 6);
  def("PRIM_MATERIAL_LIGHT", 7);

  // Banderas de sensores/cambios
  def("AGENT", 1);
  def("ACTIVE", 2);
  def("PASSIVE", 4);
  def("SCRIPTED", 8);
  def("CHANGED_INVENTORY", 1);
  def("CHANGED_COLOR", 2);
  def("CHANGED_SHAPE", 4);
  def("CHANGED_SCALE", 8);
  def("CHANGED_TEXTURE", 16);
  def("CHANGED_LINK", 32);
  def("CHANGED_REGION", 64);
  def("CHANGED_TELEPORT", 128);

  // Eventos de teclado (llTakeControls): presentes para que los scripts que los
  // declaran compilen, aunque el visor no los dispare.
  def("CONTROL_FWD", 1);
  def("CONTROL_BACK", 2);
  def("CONTROL_LEFT", 4);
  def("CONTROL_RIGHT", 8);
  def("CONTROL_UP", 16);
  def("CONTROL_DOWN", 32);
  def("CONTROL_ML_LBUTTON", 64);

  // Alias en minusculas que la gente usa mucho (no son de LSL, pero ayudan)
  c.true = 1;
  c.false = 0;
  c.null_key = c.NULL_KEY;
  c.pi = c.PI;

  return c;
}
