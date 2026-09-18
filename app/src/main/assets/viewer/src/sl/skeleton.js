// skeleton.js -- el esqueleto del avatar de Second Life (avatar_skeleton.xml).
//
// POR QUE ESTE FICHERO ES LA BASE DE TODO LO "REAL"
// -------------------------------------------------
// En SL no hay "una malla de avatar": hay un ESQUELETO, y todo lo demas se
// cuelga de el. Los cuerpos y cabezas mesh (Maitreya, Legacy, Lelutka...), la
// ropa, el pelo, los accesorios y las animaciones hablan todos del MISMO
// esqueleto, con los mismos nombres de hueso. Una malla mesh trae sus pesos de
// piel ("este vertice va un 70% con mChest y un 30% con mTorso") y una animacion
// trae rotaciones por nombre de hueso. Con el esqueleto exacto en un sitio, las
// dos cosas encajan sin traduccion.
//
// Esto no se puede inventar: los pesos de una cabeza Lelutka apuntan a mHead,
// mNeck o mFaceJaw, y una animacion de baile gira mHipLeft, mElbowRight o
// mHandMiddle1Left. Si un nombre no existe, o esta en otro orden, o el hueso
// cuelga de otro padre, la malla se deforma mal. Por eso los datos de abajo son
// un port literal, no una aproximacion.
//
// PROCEDENCIA DE LOS DATOS
// ------------------------
// SL_JOINTS y SL_COLLISION_VOLUMES son un port directo de `avatar_skeleton.xml`
// de Linden Lab (version 2.0, el fichero que define el esqueleto del avatar):
// 133 huesos y 26 volumenes de colision, mismo orden, mismos nombres, mismos
// alias, mismos grupos y las mismas transformadas locales de reposo. Es la
// definicion que usan todos los visores y todas las herramientas de terceros
// (Blender, Avastar, OpenSim...), asi que es la referencia correcta.
//
// MARCO DE COORDENADAS
// --------------------
// Los datos estan en el marco de SL (X delante, Y izquierda, Z arriba), porque
// asi vienen en el fichero y asi vienen tambien los vertices de una malla mesh.
// El visor dibuja en el marco de three.js (Y arriba) y con el avatar mirando a
// -Z (ver `avatarBody.js`). `slVecToAvatar`/`slQuatToAvatar` son el cambio de
// base, y `buildSkeleton` devuelve ya el arbol en el marco del visor.
//
// En la version 2.0 ninguna articulacion tiene rotacion de reposo (todas son
// 0,0,0) ni escala distinta de 1, de modo que la pose de reposo es una simple
// suma de traslaciones. `runSkeletonSelfTest` lo comprueba: si algun dia se
// actualiza el port a una version con rotaciones, salta.

"use strict";

export const SL_SKELETON_VERSION = "2.0";

