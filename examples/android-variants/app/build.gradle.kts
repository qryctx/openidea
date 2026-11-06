plugins {
    id("com.android.application")
}

android {
    namespace = "dev.openide.sample"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.openide.sample"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    flavorDimensions += "edition"
    productFlavors {
        create("demo") {
            dimension = "edition"
            applicationIdSuffix = ".demo"
        }
        create("full") {
            dimension = "edition"
            applicationIdSuffix = ".full"
        }
    }
}

dependencies {
    implementation(project(":contract"))
}
