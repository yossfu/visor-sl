// FrameCodec.kt -- el protocolo de tramas del retransmisor, en Kotlin.
//
// Es EXACTAMENTE el formato de src/sl/relay.js + src/sl/bin.js: una trama es
// [u8 tipo][cuerpo], todo little-endian. Los cuerpos con campos variables van
// como JSON con la longitud (u32) delante. Por eso el visor JS no necesita
// cambiar ni una linea: su relay.js habla esto mismo.
//
// Este fichero solo tiene el codec. El nucleo que habla LLUDP con el simulador
// de Second Life es la Fase 2 (ver src/ANDROID.md y src/VIEWER-REAL.md).

package org.visor.sl

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets

object Frame {
    const val PROTOCOL = 1

    // navegador -> retransmisor
    const val C_HELLO = 0x01
    const val C_LOGIN = 0x02
    const val C_CHAT = 0x03
    const val C_MOVE = 0x04
    const val C_INTERACT = 0x05
    const val C_TELEPORT = 0x06
    const val C_REQUEST = 0x07
    const val C_PING = 0x08
    const val C_LOGOUT = 0x09
    const val C_OBJECT_EDIT = 0x0a
    const val C_PARCEL_EDIT = 0x0b
    const val C_INVENTORY = 0x0c
    const val C_GROUP_IM = 0x0d

    // retransmisor -> navegador
    const val S_WELCOME = 0x81
    const val S_STATE = 0x82
    const val S_ERROR = 0x83
    const val S_TERRAIN = 0x84
    const val S_OBJECT = 0x85
    const val S_OBJECT_UPDATE = 0x86
    const val S_OBJECT_REMOVE = 0x87
    const val S_AVATAR = 0x88
    const val S_AVATAR_UPDATE = 0x89
    const val S_AVATAR_REMOVE = 0x8a
    const val S_CHAT = 0x8b
    const val S_ASSET = 0x8c
    const val S_PARCEL = 0x8f
    const val S_PONG = 0x90
    const val S_STATS = 0x91
    const val S_INVENTORY = 0x92
    const val S_CAPS = 0x93
    const val S_OBJECTS_BEGIN = 0x94
    const val S_OBJECTS_END = 0x95
    const val S_REGION_INFO = 0x96

    // fases (S.STATE)
    const val PHASE_IDLE = 0
    const val PHASE_HANDSHAKE = 1
    const val PHASE_LOGIN_REQUEST = 2
    const val PHASE_ENTERING = 3
    const val PHASE_READY = 4
    const val PHASE_TELEPORT = 5
    const val PHASE_DISCONNECTED = 6

    // tipos de recurso (C.REQUEST / S.ASSET)
    const val RES_TEXTURE = 0
    const val RES_MESH = 1
    const val RES_ANIM = 2
    const val RES_SOUND = 3
    const val RES_NOTECARD = 4
    const val RES_INVENTORY = 5

    // clases dentro de S.ASSET
    const val ASSET_J2C = 0
    const val ASSET_JPEG = 1
    const val ASSET_PNG = 2
    const val ASSET_RGBA8 = 3
    const val ASSET_LLMESH = 4
    const val ASSET_TEXT = 5
    const val ASSET_OGG = 6