// Una articulacion: nombre, padre (null en la raiz), traslacion local en metros,
// rotacion local en radianes (euler XYZ), escala, alias historicos y grupo.
// `end` es la punta del hueso relativa a su propio pivote: sirve para dibujarlo.
export const SL_JOINTS = [
  { name: "mPelvis", parent: null, pos: [0,0,1.067015], rot: [0,0,0], scale: [1,1,1], end: [0,0,0.084], aliases: "hip avatar_mPelvis", group: "Torso" },
  { name: "mSpine1", parent: "mPelvis", pos: [0,0,0.084073], rot: [0,0,0], scale: [1,1,1], end: [0,0,-0.084], aliases: "avatar_mSpine1", group: "Spine", support: "extended" },
  { name: "mSpine2", parent: "mSpine1", pos: [0,0,-0.084073], rot: [0,0,0], scale: [1,1,1], end: [0,0,0.084], aliases: "avatar_mSpine2", group: "Spine", support: "extended" },
  { name: "mTorso", parent: "mSpine2", pos: [0,0,0.084073], rot: [0,0,0], scale: [1,1,1], end: [-0.015,0,0.205], aliases: "abdomen avatar_mTorso", group: "Torso" },
  { name: "mSpine3", parent: "mTorso", pos: [-0.015368,0,0.204877], rot: [0,0,0], scale: [1,1,1], end: [0.015,0,-0.205], aliases: "avatar_mSpine3", group: "Spine", support: "extended" },
  { name: "mSpine4", parent: "mSpine3", pos: [0.015368,0,-0.204877], rot: [0,0,0], scale: [1,1,1], end: [-0.015,0,0.205], aliases: "avatar_mSpine4", group: "Spine", support: "extended" },
  { name: "mChest", parent: "mSpine4", pos: [-0.015368,0,0.204877], rot: [0,0,0], scale: [1,1,1], end: [-0.01,0,0.25], aliases: "chest avatar_mChest", group: "Torso" },
  { name: "mNeck", parent: "mChest", pos: [-0.009507,0,0.251108], rot: [0,0,0], scale: [1,1,1], end: [0,0,0.077], aliases: "neck avatar_mNeck", group: "Torso" },
  { name: "mHead", parent: "mNeck", pos: [0,0,0.07563], rot: [0,0,0], scale: [1,1,1], end: [0,0,0.079], aliases: "head avatar_mHead", group: "Torso" },
  { name: "mSkull", parent: "mHead", pos: [0,0,0.079], rot: [0,0,0], scale: [1,1,1], end: [0,0,0.033], aliases: "figureHair avatar_mSkull", group: "Extra" },
  { name: "mEyeRight", parent: "mHead", pos: [0.098466,-0.036,0.079], rot: [0,0,0], scale: [1,1,1], end: [0.025,0,0], aliases: "avatar_mEyeRight", group: "Extra" },
  { name: "mEyeLeft", parent: "mHead", pos: [0.098461,0.036,0.079], rot: [0,0,0], scale: [1,1,1], end: [0.025,0,0], aliases: "avatar_mEyeLeft", group: "Extra" },
  { name: "mFaceRoot", parent: "mHead", pos: [0.025,0,0.045], rot: [0,0,0], scale: [1,1,1], end: [0.02,0,0], aliases: "avatar_mFaceRoot", group: "Face", support: "extended" },
  { name: "mFaceEyeAltRight", parent: "mFaceRoot", pos: [0.073466,-0.036,0.03393], rot: [0,0,0], scale: [1,1,1], end: [0.025,0,0], aliases: "avatar_mFaceEyeAltRight", group: "Face", support: "extended" },
  { name: "mFaceEyeAltLeft", parent: "mFaceRoot", pos: [0.073461,0.036,0.03393], rot: [0,0,0], scale: [1,1,1], end: [0.025,0,0], aliases: "avatar_mFaceEyeAltLeft", group: "Face", support: "extended" },
  { name: "mFaceForeheadLeft", parent: "mFaceRoot", pos: [0.061,0.035,0.083], rot: [0,0,0], scale: [1,1,1], end: [0.024,0.004,0.018], aliases: "avatar_mFaceForeheadLeft", group: "Face", support: "extended" },
  { name: "mFaceForeheadRight", parent: "mFaceRoot", pos: [0.061,-0.035,0.083], rot: [0,0,0], scale: [1,1,1], end: [0.024,-0.004,0.018], aliases: "avatar_mFaceForeheadRight", group: "Face", support: "extended" },
  { name: "mFaceEyebrowOuterLeft", parent: "mFaceRoot", pos: [0.064,0.051,0.048], rot: [0,0,0], scale: [1,1,1], end: [0.023,0.013,0], aliases: "avatar_mFaceEyebrowOuterLeft", group: "Eyes", support: "extended" },
  { name: "mFaceEyebrowCenterLeft", parent: "mFaceRoot", pos: [0.07,0.043,0.056], rot: [0,0,0], scale: [1,1,1], end: [0.027,0,0], aliases: "avatar_mFaceEyebrowCenterLeft", group: "Eyes", support: "extended" },
  { name: "mFaceEyebrowInnerLeft", parent: "mFaceRoot", pos: [0.075,0.022,0.051], rot: [0,0,0], scale: [1,1,1], end: [0.026,0,0], aliases: "avatar_mFaceEyebrowInnerLeft", group: "Eyes", support: "extended" },
  { name: "mFaceEyebrowOuterRight", parent: "mFaceRoot", pos: [0.064,-0.051,0.048], rot: [0,0,0], scale: [1,1,1], end: [0.023,-0.013,0], aliases: "avatar_mFaceEyebrowOuterRight", group: "Eyes", support: "extended" },
  { name: "mFaceEyebrowCenterRight", parent: "mFaceRoot", pos: [0.07,-0.043,0.056], rot: [0,0,0], scale: [1,1,1], end: [0.027,0,0], aliases: "avatar_mFaceEyebrowCenterRight", group: "Eyes", support: "extended" },
  { name: "mFaceEyebrowInnerRight", parent: "mFaceRoot", pos: [0.075,-0.022,0.051], rot: [0,0,0], scale: [1,1,1], end: [0.026,0,0], aliases: "avatar_mFaceEyebrowInnerRight", group: "Eyes", support: "extended" },
  { name: "mFaceEyeLidUpperLeft", parent: "mFaceRoot", pos: [0.073,0.036,0.034], rot: [0,0,0], scale: [1,1,1], end: [0.027,0,0.005], aliases: "avatar_mFaceEyeLidUpperLeft", group: "Eyes", support: "extended" },
  { name: "mFaceEyeLidLowerLeft", parent: "mFaceRoot", pos: [0.073,0.036,0.034], rot: [0,0,0], scale: [1,1,1], end: [0.024,0,-0.007], aliases: "avatar_mFaceEyeLidLowerLeft", group: "Eyes", support: "extended" },
  { name: "mFaceEyeLidUpperRight", parent: "mFaceRoot", pos: [0.073,-0.036,0.034], rot: [0,0,0], scale: [1,1,1], end: [0.027,0,0.005], aliases: "avatar_mFaceEyeLidUpperRight", group: "Eyes", support: "extended" },
  { name: "mFaceEyeLidLowerRight", parent: "mFaceRoot", pos: [0.073,-0.036,0.034], rot: [0,0,0], scale: [1,1,1], end: [0.024,0,-0.007], aliases: "avatar_mFaceEyeLidLowerRight", group: "Eyes", support: "extended" },
  { name: "mFaceEar1Left", parent: "mFaceRoot", pos: [0,0.08,0.002], rot: [0,0,0], scale: [1,1,1], end: [-0.019,0.018,0.025], aliases: "avatar_mFaceEar1Left", group: "Ears", support: "extended" },
  { name: "mFaceEar2Left", parent: "mFaceEar1Left", pos: [-0.019,0.018,0.025], rot: [0,0,0], scale: [1,1,1], end: [0,0,0.033], aliases: "avatar_mFaceEar2Left", group: "Ears", support: "extended" },
  { name: "mFaceEar1Right", parent: "mFaceRoot", pos: [0,-0.08,0.002], rot: [0,0,0], scale: [1,1,1], end: [-0.019,-0.018,0.025], aliases: "avatar_mFaceEar1Right", group: "Ears", support: "extended" },
  { name: "mFaceEar2Right", parent: "mFaceEar1Right", pos: [-0.019,-0.018,0.025], rot: [0,0,0], scale: [1,1,1], end: [0,0,0.033], aliases: "avatar_mFaceEar2Right", group: "Ears", support: "extended" },
  { name: "mFaceNoseLeft", parent: "mFaceRoot", pos: [0.086,0.015,-0.004], rot: [0,0,0], scale: [1,1,1], end: [0.015,0.004,0], aliases: "avatar_mFaceNoseLeft", group: "Face", support: "extended" },
  { name: "mFaceNoseCenter", parent: "mFaceRoot", pos: [0.102,0,0], rot: [0,0,0], scale: [1,1,1], end: [0.025,0,0], aliases: "avatar_mFaceNoseCenter", group: "Face", support: "extended" },
  { name: "mFaceNoseRight", parent: "mFaceRoot", pos: [0.086,-0.015,-0.004], rot: [0,0,0], scale: [1,1,1], end: [0.015,-0.004,0], aliases: "avatar_mFaceNoseRight", group: "Face", support: "extended" },
  { name: "mFaceCheekLowerLeft", parent: "mFaceRoot", pos: [0.05,0.034,-0.031], rot: [0,0,0], scale: [1,1,1], end: [0.013,0.03,0], aliases: "avatar_mFaceCheekLowerLeft", group: "Face", support: "extended" },
  { name: "mFaceCheekUpperLeft", parent: "mFaceRoot", pos: [0.07,0.034,-0.005], rot: [0,0,0], scale: [1,1,1], end: [0.022,0.015,0], aliases: "avatar_mFaceCheekUpperLeft", group: "Face", support: "extended" },
  { name: "mFaceCheekLowerRight", parent: "mFaceRoot", pos: [0.05,-0.034,-0.031], rot: [0,0,0], scale: [1,1,1], end: [0.013,-0.03,0], aliases: "avatar_mFaceCheekLowerRight", group: "Face", support: "extended" },
  { name: "mFaceCheekUpperRight", parent: "mFaceRoot", pos: [0.07,-0.034,-0.005], rot: [0,0,0], scale: [1,1,1], end: [0.022,-0.015,0], aliases: "avatar_mFaceCheekUpperRight", group: "Face", support: "extended" },
  { name: "mFaceJaw", parent: "mFaceRoot", pos: [-0.001,0,-0.015], rot: [0,0,0], scale: [1,1,1], end: [0.059,0,-0.039], aliases: "avatar_mFaceJaw", group: "Mouth", support: "extended" },
  { name: "mFaceChin", parent: "mFaceJaw", pos: [0.074,0,-0.054], rot: [0,0,0], scale: [1,1,1], end: [0.021,0,-0.018], aliases: "avatar_mFaceChin", group: "Mouth", support: "extended" },
  { name: "mFaceTeethLower", parent: "mFaceJaw", pos: [0.021,0,-0.039], rot: [0,0,0], scale: [1,1,1], end: [0.035,0,0], aliases: "avatar_mFaceTeethLower", group: "Mouth", support: "extended" },
  { name: "mFaceLipLowerLeft", parent: "mFaceTeethLower", pos: [0.045,0,0], rot: [0,0,0], scale: [1,1,1], end: [0.034,0.017,0.005], aliases: "avatar_mFaceLipLowerLeft", group: "Lips", support: "extended" },
  { name: "mFaceLipLowerRight", parent: "mFaceTeethLower", pos: [0.045,0,0], rot: [0,0,0], scale: [1,1,1], end: [0.034,-0.017,0.005], aliases: "avatar_mFaceLipLowerRight", group: "Lips", support: "extended" },
  { name: "mFaceLipLowerCenter", parent: "mFaceTeethLower", pos: [0.045,0,0], rot: [0,0,0], scale: [1,1,1], end: [0.04,0,0.002], aliases: "avatar_mFaceLipLowerCenter", group: "Lips", support: "extended" },
  { name: "mFaceTongueBase", parent: "mFaceTeethLower", pos: [0.039,0,0.005], rot: [0,0,0], scale: [1,1,1], end: [0.022,0,0.007], aliases: "avatar_mFaceTongueBase", group: "Mouth", support: "extended" },
  { name: "mFaceTongueTip", parent: "mFaceTongueBase", pos: [0.022,0,0.007], rot: [0,0,0], scale: [1,1,1], end: [0.01,0,0], aliases: "avatar_mFaceTongueTip", group: "Mouth", support: "extended" },
  { name: "mFaceJawShaper", parent: "mFaceRoot", pos: [0,0,0], rot: [0,0,0], scale: [1,1,1], end: [-0.017,0,0], aliases: "avatar_mFaceJawShaper", group: "Face", support: "extended" },
  { name: "mFaceForeheadCenter", parent: "mFaceRoot", pos: [0.069,0,0.065], rot: [0,0,0], scale: [1,1,1], end: [0.036,0,0], aliases: "avatar_mFaceForeheadCenter", group: "Face", support: "extended" },
  { name: "mFaceNoseBase", parent: "mFaceRoot", pos: [0.094,0,-0.016], rot: [0,0,0], scale: [1,1,1], end: [0.014,0,0], aliases: "avatar_mFaceNoseBase", group: "Nose", support: "extended" },
  { name: "mFaceTeethUpper", parent: "mFaceRoot", pos: [0.02,0,-0.03], rot: [0,0,0], scale: [1,1,1], end: [0.035,0,0], aliases: "avatar_mFaceTeethUpper", group: "Mouth", support: "extended" },
  { name: "mFaceLipUpperLeft", parent: "mFaceTeethUpper", pos: [0.045,0,-0.003], rot: [0,0,0], scale: [1,1,1], end: [0.041,0.015,0], aliases: "avatar_mFaceLipUpperLeft", group: "Lips", support: "extended" },
  { name: "mFaceLipUpperRight", parent: "mFaceTeethUpper", pos: [0.045,0,-0.003], rot: [0,0,0], scale: [1,1,1], end: [0.041,-0.015,0], aliases: "avatar_mFaceLipUpperRight", group: "Lips", support: "extended" },
  { name: "mFaceLipCornerLeft", parent: "mFaceTeethUpper", pos: [0.028,-0.019,-0.01], rot: [0,0,0], scale: [1,1,1], end: [0.045,0.051,0], aliases: "avatar_mFaceLipCornerLeft", group: "Lips", support: "extended" },
  { name: "mFaceLipCornerRight", parent: "mFaceTeethUpper", pos: [0.028,0.019,-0.01], rot: [0,0,0], scale: [1,1,1], end: [0.045,-0.051,0], aliases: "avatar_mFaceLipCornerRight", group: "Lips", support: "extended" },
  { name: "mFaceLipUpperCenter", parent: "mFaceTeethUpper", pos: [0.045,0,-0.003], rot: [0,0,0], scale: [1,1,1], end: [0.043,0,0.002], aliases: "avatar_mFaceLipUpperCenter", group: "Lips", support: "extended" },
  { name: "mFaceEyecornerInnerLeft", parent: "mFaceRoot", pos: [0.075,0.017,0.032], rot: [0,0,0], scale: [1,1,1], end: [0.016,0,0], aliases: "avatar_mFaceEyecornerInnerLeft", group: "Face", support: "extended" },
  { name: "mFaceEyecornerInnerRight", parent: "mFaceRoot", pos: [0.075,-0.017,0.032], rot: [0,0,0], scale: [1,1,1], end: [0.016,0,0], aliases: "avatar_mFaceEyecornerInnerRight", group: "Face", support: "extended" },
  { name: "mFaceNoseBridge", parent: "mFaceRoot", pos: [0.091,0,0.02], rot: [0,0,0], scale: [1,1,1], end: [0.015,0,0.008], aliases: "avatar_mFaceNoseBridge", group: "Nose", support: "extended" },
  { name: "mCollarLeft", parent: "mChest", pos: [-0.020927,0.084665,0.165396], rot: [0,0,0], scale: [1,1,1], end: [0,0.079,0], aliases: "lCollar avatar_mCollarLeft", group: "Arms" },
  { name: "mShoulderLeft", parent: "mCollarLeft", pos: [0,0.079,0], rot: [0,0,0], scale: [1,1,1], end: [0,0.247,0], aliases: "lShldr avatar_mShoulderLeft", group: "Arms" },
  { name: "mElbowLeft", parent: "mShoulderLeft", pos: [0,0.248,0], rot: [0,0,0], scale: [1,1,1], end: [0,0.205,0], aliases: "lForeArm avatar_mElbowLeft", group: "Arms" },
  { name: "mWristLeft", parent: "mElbowLeft", pos: [0,0.204846,0], rot: [0,0,0], scale: [1,1,1], end: [0,0.06,0], aliases: "lHand avatar_mWristLeft", group: "Arms" },
  { name: "mHandMiddle1Left", parent: "mWristLeft", pos: [0.013,0.101,0.015], rot: [0,0,0], scale: [1,1,1], end: [-0.001,0.04,-0.006], aliases: "avatar_mHandMiddle1Left", group: "Hand", support: "extended" },
  { name: "mHandMiddle2Left", parent: "mHandMiddle1Left", pos: [-0.001,0.04,-0.006], rot: [0,0,0], scale: [1,1,1], end: [-0.001,0.049,-0.008], aliases: "avatar_mHandMiddle2Left", group: "Hand", support: "extended" },
  { name: "mHandMiddle3Left", parent: "mHandMiddle2Left", pos: [-0.001,0.049,-0.008], rot: [0,0,0], scale: [1,1,1], end: [-0.002,0.033,-0.006], aliases: "avatar_mHandMiddle3Left", group: "Hand", support: "extended" },
  { name: "mHandIndex1Left", parent: "mWristLeft", pos: [0.038,0.097,0.015], rot: [0,0,0], scale: [1,1,1], end: [0.017,0.036,-0.006], aliases: "avatar_mHandIndex1Left", group: "Hand", support: "extended" },
  { name: "mHandIndex2Left", parent: "mHandIndex1Left", pos: [0.017,0.036,-0.006], rot: [0,0,0], scale: [1,1,1], end: [0.014,0.032,-0.006], aliases: "avatar_mHandIndex2Left", group: "Hand", support: "extended" },
  { name: "mHandIndex3Left", parent: "mHandIndex2Left", pos: [0.014,0.032,-0.006], rot: [0,0,0], scale: [1,1,1], end: [0.011,0.025,-0.004], aliases: "avatar_mHandIndex3Left", group: "Hand", support: "extended" },
  { name: "mHandRing1Left", parent: "mWristLeft", pos: [-0.01,0.099,0.009], rot: [0,0,0], scale: [1,1,1], end: [-0.013,0.038,-0.008], aliases: "avatar_mHandRing1Left", group: "Hand", support: "extended" },
  { name: "mHandRing2Left", parent: "mHandRing1Left", pos: [-0.013,0.038,-0.008], rot: [0,0,0], scale: [1,1,1], end: [-0.013,0.04,-0.009], aliases: "avatar_mHandRing2Left", group: "Hand", support: "extended" },
  { name: "mHandRing3Left", parent: "mHandRing2Left", pos: [-0.013,0.04,-0.009], rot: [0,0,0], scale: [1,1,1], end: [-0.01,0.028,-0.006], aliases: "avatar_mHandRing3Left", group: "Hand", support: "extended" },
  { name: "mHandPinky1Left", parent: "mWristLeft", pos: [-0.031,0.095,0.003], rot: [0,0,0], scale: [1,1,1], end: [-0.024,0.025,-0.006], aliases: "avatar_mHandPinky1Left", group: "Hand", support: "extended" },
  { name: "mHandPinky2Left", parent: "mHandPinky1Left", pos: [-0.024,0.025,-0.006], rot: [0,0,0], scale: [1,1,1], end: [-0.015,0.018,-0.004], aliases: "avatar_mHandPinky2Left", group: "Hand", support: "extended" },
  { name: "mHandPinky3Left", parent: "mHandPinky2Left", pos: [-0.015,0.018,-0.004], rot: [0,0,0], scale: [1,1,1], end: [-0.013,0.016,-0.004], aliases: "avatar_mHandPinky3Left", group: "Hand", support: "extended" },
  { name: "mHandThumb1Left", parent: "mWristLeft", pos: [0.031,0.026,0.004], rot: [0,0,0], scale: [1,1,1], end: [0.028,0.032,0], aliases: "avatar_mHandThumb1Left", group: "Hand", support: "extended" },
  { name: "mHandThumb2Left", parent: "mHandThumb1Left", pos: [0.028,0.032,-0.001], rot: [0,0,0], scale: [1,1,1], end: [0.023,0.031,0], aliases: "avatar_mHandThumb2Left", group: "Hand", support: "extended" },
  { name: "mHandThumb3Left", parent: "mHandThumb2Left", pos: [0.023,0.031,-0.001], rot: [0,0,0], scale: [1,1,1], end: [0.015,0.025,0], aliases: "avatar_mHandThumb3Left", group: "Hand", support: "extended" },
  { name: "mCollarRight", parent: "mChest", pos: [-0.020927,-0.085,0.165396], rot: [0,0,0], scale: [1,1,1], end: [0,-0.079,0], aliases: "rCollar avatar_mCollarRight", group: "Arms" },
  { name: "mShoulderRight", parent: "mCollarRight", pos: [0,-0.079418,0], rot: [0,0,0], scale: [1,1,1], end: [0,-0.247,0], aliases: "rShldr avatar_mShoulderRight", group: "Arms" },
  { name: "mElbowRight", parent: "mShoulderRight", pos: [0,-0.248,0], rot: [0,0,0], scale: [1,1,1], end: [0,-0.205,0], aliases: "rForeArm avatar_mElbowRight", group: "Arms" },
  { name: "mWristRight", parent: "mElbowRight", pos: [0,-0.205,0], rot: [0,0,0], scale: [1,1,1], end: [0,-0.06,0], aliases: "rHand avatar_mWristRight", group: "Arms" },
  { name: "mHandMiddle1Right", parent: "mWristRight", pos: [0.013,-0.101,0.015], rot: [0,0,0], scale: [1,1,1], end: [-0.001,-0.04,-0.006], aliases: "avatar_mHandMiddle1Right", group: "Hand", support: "extended" },
  { name: "mHandMiddle2Right", parent: "mHandMiddle1Right", pos: [-0.001,-0.04,-0.006], rot: [0,0,0], scale: [1,1,1], end: [-0.001,-0.049,-0.008], aliases: "avatar_mHandMiddle2Right", group: "Hand", support: "extended" },
  { name: "mHandMiddle3Right", parent: "mHandMiddle2Right", pos: [-0.001,-0.049,-0.008], rot: [0,0,0], scale: [1,1,1], end: [-0.002,-0.033,-0.006], aliases: "avatar_mHandMiddle3Right", group: "Hand", support: "extended" },
  { name: "mHandIndex1Right", parent: "mWristRight", pos: [0.038,-0.097,0.015], rot: [0,0,0], scale: [1,1,1], end: [0.017,-0.036,-0.006], aliases: "avatar_mHandIndex1Right", group: "Hand", support: "extended" },
  { name: "mHandIndex2Right", parent: "mHandIndex1Right", pos: [0.017,-0.036,-0.006], rot: [0,0,0], scale: [1,1,1], end: [0.014,-0.032,-0.006], aliases: "avatar_mHandIndex2Right", group: "Hand", support: "extended" },
  { name: "mHandIndex3Right", parent: "mHandIndex2Right", pos: [0.014,-0.032,-0.006], rot: [0,0,0], scale: [1,1,1], end: [0.011,-0.025,-0.004], aliases: "avatar_mHandIndex3Right", group: "Hand", support: "extended" },
  { name: "mHandRing1Right", parent: "mWristRight", pos: [-0.01,-0.099,0.009], rot: [0,0,0], scale: [1,1,1], end: [-0.013,-0.038,-0.008], aliases: "avatar_mHandRing1Right", group: "Hand", support: "extended" },
  { name: "mHandRing2Right", parent: "mHandRing1Right", pos: [-0.013,-0.038,-0.008], rot: [0,0,0], scale: [1,1,1], end: [-0.013,-0.04,-0.009], aliases: "avatar_mHandRing2Right", group: "Hand", support: "extended" },
  { name: "mHandRing3Right", parent: "mHandRing2Right", pos: [-0.013,-0.04,-0.009], rot: [0,0,0], scale: [1,1,1], end: [-0.01,-0.028,-0.006], aliases: "avatar_mHandRing3Right", group: "Hand", support: "extended" },
  { name: "mHandPinky1Right", parent: "mWristRight", pos: [-0.031,-0.095,0.003], rot: [0,0,0], scale: [1,1,1], end: [-0.024,-0.025,-0.006], aliases: "avatar_mHandPinky1Right", group: "Hand", support: "extended" },
  { name: "mHandPinky2Right", parent: "mHandPinky1Right", pos: [-0.024,-0.025,-0.006], rot: [0,0,0], scale: [1,1,1], end: [-0.015,-0.018,-0.004], aliases: "avatar_mHandPinky2Right", group: "Hand", support: "extended" },
  { name: "mHandPinky3Right", parent: "mHandPinky2Right", pos: [-0.015,-0.018,-0.004], rot: [0,0,0], scale: [1,1,1], end: [-0.013,-0.016,-0.004], aliases: "avatar_mHandPinky3Right", group: "Hand", support: "extended" },
  { name: "mHandThumb1Right", parent: "mWristRight", pos: [0.031,-0.026,0.004], rot: [0,0,0], scale: [1,1,1], end: [0.028,-0.032,0], aliases: "avatar_mHandThumb1Right", group: "Hand", support: "extended" },
  { name: "mHandThumb2Right", parent: "mHandThumb1Right", pos: [0.028,-0.032,-0.001], rot: [0,0,0], scale: [1,1,1], end: [0.023,-0.031,0], aliases: "avatar_mHandThumb2Right", group: "Hand", support: "extended" },
  { name: "mHandThumb3Right", parent: "mHandThumb2Right", pos: [0.023,-0.031,-0.001], rot: [0,0,0], scale: [1,1,1], end: [0.015,-0.025,0], aliases: "avatar_mHandThumb3Right", group: "Hand", support: "extended" },
  { name: "mWingsRoot", parent: "mChest", pos: [-0.014,0,0], rot: [0,0,0], scale: [1,1,1], end: [-0.061,0,0], aliases: "avatar_mWingsRoot", group: "Wing", support: "extended" },
  { name: "mWing1Left", parent: "mWingsRoot", pos: [-0.099,0.105,0.181], rot: [0,0,0], scale: [1,1,1], end: [-0.168,0.169,0.067], aliases: "avatar_mWing1Left", group: "Wing", support: "extended" },
  { name: "mWing2Left", parent: "mWing1Left", pos: [-0.168,0.169,0.067], rot: [0,0,0], scale: [1,1,1], end: [-0.181,0.183,0], aliases: "avatar_mWing2Left", group: "Wing", support: "extended" },
  { name: "mWing3Left", parent: "mWing2Left", pos: [-0.181,0.183,0], rot: [0,0,0], scale: [1,1,1], end: [-0.171,0.173,0], aliases: "avatar_mWing3Left", group: "Wing", support: "extended" },
  { name: "mWing4Left", parent: "mWing3Left", pos: [-0.171,0.173,0], rot: [0,0,0], scale: [1,1,1], end: [-0.146,0.132,0], aliases: "avatar_mWing4Left", group: "Wing", support: "extended" },
  { name: "mWing4FanLeft", parent: "mWing3Left", pos: [-0.171,0.173,0], rot: [0,0,0], scale: [1,1,1], end: [-0.068,0.062,-0.159], aliases: "avatar_mWing4FanLeft", group: "Wing", support: "extended" },
  { name: "mWing1Right", parent: "mWingsRoot", pos: [-0.099,-0.105,0.181], rot: [0,0,0], scale: [1,1,1], end: [-0.168,-0.169,0.067], aliases: "avatar_mWing1Right", group: "Wing", support: "extended" },
  { name: "mWing2Right", parent: "mWing1Right", pos: [-0.168,-0.169,0.067], rot: [0,0,0], scale: [1,1,1], end: [-0.181,-0.183,0], aliases: "avatar_mWing2Right", group: "Wing", support: "extended" },
  { name: "mWing3Right", parent: "mWing2Right", pos: [-0.181,-0.183,0], rot: [0,0,0], scale: [1,1,1], end: [-0.171,-0.173,0], aliases: "avatar_mWing3Right", group: "Wing", support: "extended" },
  { name: "mWing4Right", parent: "mWing3Right", pos: [-0.171,-0.173,0], rot: [0,0,0], scale: [1,1,1], end: [-0.146,-0.132,0], aliases: "avatar_mWing4Right", group: "Wing", support: "extended" },
  { name: "mWing4FanRight", parent: "mWing3Right", pos: [-0.171,-0.173,0], rot: [0,0,0], scale: [1,1,1], end: [-0.068,-0.062,-0.159], aliases: "avatar_mWing4FanRight", group: "Wing", support: "extended" },
  { name: "mHipRight", parent: "mPelvis", pos: [0.03362,-0.128806,-0.041086], rot: [0,0,0], scale: [1,1,1], end: [-0.001,0.049,-0.491], aliases: "rThigh avatar_mHipRight", group: "Legs" },
  { name: "mKneeRight", parent: "mHipRight", pos: [-0.00078,0.048635,-0.490922], rot: [0,0,0], scale: [1,1,1], end: [-0.029,0,-0.469], aliases: "rShin avatar_mKneeRight", group: "Legs" },
  { name: "mAnkleRight", parent: "mKneeRight", pos: [-0.028869,0,-0.468494], rot: [0,0,0], scale: [1,1,1], end: [0.112,0,-0.061], aliases: "rFoot avatar_mAnkleRight", group: "Legs" },
  { name: "mFootRight", parent: "mAnkleRight", pos: [0.111956,0,-0.060637], rot: [0,0,0], scale: [1,1,1], end: [0.105,-0.01,0], aliases: "avatar_mFootRight", group: "Extra" },
  { name: "mToeRight", parent: "mFootRight", pos: [0.105399,-0.010408,-0.000104], rot: [0,0,0], scale: [1,1,1], end: [0.02,0,0], aliases: "avatar_mToeRight", group: "Extra" },
  { name: "mHipLeft", parent: "mPelvis", pos: [0.033757,0.126765,-0.040998], rot: [0,0,0], scale: [1,1,1], end: [-0.001,-0.046,-0.491], aliases: "lThigh avatar_mHipLeft", group: "Legs" },
  { name: "mKneeLeft", parent: "mHipLeft", pos: [-0.000887,-0.045568,-0.491053], rot: [0,0,0], scale: [1,1,1], end: [-0.029,0.001,-0.469], aliases: "lShin avatar_mKneeLeft", group: "Legs" },
  { name: "mAnkleLeft", parent: "mKneeLeft", pos: [-0.028887,0.001378,-0.468449], rot: [0,0,0], scale: [1,1,1], end: [0.112,0,-0.061], aliases: "lFoot avatar_mAnkleLeft", group: "Legs" },
  { name: "mFootLeft", parent: "mAnkleLeft", pos: [0.111956,0,-0.06062], rot: [0,0,0], scale: [1,1,1], end: [0.105,0.008,0.001], aliases: "avatar_mFootLeft", group: "Extra" },
  { name: "mToeLeft", parent: "mFootLeft", pos: [0.105387,0.00827,0.000871], rot: [0,0,0], scale: [1,1,1], end: [0.02,0,0], aliases: "avatar_mToeLeft", group: "Extra" },
  { name: "mTail1", parent: "mPelvis", pos: [-0.116,0,0.047], rot: [0,0,0], scale: [1,1,1], end: [-0.197,0,0], aliases: "avatar_mTail1", group: "Tail", support: "extended" },
  { name: "mTail2", parent: "mTail1", pos: [-0.197,0,0], rot: [0,0,0], scale: [1,1,1], end: [-0.168,0,0], aliases: "avatar_mTail2", group: "Tail", support: "extended" },
  { name: "mTail3", parent: "mTail2", pos: [-0.168,0,0], rot: [0,0,0], scale: [1,1,1], end: [-0.142,0,0], aliases: "avatar_mTail3", group: "Tail", support: "extended" },
  { name: "mTail4", parent: "mTail3", pos: [-0.142,0,0], rot: [0,0,0], scale: [1,1,1], end: [-0.112,0,0], aliases: "avatar_mTail4", group: "Tail", support: "extended" },
  { name: "mTail5", parent: "mTail4", pos: [-0.112,0,0], rot: [0,0,0], scale: [1,1,1], end: [-0.094,0,0], aliases: "avatar_mTail5", group: "Tail", support: "extended" },
  { name: "mTail6", parent: "mTail5", pos: [-0.094,0,0], rot: [0,0,0], scale: [1,1,1], end: [-0.089,0,0], aliases: "avatar_mTail6", group: "Tail", support: "extended" },
  { name: "mGroin", parent: "mPelvis", pos: [0.064,0,-0.097], rot: [0,0,0], scale: [1,1,1], end: [0.004,0,-0.066], aliases: "avatar_mGroin", group: "Groin", support: "extended" },
  { name: "mHindLimbsRoot", parent: "mPelvis", pos: [-0.2,0,0.084], rot: [0,0,0], scale: [1,1,1], end: [-0.204,0,0], aliases: "avatar_mHindLimbsRoot", group: "Limb", support: "extended" },
  { name: "mHindLimb1Left", parent: "mHindLimbsRoot", pos: [-0.204,0.129,-0.125], rot: [0,0,0], scale: [1,1,1], end: [0.002,-0.046,-0.491], aliases: "avatar_mHindLimb1Left", group: "Limb", support: "extended" },
  { name: "mHindLimb2Left", parent: "mHindLimb1Left", pos: [0.002,-0.046,-0.491], rot: [0,0,0], scale: [1,1,1], end: [-0.03,-0.003,-0.468], aliases: "avatar_mHindLimb2Left", group: "Limb", support: "extended" },
  { name: "mHindLimb3Left", parent: "mHindLimb2Left", pos: [-0.03,-0.003,-0.468], rot: [0,0,0], scale: [1,1,1], end: [0.112,0,-0.061], aliases: "avatar_mHindLimb3Left", group: "Limb", support: "extended" },
  { name: "mHindLimb4Left", parent: "mHindLimb3Left", pos: [0.112,0,-0.061], rot: [0,0,0], scale: [1,1,1], end: [0.105,0.008,0], aliases: "avatar_mHindLimb4Left", group: "Limb", support: "extended" },
  { name: "mHindLimb1Right", parent: "mHindLimbsRoot", pos: [-0.204,-0.129,-0.125], rot: [0,0,0], scale: [1,1,1], end: [0.002,0.046,-0.491], aliases: "avatar_mHindLimb1Right", group: "Limb", support: "extended" },
  { name: "mHindLimb2Right", parent: "mHindLimb1Right", pos: [0.002,0.046,-0.491], rot: [0,0,0], scale: [1,1,1], end: [-0.03,0.003,-0.468], aliases: "avatar_mHindLimb2Right", group: "Limb", support: "extended" },
  { name: "mHindLimb3Right", parent: "mHindLimb2Right", pos: [-0.03,0.003,-0.468], rot: [0,0,0], scale: [1,1,1], end: [0.112,0,-0.061], aliases: "avatar_mHindLimb3Right", group: "Limb", support: "extended" },
  { name: "mHindLimb4Right", parent: "mHindLimb3Right", pos: [0.112,0,-0.061], rot: [0,0,0], scale: [1,1,1], end: [0.105,-0.008,0], aliases: "avatar_mHindLimb4Right", group: "Limb", support: "extended" },
]

