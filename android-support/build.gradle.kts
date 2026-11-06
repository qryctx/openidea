plugins { `java-library` }

dependencies { compileOnly("com.android.tools.lint:lint-api:32.3.1") }

tasks.withType<JavaCompile>().configureEach { options.release.set(17) }

tasks.jar {
    archiveFileName.set("android-reference-index.jar")
    manifest.attributes["Lint-Registry-v2"] = "dev.openandroidstudio.index.ReferenceRegistry"
}
