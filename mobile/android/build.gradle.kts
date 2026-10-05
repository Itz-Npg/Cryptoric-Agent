// Pinned, not floating. A plugin version that resolves to whatever is newest
// turns a green build into a coin flip on the day someone else pulls, and this
// APK is published to a release page.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