// Volumenes de colision del avatar (las capsulas con las que SL resuelve los
// choques). No hacen falta para dibujar, pero son la referencia de las
// dimensiones del cuerpo y de la fisica. Las rotaciones van en radianes.
export const SL_COLLISION_VOLUMES = [
  { name: "PELVIS", bone: "mPelvis", pos: [-0.01,0,-0.02], rot: [0,0.13962634,0], scale: [0.12,0.16,0.17] },
  { name: "BUTT", bone: "mPelvis", pos: [-0.06,0,-0.1], rot: [0,0,0], scale: [0.1,0.1,0.1] },
  { name: "BELLY", bone: "mTorso", pos: [0.028,0,0.04], rot: [0,0.13962634,0], scale: [0.09,0.13,0.15] },
  { name: "LEFT_HANDLE", bone: "mTorso", pos: [0,0.1,0.058], rot: [0,0,0], scale: [0.05,0.05,0.05] },
  { name: "RIGHT_HANDLE", bone: "mTorso", pos: [0,-0.1,0.058], rot: [0,0,0], scale: [0.05,0.05,0.05] },
  { name: "LOWER_BACK", bone: "mTorso", pos: [0,0,0.023], rot: [0,0,0], scale: [0.09,0.13,0.15] },
  { name: "CHEST", bone: "mChest", pos: [0.028,0,0.07], rot: [0,-0.17453293,0], scale: [0.11,0.15,0.2] },
  { name: "LEFT_PEC", bone: "mChest", pos: [0.119,0.082,0.042], rot: [0,0.07487462,0], scale: [0.05,0.05,0.05] },
  { name: "RIGHT_PEC", bone: "mChest", pos: [0.119,-0.082,0.042], rot: [0,0.07487462,0], scale: [0.05,0.05,0.05] },
  { name: "UPPER_BACK", bone: "mChest", pos: [0,0,0.017], rot: [0,0,0], scale: [0.09,0.13,0.15] },
  { name: "NECK", bone: "mNeck", pos: [0,0,0.02], rot: [0,0,0], scale: [0.05,0.06,0.08] },
  { name: "HEAD", bone: "mHead", pos: [0.02,0,0.07], rot: [0,0,0], scale: [0.11,0.09,0.12] },
  { name: "L_CLAVICLE", bone: "mCollarLeft", pos: [0.02,0,0.02], rot: [0,0,0], scale: [0.07,0.14,0.05] },
  { name: "L_UPPER_ARM", bone: "mShoulderLeft", pos: [0,0.12,0.01], rot: [-0.08726646,0,0], scale: [0.05,0.17,0.05] },
  { name: "L_LOWER_ARM", bone: "mElbowLeft", pos: [0,0.1,0], rot: [-0.05235988,0,0], scale: [0.04,0.14,0.04] },
  { name: "L_HAND", bone: "mWristLeft", pos: [0.01,0.05,0], rot: [-0.05235988,0,-0.17453293], scale: [0.05,0.08,0.03] },
  { name: "R_CLAVICLE", bone: "mCollarRight", pos: [0.02,0,0.02], rot: [0,0,0], scale: [0.07,0.14,0.05] },
  { name: "R_UPPER_ARM", bone: "mShoulderRight", pos: [0,-0.12,0.01], rot: [0.08726646,0,0], scale: [0.05,0.17,0.05] },
  { name: "R_LOWER_ARM", bone: "mElbowRight", pos: [0,-0.1,0], rot: [0.05235988,0,0], scale: [0.04,0.14,0.04] },
  { name: "R_HAND", bone: "mWristRight", pos: [0.01,-0.05,0], rot: [0.05235988,0,0.17453293], scale: [0.05,0.08,0.03] },
  { name: "R_UPPER_LEG", bone: "mHipRight", pos: [-0.02,0.05,-0.22], rot: [0,0,0], scale: [0.09,0.09,0.32] },
  { name: "R_LOWER_LEG", bone: "mKneeRight", pos: [-0.02,0,-0.2], rot: [0,0,0], scale: [0.06,0.06,0.25] },
  { name: "R_FOOT", bone: "mAnkleRight", pos: [0.077,0,-0.041], rot: [0,0.17453293,0], scale: [0.13,0.05,0.05] },
  { name: "L_UPPER_LEG", bone: "mHipLeft", pos: [-0.02,-0.05,-0.22], rot: [0,0,0], scale: [0.09,0.09,0.32] },
  { name: "L_LOWER_LEG", bone: "mKneeLeft", pos: [-0.02,0,-0.2], rot: [0,0,0], scale: [0.06,0.06,0.25] },
  { name: "L_FOOT", bone: "mAnkleLeft", pos: [0.077,0,-0.041], rot: [0,0.17453293,0], scale: [0.13,0.05,0.05] },
]

