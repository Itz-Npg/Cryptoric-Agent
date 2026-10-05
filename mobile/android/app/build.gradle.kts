plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.itznpg.cryptoric.companion"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.itznpg.cryptoric.companion"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.4"
    }

    // The APK published from CI is the *debug* build, and that is a deliberate
    // choice rather than a shortcut: Gradle generates the debug keystore on
    // first use, so producing a signed, installable APK needs no keystore, no
    // password and no keystore secret in this repository. A release APK signed
    // with a real key needs one, and that key is the maintainer's to create.
    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = false
            // No signingConfig: an unsigned release APK would be published as
            // though it were installable, and it is not.
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // `org.json` is stubbed inside android.jar and throws "not mocked" in a JVM
    // test, so the real implementation comes from Maven for the test source
    // set only. The app itself uses the platform one.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
