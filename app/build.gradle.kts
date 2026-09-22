import java.io.File
import java.security.KeyStore

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---------------------------------------------------------------------------
// UNA sola clave de firma, fija, para todas las compilaciones.
//
// Por qué existe esto: hasta la ronda 13 cada compilación del CI se firmaba con
// la clave de depuración que Android Studio/AGP *genera al vuelo* en
// ~/.android/debug.keystore. En un servidor nuevo (GitHub Actions) ese fichero no
// existe, así que cada ejecución creaba una clave **distinta**: el APK de hoy no
// podía actualizar al de ayer y Android lo rechazaba ("Aplicación no instalada").
// Resultado: el móvil seguía ejecutando el visor viejo por muchas veces que se
// recompilara, y cada arreglo parecía no cambiar nada.
//
// La clave vive en `app/visor-sl.p12` y es PÚBLICA a propósito (el repositorio lo
// es): no protege ningún secreto, sólo hace que todas las compilaciones sean
// *la misma aplicación*. La contraseña es igual de pública; se puede cambiar por
// la propiedad de Gradle `-Pvisor.storePass=…` si algún día hace falta.
// ---------------------------------------------------------------------------
val visorStorePass = (findProperty("visor.storePass") as String?) ?: "visor-sl-3f9c1a7d42b8"
val visorStoreFile = file("visor-sl.p12")

/** El alias que Java da a la clave privada dentro del almacén (no se adivina). */
fun privateKeyAliasOf(file: File): String? {
    if (!file.exists()) {
        logger.warn("[VisorSL] falta ${file.name}: se firmará con la clave de depuración del CI")
        return null
    }
    return try {
        val ks = KeyStore.getInstance("PKCS12")
        file.inputStream().use { ks.load(it, visorStorePass.toCharArray()) }
        val aliases = ks.aliases()
        while (aliases.hasMoreElements()) {
            val alias = aliases.nextElement()
            if (ks.isKeyEntry(alias)) return alias
        }
        logger.warn("[VisorSL] ${file.name} no tiene ninguna clave privada")
        null
    } catch (t: Throwable) {
        logger.warn("[VisorSL] no se pudo leer ${file.name} (${t.message}): se firmará con la clave de depuración del CI")
        null
    }
}

val visorAlias = privateKeyAliasOf(visorStoreFile)

android {
    namespace = "net.visorsl.viewer"
    compileSdk = 34

    defaultConfig {
        applicationId = "net.visorsl.viewer"
        minSdk = 24
        targetSdk = 34
        versionCode = 9
        versionName = "1.7.1"
    }

    signingConfigs {
        create("visor") {
            storeFile = visorStoreFile
            storePassword = visorStorePass
            keyAlias = visorAlias ?: "visorsl"
            keyPassword = visorStorePass
            storeType = "PKCS12"
        }
    }

    buildTypes {
        // SIN sufijo `.debug` en el identificador: las dos variantes son LA MISMA
        // aplicación, así que instalar cualquiera de las dos actualiza la misma
        // copia del móvil. Con el sufijo quedaban dos iconos idénticos ("Visor
        // SL") y abrir el viejo parecía exactamente "el APK nuevo no cambió nada".
        debug {
            isMinifyEnabled = false
            signingConfig = if (visorAlias != null) signingConfigs.getByName("visor") else signingConfigs.getByName("debug")
        }
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (visorAlias != null) signingConfigs.getByName("visor") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
}