// --- indices y consultas ----------------------------------------------------

export const SL_JOINT_INDEX = new Map(SL_JOINTS.map((j, i) => [j.name, i]));

// Nombre o alias -> indice. Los alias ("hip", "avatar_mTorso", "abdomen"...) son
// los que usan las herramientas viejas y algunos exportadores de BVH.
export const SL_JOINT_BY_ALIAS = (() => {
  const m = new Map();
  SL_JOINTS.forEach((j, i) => {
    m.set(j.name, i);
    for (const a of j.aliases.split(/\s+/)) if (a) m.set(a, i);
  });
  return m;
})();

// Devuelve el indice, o -1 si el nombre no es de este esqueleto. Las mallas y
// animaciones de SL usan a veces alias, asi que se aceptan los dos.
export function jointIndex(nameOrAlias) {
  if (nameOrAlias === undefined || nameOrAlias === null) return -1;
  const i = SL_JOINT_BY_ALIAS.get(String(nameOrAlias));
  return i === undefined ? -1 : i;
}

export function jointAt(i) { return SL_JOINTS[i] || null; }

// Los huesos "extended" son los que SL puede quitar en los niveles de detalle
// bajos (dedos, cara, alas, cola). Un visor que quiera dibujar barato puede
// saltarselos, pero una malla que los use necesita todos: por eso se pueden
// consultar en vez de estar escondidos.
export function isExtendedJoint(i) {
  const j = SL_JOINTS[i];
  return !!j && j.support === "extended";
}

