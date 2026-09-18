plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.visor.sl"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.visor.sl"
        minSdk = 24
        targetSdk = 34
        versionCode = 4
        versionName = "0.1.3"
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // Unico peso externo: el servidor WebSocket local del retransmisor interno.
    implementation("org.java-websocket:Java-WebSocket:1.5.7")
}
