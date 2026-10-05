// Repository location for every module. `mobile/android` is a self-contained
// Gradle build: it does not share a root project with the Electron app, because
// the two have nothing in common but a relay protocol and a protocol that
// diverges into a root build is a protocol that diverges silently.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "CryptoricCompanion"
include(":app")