// --- cambio de marco --------------------------------------------------------
//
// SL: X delante, Y izquierda, Z arriba.  Visor: Y arriba, el avatar mira a -Z.
//
//   SL +X (delante) -> visor (0, 0, -1)   [el avatar mira a -Z]
//   SL +Y (izquierda) -> visor (-1, 0, 0) [la izquierda del avatar es -X]
//   SL +Z (arriba)   -> visor (0, 1, 0)
//
// Es un cambio de base rigido (una rotacion), asi que a un cuaternion le
// corresponde q' = qF * q * qF^-1, con qF la rotacion de la base.
export const Q_FRAME = [-0.5, 0.5, 0.5, 0.5];

export function slVecToAvatar(v) { return [-v[1], v[2], -v[0]]; }
export function avatarVecToSl(v) { return [-v[2], -v[0], v[1]]; }

function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function quatConj(q) { return [-q[0], -q[1], -q[2], q[3]]; }

export function slQuatToAvatar(q) {
  return quatMul(quatMul(Q_FRAME, q), quatConj(Q_FRAME));
}

// El cambio inverso (visor -> SL). Lo usa `avatarPose.js` para autorar poses en
// el marco del visor (Y arriba, mira a -Z) y entregárselas a `anim.js`, que las
// espera en el marco de SL.
export function avatarQuatToSl(q) {
  return quatMul(quatMul(quatConj(Q_FRAME), q), Q_FRAME);
}