    fun name(type: Int): String = when (type) {
        C_HELLO -> "C.HELLO"; C_LOGIN -> "C.LOGIN"; C_CHAT -> "C.CHAT"; C_MOVE -> "C.MOVE"
        C_INTERACT -> "C.INTERACT"; C_TELEPORT -> "C.TELEPORT"; C_REQUEST -> "C.REQUEST"
        C_PING -> "C.PING"; C_LOGOUT -> "C.LOGOUT"; C_OBJECT_EDIT -> "C.OBJECT_EDIT"
        C_PARCEL_EDIT -> "C.PARCEL_EDIT"; C_INVENTORY -> "C.INVENTORY"; C_GROUP_IM -> "C.GROUP_IM"
        S_WELCOME -> "S.WELCOME"; S_STATE -> "S.STATE"; S_ERROR -> "S.ERROR"; S_TERRAIN -> "S.TERRAIN"
        S_OBJECT -> "S.OBJECT"; S_OBJECT_UPDATE -> "S.OBJECT_UPDATE"; S_OBJECT_REMOVE -> "S.OBJECT_REMOVE"
        S_AVATAR -> "S.AVATAR"; S_AVATAR_UPDATE -> "S.AVATAR_UPDATE"; S_AVATAR_REMOVE -> "S.AVATAR_REMOVE"
        S_CHAT -> "S.CHAT"; S_ASSET -> "S.ASSET"; S_PARCEL -> "S.PARCEL"; S_PONG -> "S.PONG"
        S_STATS -> "S.STATS"; S_INVENTORY -> "S.INVENTORY"; S_CAPS -> "S.CAPS"
        S_OBJECTS_BEGIN -> "S.OBJECTS_BEGIN"; S_OBJECTS_END -> "S.OBJECTS_END"
        S_REGION_INFO -> "S.REGION_INFO"
        else -> "0x" + Integer.toHexString(type)
    }
}

// Escritor de tramas (el `Writer` de src/sl/bin.js).
class Writer(capacity: Int = 64) {
    private val out = ByteArrayOutputStream(capacity)
    private val scratch = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)

    fun u8(v: Int): Writer { out.write(v and 0xff); return this }
    fun i16(v: Int): Writer { scratch.clear(); scratch.putShort(v.toShort()); out.write(scratch.array(), 0, 2); return this }
    fun u16(v: Int): Writer { scratch.clear(); scratch.putShort((v and 0xffff).toShort()); out.write(scratch.array(), 0, 2); return this }
    fun u32(v: Long): Writer { scratch.clear(); scratch.putInt(v.toInt()); out.write(scratch.array(), 0, 4); return this }
    fun f32(v: Float): Writer { scratch.clear(); scratch.putFloat(v); out.write(scratch.array(), 0, 4); return this }
    fun f64(v: Double): Writer { scratch.clear(); scratch.putDouble(v); out.write(scratch.array(), 0, 8); return this }
    fun bytes(b: ByteArray): Writer { out.write(b); return this }

    // Cadena corta: longitud en un byte (nombres, chat).
    fun str(s: String): Writer {
        val b = s.toByteArray(StandardCharsets.UTF_8)
        val n = if (b.size > 255) 255 else b.size
        u8(n)
        out.write(b, 0, n)
        return this
    }

    // Cadena larga: longitud en cuatro bytes (JSON, textos largos).
    fun str32(s: String): Writer {
        val b = s.toByteArray(StandardCharsets.UTF_8)
        u32(b.size.toLong())
        out.write(b)
        return this
    }

    fun json(s: String): Writer = str32(s)

    fun build(): ByteArray = out.toByteArray()
}

// Lector de tramas (el `Reader` de src/sl/bin.js).
class Reader private constructor(private val bb: ByteBuffer) {
    fun u8(): Int = bb.get().toInt() and 0xff
    fun i16(): Int = bb.short.toInt()
    fun u32(): Long = bb.int.toLong() and 0xffffffffL
    fun f32(): Float = bb.float
    fun f64(): Double = bb.double
    fun bytes(n: Int): ByteArray { val b = ByteArray(n); bb.get(b); return b }
    fun str(): String { val n = u8(); val b = ByteArray(n); bb.get(b); return String(b, StandardCharsets.UTF_8) }
    fun str32(): String { val n = u32().toInt(); val b = ByteArray(n); bb.get(b); return String(b, StandardCharsets.UTF_8) }

    val remaining: Int get() = bb.remaining()

    companion object {
        fun of(data: ByteArray): Reader = Reader(ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN))
    }
}

// Atajo: una trama completa de un solo byte de tipo.
fun frame(type: Int): Writer = Writer().u8(type)