// Rotacion local de reposo de una articulacion, en el marco del visor. En la
// version 2.0 del esqueleto todas son la identidad, asi que el caso rapido
// evita la multiplicacion.
export function slJointRotToAvatar(rot) {
  if (!rot || (rot[0] === 0 && rot[1] === 0 && rot[2] === 0)) return [0, 0, 0, 1];
  const hx = rot[0] * 0.5, hy = rot[1] * 0.5, hz = rot[2] * 0.5;
  const cx = Math.cos(hx), sx = Math.sin(hx);
  const cy = Math.cos(hy), sy = Math.sin(hy);
  const cz = Math.cos(hz), sz = Math.sin(hz);
  const q = [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
  return slQuatToAvatar(q);
}

// --- pose de reposo ---------------------------------------------------------

// Posicion de cada articulacion en reposo, en el marco del visor (metros, pies
// en y=0). Es la suma de las traslaciones locales porque, como se ha dicho, en
// la version 2.0 no hay rotaciones de reposo: el autotest lo comprueba.
let _restWorld = null;
export function restWorldPositions() {
  if (_restWorld) return _restWorld;
  const out = new Float64Array(SL_JOINTS.length * 3);
  for (let i = 0; i < SL_JOINTS.length; i++) {
    const j = SL_JOINTS[i];
    const p = slVecToAvatar(j.pos);
    if (j.parent) {
      const pi = SL_JOINT_INDEX.get(j.parent);
      out[i * 3] = out[pi * 3] + p[0];
      out[i * 3 + 1] = out[pi * 3 + 1] + p[1];
      out[i * 3 + 2] = out[pi * 3 + 2] + p[2];
    } else {
      out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2];
    }
  }
  _restWorld = out;
  return out;
}

// --- el arbol de three.js ---------------------------------------------------

// Construye la jerarquia de huesos. Devuelve:
//
//   root    contenedor con los pies en y=0 y el avatar mirando a -Z. Es lo que
//           se cuelga del grupo del avatar; mover `root` mueve el esqueleto.
//   bones   los 133 `THREE.Bone`, en el MISMO orden que SL_JOINTS (un peso de
//           piel que diga "hueso 42" se refiere a ese indice).
//   byName  nombre de hueso -> hueso.
//
// Las mallas se atan despues con `SkinnedMesh.bind(esqueleto, matrizDeEnlace)`.
export function buildSkeleton(THREE, opts = {}) {
  const root = new THREE.Group();
  root.name = opts.name || "esqueletoSL";
  const bones = SL_JOINTS.map((j, i) => {
    const b = new THREE.Bone();
    b.name = j.name;
    const p = slVecToAvatar(j.pos);
    b.position.set(p[0], p[1], p[2]);
    b.scale.set(j.scale[0], j.scale[1], j.scale[2]);
    const q = slJointRotToAvatar(j.rot);
    b.quaternion.set(q[0], q[1], q[2], q[3]);
    b.userData.jointIndex = i;
    b.userData.group = j.group;
    return b;
  });
  SL_JOINTS.forEach((j, i) => {
    const parent = j.parent ? bones[SL_JOINT_INDEX.get(j.parent)] : null;
    (parent || root).add(bones[i]);
  });
  const byName = new Map(bones.map((b) => [b.name, b]));
  return { root, bones, byName };
}

// --- autotest ---------------------------------------------------------------

// Comprueba los datos y la construccion del arbol sin necesidad de red ni de
// una malla: cuenta de huesos, jerarquia (un solo raiz, sin ciclos, todos los
// padres existen), el cambio de marco, la forma del esqueleto (pies abajo,
// cabeza arriba, izquierda y derecha simetricas) y que three.js reproduce
// exactamente la pose de reposo. Si `THREE` no se pasa, se salta esa ultima
// parte (todo lo demas son datos puros).
export function runSkeletonSelfTest(THREE) {
  const checks = [];
  const ok = (name, cond, extra) => checks.push({ name, pass: !!cond, extra });

  ok("133 articulaciones", SL_JOINTS.length === 133);
  ok("26 volumenes de colision", SL_COLLISION_VOLUMES.length === 26);

  const names = SL_JOINTS.map((j) => j.name);
  ok("nombres unicos", new Set(names).size === names.length);
  ok("un solo raiz (mPelvis)", SL_JOINTS.filter((j) => !j.parent).length === 1 && SL_JOINTS[0].name === "mPelvis");
  ok("todos los padres existen", SL_JOINTS.every((j) => !j.parent || SL_JOINT_INDEX.has(j.parent)));

  // Sin ciclos: subiendo por los padres desde cada hueso se llega al raiz.
  let acyclic = true;
  for (let i = 0; i < SL_JOINTS.length; i++) {
    let n = 0, cur = SL_JOINTS[i];
    while (cur && cur.parent) { cur = SL_JOINTS[SL_JOINT_INDEX.get(cur.parent)]; if (++n > SL_JOINTS.length) { acyclic = false; break; } }
  }
  ok("sin ciclos", acyclic);

  ok("sin rotaciones de reposo", SL_JOINTS.every((j) => j.rot.every((v) => v === 0)));
  ok("sin escalas de reposo", SL_JOINTS.every((j) => j.scale.every((v) => v === 1)));
  ok("todos los volumenes cuelgan de un hueso", SL_COLLISION_VOLUMES.every((c) => SL_JOINT_INDEX.has(c.bone)));

  // Consultas por nombre y por alias.
  ok("indice por nombre", jointIndex("mHandMiddle1Left") === SL_JOINT_INDEX.get("mHandMiddle1Left"));
  ok("indice por alias", jointIndex("hip") === SL_JOINT_INDEX.get("mPelvis") && jointIndex("avatar_mTorso") === SL_JOINT_INDEX.get("mTorso"));
  ok("nombre desconocido -> -1", jointIndex("mCodoIzquierdo") === -1);
  ok("alias unicos y registrados", SL_JOINT_BY_ALIAS.get("abdomen") === SL_JOINT_INDEX.get("mTorso"));

  // Cambio de marco: los tres ejes de SL y la ida y vuelta.
  const ex = slVecToAvatar([1, 0, 0]), ey = slVecToAvatar([0, 1, 0]), ez = slVecToAvatar([0, 0, 1]);
  ok("SL +X -> -Z", ex[0] === 0 && ex[1] === 0 && ex[2] === -1);
  ok("SL +Y -> -X", ey[0] === -1 && ey[1] === 0 && ey[2] === 0);
  ok("SL +Z -> +Y", ez[0] === 0 && ez[1] === 1 && ez[2] === 0);
  const rt = avatarVecToSl(slVecToAvatar([0.3, -1.2, 2.4]));
  ok("cambio de marco invertible", Math.abs(rt[0] - 0.3) < 1e-12 && Math.abs(rt[1] + 1.2) < 1e-12 && Math.abs(rt[2] - 2.4) < 1e-12);

  // El cuaternion del cambio de base tiene que girar los ejes igual que la matriz.
  const rot = (q, v) => {
    const u = [q[0], q[1], q[2]], w = q[3];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const c1 = cross(u, v), c2 = cross(u, c1);
    return [v[0] + 2 * (w * c1[0] + c2[0]), v[1] + 2 * (w * c1[1] + c2[1]), v[2] + 2 * (w * c1[2] + c2[2])];
  };
  const qe = rot(Q_FRAME, [1, 0, 0]);
  ok("Q_FRAME gira +X a -Z", Math.abs(qe[0]) < 1e-12 && Math.abs(qe[1]) < 1e-12 && Math.abs(qe[2] + 1) < 1e-12);

  // Forma del esqueleto en reposo. Los pies en el suelo y la cabeza arriba es la
  // prueba barata de que la jerarquia y el cambio de marco estan bien.
  const W = restWorldPositions();
  const at = (name) => { const i = SL_JOINT_INDEX.get(name); return [W[i * 3], W[i * 3 + 1], W[i * 3 + 2]]; };
  const footL = at("mFootLeft"), footR = at("mFootRight");
  const head = at("mHead"), eyeL = at("mEyeLeft"), pelvis = at("mPelvis");
  const shL = at("mShoulderLeft"), shR = at("mShoulderRight");
  const handL = at("mWristLeft"), handR = at("mWristRight");
  const ankleL = at("mAnkleLeft");
  ok("pies en el suelo (y < 0.02)", Math.abs(footL[1]) < 0.02 && Math.abs(footR[1]) < 0.02, { footL, footR });
  ok("cabeza arriba", head[1] > 1.6 && head[1] < 1.8, { head });
  ok("ojos a la altura de los ojos", eyeL[1] > 1.7 && eyeL[1] < 1.82, { eyeL });
  ok("caderas sobre los pies", pelvis[1] > 0.9 && pelvis[1] < 1.2, { pelvis });
  ok("cuello por encima de las caderas", head[1] > pelvis[1] && ankleL[1] < pelvis[1]);
  ok("hombros por encima de las caderas", shL[1] > pelvis[1]);
  // El avatar mira a -Z, asi que su izquierda es -X y su derecha +X.
  ok("izquierda y derecha simetricas", Math.abs(shL[0] + shR[0]) < 0.01 && Math.abs(handL[0] + handR[0]) < 0.01 && Math.abs(shL[1] - shR[1]) < 0.01);
  ok("el hombro izquierdo esta a la izquierda (-X)", shL[0] < -0.02, { shL });
  ok("las manos cuelgan a los lados", Math.abs(handL[0]) > 0.4 && handL[1] > 1.2, { handL });

  // Y que three.js reproduzca exactamente esa pose.
  if (THREE) {
    const sk = buildSkeleton(THREE);
    ok("133 huesos en el arbol", sk.bones.length === 133);
    ok("nombres del arbol", sk.bones.every((b, i) => b.name === SL_JOINTS[i].name));
    ok("los padres del arbol coinciden", SL_JOINTS.every((j, i) => {
      const p = sk.bones[i].parent;
      return j.parent ? (p && p.name === j.parent) : (p === sk.root);
    }));
    sk.root.updateMatrixWorld(true);
    let worst = 0, worstName = "";
    const v = new THREE.Vector3();
    for (let i = 0; i < sk.bones.length; i++) {
      sk.bones[i].getWorldPosition(v);
      const d = Math.max(Math.abs(v.x - W[i * 3]), Math.abs(v.y - W[i * 3 + 1]), Math.abs(v.z - W[i * 3 + 2]));
      if (d > worst) { worst = d; worstName = SL_JOINTS[i].name; }
    }
    ok("three.js reproduce la pose de reposo", worst < 1e-6, { worst, worstName });
    const solo = sk.byName.get("mPelvis");
    ok("busqueda por nombre en el arbol", !!solo && solo.name === "mPelvis");
  }

  const failed = checks.filter((c) => !c.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "skeleton selftest: all " + checks.length + " checks passed"
      : "skeleton selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((c) => c.name).join(", ") + ")",
  };
}
